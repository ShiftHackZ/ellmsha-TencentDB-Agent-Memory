import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CodeGraphInstance } from "./bridge.js";
import { createCodeGraphInstancePool } from "./runtime-pool.js";
import { CodeGraphService } from "../../store/code-graph-service.js";
import type { CodeGraphRow, IKnowledgeStore } from "../../store/types.js";
import type { BuildQueue } from "../../store/build-queue.js";
import { createCodeGraphRoutes } from "../../routes/code-graph.js";
import { createToolsRoutes } from "../../routes/tools.js";
import { createServiceAuthMiddleware } from "../../middleware/auth.js";

const codeQuery = vi.hoisted(() => vi.fn());
vi.mock("./index.js", () => ({ executeTool: codeQuery }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const instance = { cg: {}, handler: {}, projectRoot: "/owned/snapshot" } as CodeGraphInstance;
const graphId = "cg-12345678";

function fixture() {
  const close = vi.fn();
  const open = vi.fn(async () => instance);
  const pool = createCodeGraphInstancePool(open, close);
  const row = { code_graph_id: graphId, team_id: "team", status: "ready" };
  const service = {
    getById: (service: string, id: string) => service === "service" && id === graphId ? row : null,
    dirFor: () => "/owned/snapshot",
    delete: vi.fn(),
  } as unknown as CodeGraphService;
  const app = new Hono();
  app.use("*", createServiceAuthMiddleware({ serviceKey: "fixture-key" }, ""));
  app.route("/code-graph", createCodeGraphRoutes({ cgService: service, instancePool: pool, publicBaseUrl: "" }));
  app.route("/tools", createToolsRoutes({ cgService: service, instancePool: pool, wikiService: {} as never, wikiMgr: {} as never }));
  const request = (route: string, body: object, serviceId = "service") => app.request(route, {
    method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": serviceId, Authorization: "Bearer fixture-key" }, body: JSON.stringify(body),
  });
  const runtime = (action: string, extra: object = {}) => request("/code-graph/runtime", { code_graph_id: graphId, team_id: "team", action, ...extra });
  return { app, pool, row, close, open, service, request, runtime };
}

describe("code graph runtime lifecycle", () => {
  it("requires service authorization even for runtime status", async () => {
    const f = fixture();
    const result = await f.app.request("/code-graph/runtime", {
      method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": "service" },
      body: JSON.stringify({ code_graph_id: graphId, team_id: "team", action: "status" }),
    });
    expect(result.status).toBe(401);
    expect(f.open).not.toHaveBeenCalled();
  });
  it("reports unloaded status without opening and preserves the graph on repeated deallocation", async () => {
    const f = fixture();
    expect(await (await f.runtime("status")).json()).toMatchObject({ data: { loaded: false, loading: false, active_queries: 0 } });
    await f.runtime("deallocate");
    await f.runtime("deallocate");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.service.delete).not.toHaveBeenCalled();
  });

  it("loads once, releases only the handle, and can load the same snapshot again", async () => {
    const f = fixture();
    await Promise.all([f.runtime("allocate"), f.runtime("allocate")]);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(await (await f.runtime("deallocate")).json()).toMatchObject({ data: { loaded: false, index_status: "ready" } });
    await f.runtime("allocate");
    expect([f.close.mock.calls.length, f.open.mock.calls.length, f.service.getById("service", graphId)?.status]).toEqual([1, 2, "ready"]);
  });

  it("refuses release while a concurrent load is pending", async () => {
    const pending = deferred<CodeGraphInstance>();
    const close = vi.fn();
    const pool = createCodeGraphInstancePool(() => pending.promise, close);
    const loading = pool.loadIfMissing(graphId, "/snapshot");
    expect(pool.deallocate(graphId)).toBe(false);
    pending.resolve(instance);
    await loading;
    expect(pool.deallocate(graphId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["loading", "query"])('refuses manual or scheduled rebuild while runtime is %s', async phase => {
    const finish = deferred<CodeGraphInstance>();
    const enteredQuery = deferred<void>();
    const pool = createCodeGraphInstancePool(() => phase === "loading" ? finish.promise : Promise.resolve(instance), vi.fn());
    const row = { code_graph_id: graphId, team_id: "team", service_id: "service", status: "ready", version: 1 } as CodeGraphRow;
    const update = vi.fn((_service, _id, patch) => { Object.assign(row, patch); });
    const audit = vi.fn();
    const enqueue = vi.fn();
    const store = { getCodeGraph: () => row, updateCodeGraphStatus: update, appendCodeGraphAudit: audit } as unknown as IKnowledgeStore;
    const service = new CodeGraphService({
      store, dataRoot: "/fixture", worker: vi.fn(), queue: { enqueue } as unknown as BuildQueue,
      isRuntimeBusy: id => { const state = pool.status(id); return state.loading || state.active_queries > 0; },
    });
    const operation = phase === "loading" ? pool.loadIfMissing(graphId, "/snapshot") : pool.withInstance(graphId, "/snapshot", () => {
      enteredQuery.resolve();
      return finish.promise;
    });
    if (phase === "query") await enteredQuery.promise;
    expect(service.sync("service", "team", graphId)).toEqual({ kind: "busy", status: "ready", step: "runtime_busy" });
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    finish.resolve(instance);
    await operation;
    expect(service.sync("service", "team", graphId).kind).toBe("ok");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("pending");
  });

  it.each(["/code-graph/search", "/tools/call"])("refuses release during %s and releases its lease after errors", async route => {
    const f = fixture();
    const started = deferred<void>();
    const finish = deferred<{ text: string; isError: boolean }>();
    codeQuery.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const query = f.request(route, route === "/tools/call"
      ? { knowledge_id: graphId, tool_name: "search", params: { query: "symbol" } }
      : { code_graph_id: graphId, query: "symbol" });
    await started.promise;
    expect((await f.runtime("deallocate")).status).toBe(409);
    finish.resolve({ text: "query failed", isError: true });
    await query;
    expect((await f.runtime("deallocate")).status).toBe(200);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("releases a query lease when the engine throws", async () => {
    const f = fixture();
    await expect(f.pool.withInstance(graphId, "/snapshot", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(f.pool.status(graphId).active_queries).toBe(0);
    expect(f.pool.deallocate(graphId)).toBe(true);
  });

  it("does not mutate a busy, foreign, missing, or malformed graph", async () => {
    const f = fixture();
    f.row.status = "processing";
    expect((await f.runtime("deallocate")).status).toBe(409);
    expect((await f.runtime("allocate", { team_id: "other" })).status).toBe(404);
    expect((await f.request("/code-graph/runtime", { code_graph_id: graphId, team_id: "team", action: "allocate" }, "other")).status).toBe(404);
    expect((await f.runtime("destroy")).status).toBe(400);
    expect((await f.runtime("status", { action: ["allocate"] })).status).toBe(400);
    expect((await f.runtime("allocate", { code_graph_id: "../escape" })).status).toBe(400);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("reports failed loading without claiming the graph was allocated", async () => {
    const f = fixture();
    f.open.mockRejectedValueOnce(new Error("missing snapshot"));
    expect((await f.runtime("allocate")).status).toBe(503);
    expect(await (await f.runtime("status")).json()).toMatchObject({ data: { loaded: false, loading: false } });
    expect((await f.runtime("allocate")).status).toBe(200);
  });

  it("refuses to allocate an index that has not finished successfully", async () => {
    const f = fixture();
    f.row.status = "failed";
    expect((await f.runtime("allocate")).status).toBe(409);
    expect(f.open).not.toHaveBeenCalled();
  });
});
