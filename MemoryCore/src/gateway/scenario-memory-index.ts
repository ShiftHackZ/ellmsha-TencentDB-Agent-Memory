import { createHash } from "node:crypto";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { IMemoryStore, IsolationFilter } from "../core/store/types.js";

/** Stable per-owner identity: saving the same document updates its searchable record. */
export function scenarioMemoryId(path: string, isolation?: IsolationFilter): string {
  const identity = [isolation?.teamId ?? "", isolation?.userId ?? "", isolation?.agentId ?? "", path];
  return `scenario-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 40)}`;
}

/** Persist an explicit document excerpt immediately, without an LLM extraction job. */
export async function indexScenarioMemory(options: {
  store: IMemoryStore;
  embedding?: EmbeddingService;
  isolation?: IsolationFilter;
  path: string;
  content: string;
  type?: MemoryRecord["type"];
}): Promise<string> {
  const { store, embedding, isolation, path, content } = options;
  const id = scenarioMemoryId(path, isolation);
  const existing = (await store.queryL1Records({
    teamId: isolation?.teamId, userId: isolation?.userId, agentId: isolation?.agentId, recordIds: [id],
  })).find(row => row.record_id === id);
  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id, content, type: options.type ?? "episodic", priority: 70,
    scene_name: path, source_message_ids: [],
    metadata: { source_path: path } as MemoryRecord["metadata"],
    timestamps: [now], createdAt: existing?.created_time ?? now, updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    sessionKey: "ellmsha-durable-memory", sessionId: "ellmsha-durable-memory",
    teamId: isolation?.teamId, userId: isolation?.userId, agentId: isolation?.agentId,
  };
  const vector = embedding ? await embedding.embed(content) : undefined;
  if (!await store.upsertL1(record, vector)) throw new Error("Memory index rejected the record");
  return id;
}
