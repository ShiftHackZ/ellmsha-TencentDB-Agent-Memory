import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createL1Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import { SceneExtractor } from "../core/scene/scene-extractor.js";
import { PersonaGenerator } from "../core/persona/persona-generator.js";
import { parseConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { LLMRunner } from "../core/types.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function setup(run: ReturnType<typeof vi.fn>) {
  const dir = mkdtempSync(join(tmpdir(), "origin-l1-")); dirs.push(dir);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const store = { isDegraded: () => false, queryL0GroupedBySessionId: async () => [{ sessionId: "session", userId: "user", agentId: "agent", messages: [{ id: "message", role: "user", content: "Synthetic project requirement: use English documentation and retain the Maple-73 setting.", timestamp: 1000, recordedAtMs: 1000 }] }] } as unknown as IMemoryStore;
  const runner = createL1Runner({ pluginDataDir: dir, cfg: parseConfig(undefined), openclawConfig: undefined, vectorStore: store, embeddingService: undefined, logger, llmRunner: { run } as unknown as LLMRunner, throwOnLlmError: true });
  const checkpoint = new CheckpointManager(dir, logger);
  return { runner, checkpoint };
}
describe("origin-model L1 failure checkpoint", () => {
  it("propagates callback failure and leaves input available for retry", async () => {
    const failure = new Error("Selected origin agent rejected generation");
    const run = vi.fn().mockRejectedValue(failure);
    const { runner, checkpoint } = setup(run);
    await expect(runner({ sessionKey: "session" })).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(checkpoint.getRunnerState(await checkpoint.read(), "session").last_l1_cursor).toBe(0);
  });
  it("still advances after a valid empty-memory result", async () => {
    const { runner, checkpoint } = setup(vi.fn().mockResolvedValue("[]"));
    const result = await runner({ sessionKey: "session" });
    expect(result.storedCount).toBe(0);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "session").last_l1_cursor).toBe(1000);
  });
});

describe("origin-model downstream failure propagation", () => {
  it.each([true, false])("L2 rethrows only when enabled (%s)", async (throwOnLlmError) => {
    const dir = mkdtempSync(join(tmpdir(), "origin-l2-")); dirs.push(dir);
    const failure = new Error("Origin callback expired");
    const run = vi.fn().mockRejectedValue(failure);
    const extractor = new SceneExtractor({ dataDir: dir, config: undefined, llmRunner: { run } as unknown as LLMRunner, throwOnLlmError });
    const request = extractor.extract([{ id: "memory", content: "Synthetic project requirement", created_at: "2026-10-09" }]);
    if (throwOnLlmError) await expect(request).rejects.toBe(failure);
    else await expect(request).resolves.toMatchObject({ success: false });
    expect(run).toHaveBeenCalledOnce();
  });
  it.each([true, false])("L3 rethrows only when enabled (%s)", async (throwOnLlmError) => {
    const dir = mkdtempSync(join(tmpdir(), "origin-l3-")); dirs.push(dir);
    const failure = new Error("Origin callback expired");
    const run = vi.fn().mockRejectedValue(failure);
    const generator = new PersonaGenerator({ dataDir: dir, config: undefined, llmRunner: { run } as unknown as LLMRunner, throwOnLlmError });
    const request = generator.generateLocalPersona("Synthetic acceptance");
    if (throwOnLlmError) await expect(request).rejects.toBe(failure);
    else await expect(request).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
