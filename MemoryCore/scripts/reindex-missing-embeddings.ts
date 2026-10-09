/**
 * Resume embedding backfill after enabling/changing the configured model.
 * Uses TDAI_GATEWAY_CONFIG and the existing SQLite store; never rewrites memory.
 * Run: node --import tsx scripts/reindex-missing-embeddings.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";
import { VectorStore } from "../src/core/store/sqlite/memory-store.js";

const config = loadGatewayConfig();
const embedding = config.memory.embedding;
assert.ok(embedding.enabled && embedding.provider !== "none", "Configure an embedding provider first");
assert.equal(config.memory.storeBackend, "sqlite", "This maintenance command supports SQLite only");
const embedder = createEmbeddingService(embedding);
const store = new VectorStore(join(config.data.baseDir, "vectors.db"), embedder.getDimensions());
try {
  store.init(embedder.getProviderInfo());
  assert.equal(store.isDegraded(), false, "SQLite/vector extension initialization failed");
  const db = store.getRawDb();
  for (const [table, vectorTable, textColumn, timeColumn] of [
    ["l1_records", "l1_vec", "content", "updated_time"],
    ["l0_conversations", "l0_vec", "message_text", "recorded_at"],
  ]) {
    const pending = db.prepare(`SELECT record_id, ${textColumn} AS text, ${timeColumn} AS time
      FROM ${table} WHERE record_id NOT IN (SELECT record_id FROM ${vectorTable})`).all() as Array<{ record_id: string; text: string; time: string }>;
    let indexed = 0;
    for (let offset = 0; offset < pending.length; offset += 16) {
      const batch = pending.slice(offset, offset + 16);
      // Failed batches abort visibly; restarting resumes from missing vectors.
      const vectors = await embedder.embedBatch(batch.map((row) => row.text));
      assert.equal(vectors.length, batch.length, "Embedding provider returned an incomplete batch");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];
          const vector = vectors[i];
          assert.equal(vector.length, embedder.getDimensions());
          assert.ok(vector.every(Number.isFinite) && vector.some((value) => value !== 0), "Invalid embedding");
          // A live writer may have edited/deleted this record while embedding.
          const unchanged = db.prepare(`SELECT 1 FROM ${table} WHERE record_id = ? AND ${textColumn} = ? AND ${timeColumn} = ?`).get(row.record_id, row.text, row.time);
          if (!unchanged) continue;
          const exists = db.prepare(`SELECT 1 FROM ${vectorTable} WHERE record_id = ?`).get(row.record_id);
          if (exists) continue;
          db.prepare(`INSERT INTO ${vectorTable} (record_id, embedding, ${timeColumn}) VALUES (?, ?, ?)`).run(row.record_id, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), row.time);
          indexed++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      console.log(`${table}: indexed ${indexed}/${pending.length}`);
    }
    const remaining = db.prepare(`SELECT count(*) AS count FROM ${table} WHERE record_id NOT IN (SELECT record_id FROM ${vectorTable})`).get() as { count: number };
    assert.equal(remaining.count, 0, `${table}: missing vectors remain; rerun to include concurrent changes`);
    console.log(`${table}: complete (${indexed} added)`);
  }
} finally {
  store.close();
  await embedder.close?.();
}
