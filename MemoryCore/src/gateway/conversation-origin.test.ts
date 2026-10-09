import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConversationAdd, type V2RouterDeps } from "./v2-router.js";
const context = { base_url: "http://localhost:9000/api/runtime/tencent/v1", model: "selected-model", callback_token: "synthetic-test-capability" };
function setup() {
  const insertL0Batch = vi.fn().mockResolvedValue(undefined);
  const notifyPipeline = vi.fn().mockResolvedValue(undefined);
  const deps = { getStore: () => ({ insertL0Batch }), getEmbedding: () => undefined, getStorage: () => undefined, notifyPipeline, logger: { warn: vi.fn() } } as unknown as V2RouterDeps;
  return { deps, insertL0Batch, notifyPipeline };
}
afterEach(() => vi.unstubAllEnvs());
describe("conversation generation acceptance", () => {
  it("rejects a missing model context before writing L0", async () => {
    vi.stubEnv("AION_LLM_REQUIRE_CONTEXT", "1");
    const { deps, insertL0Batch, notifyPipeline } = setup();
    const result = await handleConversationAdd({ session_id: "session", messages: [{ role: "user", content: "Synthetic durable preference" }] }, { serviceId: "instance" } as any, "request", deps);
    expect(result.code).toBe(422);
    expect(insertL0Batch).not.toHaveBeenCalled();
    expect(notifyPipeline).not.toHaveBeenCalled();
  });
  it("queues the supplied origin and returns only its model name", async () => {
    vi.stubEnv("AION_LLM_REQUIRE_CONTEXT", "1");
    const { deps, insertL0Batch, notifyPipeline } = setup();
    const result = await handleConversationAdd({ session_id: "session", llm_context: context, messages: [{ role: "user", content: "Synthetic durable preference" }] }, { serviceId: "instance" } as any, "request", deps);
    expect(result.code).toBe(0);
    expect(insertL0Batch).toHaveBeenCalledOnce();
    expect(notifyPipeline).toHaveBeenCalledWith("instance", "session", 1, undefined, undefined, context);
    expect((result.data as any).generation_model).toBe("selected-model");
    expect(JSON.stringify(result)).not.toContain(context.callback_token);
    expect(JSON.stringify(insertL0Batch.mock.calls)).not.toContain(context.callback_token);
  });
});
