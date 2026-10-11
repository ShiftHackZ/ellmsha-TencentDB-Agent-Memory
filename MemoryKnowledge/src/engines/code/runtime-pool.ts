import type { CodeGraphInstance } from "./bridge.js";

export type CodeGraphRuntimeStatus = { loaded: boolean; loading: boolean; active_queries: number };

export interface CodeGraphInstancePool {
  get(id: string): CodeGraphInstance | undefined;
  set(id: string, instance: CodeGraphInstance): void;
  delete(id: string): void;
  loadIfMissing(id: string, dir: string): Promise<CodeGraphInstance | undefined>;
  status(id: string): CodeGraphRuntimeStatus;
  /** False means a load or query is using the handle; nothing was closed. */
  deallocate(id: string): boolean;
  withInstance<T>(id: string, dir: string, query: (instance: CodeGraphInstance) => Promise<T>): Promise<T | undefined>;
}

/** Owns only live handles. Disk snapshots and graph metadata are never removed. */
export function createCodeGraphInstancePool(
  open: (dir: string) => Promise<CodeGraphInstance>,
  close: (instance: CodeGraphInstance) => void,
): CodeGraphInstancePool {
  const instances = new Map<string, CodeGraphInstance>();
  const loading = new Map<string, Promise<CodeGraphInstance | undefined>>();
  const queries = new Map<string, number>();
  const pool: CodeGraphInstancePool = {
    get: id => instances.get(id),
    set: (id, instance) => { instances.set(id, instance); },
    delete: id => { instances.delete(id); },
    status: id => ({ loaded: instances.has(id), loading: loading.has(id), active_queries: queries.get(id) ?? 0 }),
    async loadIfMissing(id, dir) {
      if (instances.has(id)) return instances.get(id);
      let pending = loading.get(id);
      if (!pending) {
        pending = Promise.resolve().then(() => open(dir)).then(instance => {
          instances.set(id, instance);
          return instance;
        }).catch(() => undefined).finally(() => { loading.delete(id); });
        loading.set(id, pending);
      }
      return pending;
    },
    deallocate(id) {
      if (loading.has(id) || queries.has(id)) return false;
      const instance = instances.get(id);
      if (instance) close(instance);
      instances.delete(id);
      return true;
    },
    async withInstance(id, dir, query) {
      queries.set(id, (queries.get(id) ?? 0) + 1);
      try {
        const instance = await pool.loadIfMissing(id, dir);
        return instance ? await query(instance) : undefined;
      } finally {
        const remaining = (queries.get(id) ?? 1) - 1;
        if (remaining) queries.set(id, remaining);
        else queries.delete(id);
      }
    },
  };
  return pool;
}
