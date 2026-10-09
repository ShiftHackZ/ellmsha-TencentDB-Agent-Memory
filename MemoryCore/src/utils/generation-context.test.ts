import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStateBackend } from "../core/state/local-backend.js";
import { StatefulPipelineManager } from "./stateful-pipeline-manager.js";
import { PipelineWorker } from "../services/pipeline-worker.js";
import type { TaskPayload } from "../core/state/types.js";
const origin = (model: string) => ({ base_url: "http://localhost:9000/api/runtime/tencent/v1", model, callback_token: "synthetic-test-capability" });
const config = { everyNConversations: 1, enableWarmup: false, l1: { idleTimeoutSeconds: 60 }, l2: { delayAfterL1Seconds: 1, minIntervalSeconds: 1, maxIntervalSeconds: 60, sessionActiveWindowHours: 1 } };
const backends: LocalStateBackend[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(backends.splice(0).map((backend) => backend.destroy())); });
describe("pipeline generation context propagation", () => {
  it("retains separate model snapshots for concurrent sessions and backlog drain", async () => {
    const backend = new LocalStateBackend(); backends.push(backend);
    const manager = new StatefulPipelineManager(config, backend, "instance");
    const first = origin("first-model");
    await manager.notifyConversation("session-a", [], "instance", 1, "team", "agent", first);
    first.model = "changed-later";
    await manager.notifyConversation("session-b", [], "instance", 1, "team", "agent", origin("second-model"));
    const tasks = await backend.listQueuedTasks();
    expect(tasks.map((task) => (task.data?.llm_context as any).model)).toEqual(["first-model", "second-model"]);
    await manager.enqueueL1Drain("session-a", "instance", "team", "agent", tasks[0].data?.llm_context as any);
    expect(((await backend.listQueuedTasks())[2].data?.llm_context as any).model).toBe("first-model");
    expect((await backend.getSessionState("instance", "session-a", "team", "agent"))?.llm_context?.model).toBe("first-model");
  });
  it("preserves the first-conversation warmup threshold while saving context", async () => {
    const backend = new LocalStateBackend(); backends.push(backend);
    const manager = new StatefulPipelineManager({ ...config, everyNConversations: 5, enableWarmup: true }, backend, "instance");
    await manager.notifyConversation("new-session", [], "instance", 1, "team", "agent", origin("origin-model"));
    expect(await backend.listQueuedTasks()).toHaveLength(1);
    expect((await backend.getSessionState("instance", "new-session", "team", "agent"))?.warmup_threshold).toBe(2);
  });
  it("carries the L1 origin into the profile timer and L2→L3 cascade", async () => {
    const backend = new LocalStateBackend(); backends.push(backend);
    const worker = new PipelineWorker(backend, { executeL1: vi.fn(), executeL2: vi.fn(), executeL3: vi.fn() }, { onL1Complete: async () => {} });
    const task: TaskPayload = { id: "job-a", type: "L1", instanceId: "instance", sessionId: "session-a", teamId: "team", agentId: "agent", priority: 0, createdAt: Date.now(), data: { llm_context: origin("origin-model") } };
    (task as any)._l2ProfileScopes = ["profile-a"];
    await (worker as any).cascadeSchedule(task);
    expect((await backend.getSessionState("instance", "profile-a", "team", "agent"))?.llm_context?.model).toBe("origin-model");
    await (worker as any).cascadeSchedule({ ...task, type: "L2" });
    const [persona] = await backend.listQueuedTasks();
    expect(persona.type).toBe("L3");
    expect((persona.data?.llm_context as any).model).toBe("origin-model");
  });
  it("rejects missing origin before queueing any automatic generation", async () => {
    vi.stubEnv("AION_LLM_REQUIRE_CONTEXT", "1");
    const backend = new LocalStateBackend(); backends.push(backend);
    const manager = new StatefulPipelineManager(config, backend, "instance");
    await expect(manager.notifyConversation("session", [], "instance", 1)).rejects.toThrow("required");
    expect(await backend.listQueuedTasks()).toEqual([]);
  });
});
