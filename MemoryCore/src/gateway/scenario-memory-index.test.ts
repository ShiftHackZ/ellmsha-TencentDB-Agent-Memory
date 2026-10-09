import { describe, expect, it, vi } from "vitest";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { indexScenarioMemory, scenarioMemoryId } from "./scenario-memory-index.js";

describe("searchable scenario writes", () => {
  it("updates one owner-scoped record, retaining creation time and advancing version", async () => {
    const isolation = { teamId: "team", userId: "user", agentId: "agent" };
    const path = "bmad/project/prd.md";
    const id = scenarioMemoryId(path, isolation);
    const upsertL1 = vi.fn().mockResolvedValue(true);
    const queryL1Records = vi.fn().mockResolvedValue([{ record_id: id, created_time: "2026-01-01", version: 4 }]);
    const store = { queryL1Records, upsertL1 } as unknown as IMemoryStore;
    const vector = new Float32Array([0.1, 0.2]);
    const embedding = { embed: vi.fn().mockResolvedValue(vector) } as unknown as EmbeddingService;
    expect(await indexScenarioMemory({ store, embedding, isolation, path, content: "Updated requirements" })).toBe(id);
    expect(queryL1Records).toHaveBeenCalledWith({ ...isolation, recordIds: [id] });
    expect(upsertL1).toHaveBeenCalledWith(expect.objectContaining({
      id, content: "Updated requirements", version: 5, createdAt: "2026-01-01",
      metadata: { source_path: path }, ...isolation,
    }), vector);
    expect(scenarioMemoryId(path, { ...isolation, teamId: "other" })).not.toBe(id);
  });

  it("does not report success when the store rejects the searchable record", async () => {
    const store = { queryL1Records: vi.fn().mockResolvedValue([]), upsertL1: vi.fn().mockResolvedValue(false) } as unknown as IMemoryStore;
    await expect(indexScenarioMemory({ store, path: "knowledge/test.md", content: "Fact" })).rejects.toThrow("Memory index rejected");
  });

  it("propagates embedding failure without writing an unindexed replacement", async () => {
    const upsertL1 = vi.fn();
    const store = { queryL1Records: vi.fn().mockResolvedValue([]), upsertL1 } as unknown as IMemoryStore;
    const embedding = { embed: vi.fn().mockRejectedValue(new Error("Embedding unavailable")) } as unknown as EmbeddingService;
    await expect(indexScenarioMemory({ store, embedding, path: "knowledge/test.md", content: "Fact" })).rejects.toThrow("Embedding unavailable");
    expect(upsertL1).not.toHaveBeenCalled();
  });
});
