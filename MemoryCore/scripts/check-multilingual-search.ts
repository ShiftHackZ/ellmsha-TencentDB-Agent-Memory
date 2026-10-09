/** Run with: node --import tsx scripts/check-multilingual-search.ts */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../src/core/store/sqlite/memory-store.js";
import { buildFtsQuery, extractQueryTokens, tokenizeForFts } from "../src/core/store/tokenize.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { recallL1Candidates } from "../src/core/tools/l1-candidate-recall.js";
import type { IMemoryStore, L1SearchResult } from "../src/core/store/types.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";

assert.deepEqual(extractQueryTokens("какие правила git branch naming"), ["правила", "git", "branch", "naming"]);
assert.deepEqual(extractQueryTokens("What is my most important project?"), ["most", "important", "project"]);
assert.ok(tokenizeForFts("память українська Ελληνικά العربية").includes("память українська Ελληνικά العربية"));
assert.ok(extractQueryTokens("用户喜欢TypeScript").includes("typescript"));

const dir = mkdtempSync(join(tmpdir(), "memory-recall-check-"));
const dbPath = join(dir, "vectors.db");
let store = new VectorStore(dbPath, 0);
try {
  store.init();
  assert.equal(store.isDegraded(), false);
  for (const [id, content, userId] of [
    ["git", "Git branch naming rules require feature prefixes.", "alice"],
    ["ru", "Рабочая память хранится в базе данных.", "alice"],
    ["noise", "Контакты и история автомобиля.", "alice"],
    ["foreign", "Git branch naming rules in another workspace.", "bob"],
  ]) {
    assert.ok(store.upsertL1({
      id, content, type: "instruction", priority: 50, scene_name: "test", source_message_ids: [],
      metadata: { source_path: `checks/${id}.md` } as MemoryRecord["metadata"], timestamps: ["2026-10-08T00:00:00Z"],
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
      sessionKey: "test", sessionId: "test", userId, agentId: "agent", teamId: "team",
    }, undefined));
  }
  assert.deepEqual(store.queryL1Records({ recordIds: ["ru"], userId: "alice" }).map((r) => r.record_id), ["ru"]);
  assert.deepEqual(store.queryL1Records({ recordIds: ["missing"] }), []);
  assert.deepEqual(store.queryL1Records({ recordIds: [] }), []);
  assert.deepEqual(store.queryL1Records({ recordIds: ["foreign"], userId: "alice" }), []);
  assert.deepEqual(store.queryL1Records({ recordIds: ["ru"], sessionId: "other" }), []);
  assert.deepEqual(store.queryL1Records({ recordIds: ["ru"], updatedAfter: "2026-10-09" }), []);

  // Simulate a legacy index whose Cyrillic text was split into characters.
  store.getRawDb().exec("UPDATE l1_fts SET content = 'п а м я т ь' WHERE record_id = 'ru'; DELETE FROM fts_tokenizer_versions;");
  assert.equal(store.searchL1Fts(buildFtsQuery("память")!, 5).length, 0);
  store.close();
  store = new VectorStore(dbPath, 0);
  store.init();
  assert.equal(store.searchL1Fts(buildFtsQuery("память")!, 5)[0]?.record_id, "ru");
  const result = await executeMemorySearch({ query: "какие правила git branch naming", limit: 3, vectorStore: store, filter: { userId: "alice" } });
  assert.equal(result.results[0]?.id, "git");
  assert.equal(result.results[0]?.source_path, "checks/git.md");
  assert.ok(result.results.every((r) => r.id !== "noise" && r.id !== "foreign"));
  // A shared product name must not make lower semantic hits outrank the actual
  // answer solely because they also appear in the flat OR-keyword result list.
  const hit = (id: string) => ({ record_id: id, content: "Orion project details", score: 0.6 } as L1SearchResult);
  const incidental = Array.from({ length: 15 }, (_, i) => hit(`incidental-${i}`));
  const hybrid = await recallL1Candidates({
    query: "Как называется главный проект связанный с Orion", topK: 20,
    vectorStore: { isFtsAvailable: () => true, searchL1Fts: () => incidental,
      searchL1Vector: () => [hit("architecture"), hit("name-and-alias"), ...incidental],
    } as unknown as IMemoryStore,
    embeddingService: { embed: async () => new Float32Array([1]) } as EmbeddingService,
  });
  assert.ok(hybrid.hits.slice(0, 4).some((r) => r.record_id === "name-and-alias"));
  console.log("PASS: multilingual tokens, legacy index rebuild, relevance, exact IDs, isolation, provenance");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
