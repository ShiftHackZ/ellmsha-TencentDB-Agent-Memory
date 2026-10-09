/** Offline desktop index rebuild. Only operates on a staged database copy. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { VectorStore } from './core/store/sqlite/memory-store.js';
import { OpenAIEmbeddingService, type OpenAIEmbeddingConfig } from './core/store/embedding.js';

const [configFile, database] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8')) as OpenAIEmbeddingConfig;
const fatal = () => { throw new Error('Reindex failed; keep the original database'); };
const store = new VectorStore(database, config.dimensions, { info() {}, warn: fatal, error: fatal, debug() {} });
try {
  const encoder = new OpenAIEmbeddingService(config);
  await store.init(encoder.getProviderInfo());
  if (store.isDegraded()) fatal();
  const expectedL1 = store.getAllL1Texts().length;
  const expectedL0 = store.getAllL0Texts().length;
  const result = await store.reindexAll(text => encoder.embed(text), (done, total, layer) => {
    process.stdout.write(JSON.stringify({ done: layer === 'L0' ? expectedL1 + done : done, total: expectedL1 + expectedL0, layer }) + '\n');
  });
  if (result.l1Count !== expectedL1 || result.l0Count !== expectedL0) fatal();
} finally { store.close(); }
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const db = new DatabaseSync(database);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

process.exit(0);
