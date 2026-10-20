import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportRecallMetrics } from "../core/report/metric-tracking-recall.js";
import { StorageAdapter } from "../core/storage/adapter.js";

const executeMemorySearch = vi.hoisted(() => vi.fn());

vi.mock("../core/tools/memory-search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/tools/memory-search.js")>()),
  executeMemorySearch,
}));
vi.mock("../core/report/metric-tracking-recall.js", () => ({ reportRecallMetrics: vi.fn() }));
vi.mock("../core/report/factory.js", () => ({
  getObservabilityBackend: () => ({ tracePropagation: { serializeTraceContext: () => undefined } }),
}));

import { handleAtomicSearch, type V2RouterDeps } from "./v2-router.js";
import { atomicSearchRequestSchema } from "./v2-schemas.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const auth = { serviceId: "service", apiKey: "local" } as never;

function searchResult(sourcePath = "knowledge/project-scope/task-2.md") {
  return {
    results: [
      {
        id: "memory-1",
        content: "fixture evidence",
        type: "episodic",
        priority: 70,
        scene_name: "fixture",
        score: 0.9,
        version: 1,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
        source_path: sourcePath,
        event_date: "2026-10-11",
        status_hint: "accepted",
      },
    ],
    total: 1,
    complete: true,
    matchedExactIds: ["DEMO-4510"],
    missingExactIds: [],
    strategy: "fts",
  };
}

function dependencies(storage?: StorageAdapter): V2RouterDeps {
  return {
    getStore: () => ({}) as never,
    getEmbedding: () => undefined,
    getStorage: () => storage,
    logger,
  };
}

describe("atomic/search gateway compatibility", () => {
  beforeEach(() => {
    executeMemorySearch.mockReset();
    executeMemorySearch.mockResolvedValue(searchResult());
  });

  it("keeps legacy requests valid with deliberate projectless defaults", async () => {
    expect(atomicSearchRequestSchema.parse({ query: "legacy query" })).toMatchObject({
      limit: 5,
      offset: 0,
      intent: "search",
      scope_mode: "projectless",
      project_scopes: [],
      project_aliases: [],
      include_global: false,
      exact_ids: [],
    });

    const response = await handleAtomicSearch({ query: "legacy query" }, auth, "request-1", dependencies());
    expect(response.code).toBe(0);
    expect(executeMemorySearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "legacy query",
        limit: 5,
        offset: 0,
        intent: "search",
        scopeMode: "projectless",
        projectScopes: [],
        projectAliases: [],
        includeGlobal: false,
        exactIds: [],
      })
    );
    expect(response.data).toMatchObject({
      returned: 1,
      total_candidates: 1,
      complete: true,
      matched_exact_ids: ["DEMO-4510"],
      missing_exact_ids: [],
    });
  });

  it("acknowledges and forwards mandatory inventory without changing ordinary search defaults", async () => {
    executeMemorySearch.mockResolvedValue(searchResult());
    const response = await handleAtomicSearch({ query: "required rules", intent: "rules", guidance_inventory: true }, auth, "mandatory", dependencies());
    expect(response.data).toMatchObject({ guidance_inventory: true, guidance_locality: "unverified" });
    expect(reportRecallMetrics).not.toHaveBeenCalled();
    expect(executeMemorySearch).toHaveBeenCalledWith(expect.objectContaining({ guidanceInventory: true, intent: "rules" }));
    const ordinary = await handleAtomicSearch({ query: "ordinary" }, auth, "ordinary", dependencies());
    expect(ordinary.data).toMatchObject({ guidance_inventory: false });
    expect(reportRecallMetrics).toHaveBeenCalledTimes(1);
  });

  it("preserves active rule storage provenance in the public response", async () => {
    const fixture = searchResult();
    const provenance = { source_status: "active", source_origin: "v2_import", source_sha256: "a".repeat(64), guidance_scope: "project", guidance_status: "active" };
    executeMemorySearch.mockResolvedValue({ ...fixture, results: [{ ...fixture.results[0], ...provenance, type: "instruction" }] });
    const response = await handleAtomicSearch({ query: "fixture", intent: "rules" }, auth, "rules", dependencies());
    expect(response.data?.items[0]).toMatchObject(provenance);
  });

  it("forwards scoped planning and returns paginated source catalog metadata", async () => {
    const backend = {
      type: "fixture",
      listObjects: vi.fn().mockResolvedValue({
        entries: Array.from({ length: 6 }, (_, index) => ({
          key: `scene_blocks/knowledge/project-scope/task-${index}.md`,
          isDirectory: false,
          lastModified: new Date("2026-10-11T00:00:00.000Z"),
          size: 1,
        })),
      }),
    };
    const storage = new StorageAdapter(backend as never);
    executeMemorySearch.mockResolvedValue(searchResult("knowledge/project-scope/task-2.md"));

    const request = {
      query: "list exact fixture",
      limit: 2,
      offset: 2,
      intent: "list_all",
      scope_mode: "current_project",
      project_scopes: ["project-scope"],
      project_aliases: ["Fixture Project"],
      include_global: true,
      exact_ids: ["DEMO-4510"],
    };
    expect(atomicSearchRequestSchema.parse(request)).toEqual(expect.objectContaining(request));

    const response = await handleAtomicSearch(request, auth, "request-2", dependencies(storage));
    expect(executeMemorySearch).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
        offset: 2,
        intent: "list_all",
        scopeMode: "current_project",
        projectScopes: ["project-scope"],
        projectAliases: ["Fixture Project"],
        includeGlobal: true,
        exactIds: ["DEMO-4510"],
      })
    );
    expect(response.data).toMatchObject({
      returned: 1,
      total_candidates: 6,
      complete: false,
      next_offset: 4,
      matched_exact_ids: ["DEMO-4510"],
      missing_exact_ids: [],
      source_catalog: {
        paths: ["knowledge/project-scope/task-2.md", "knowledge/project-scope/task-3.md"],
        returned: 2,
        total: 6,
        complete: false,
        next_offset: 4,
      },
    });
  });
  it("keeps corpus coverage independent of alphabetical catalogue page order", async () => {
    executeMemorySearch.mockResolvedValue({ ...searchResult("knowledge/project-scope/a.md"), indexedSourcePaths: ["knowledge/project-scope/a.md", "knowledge/project-scope/z.md"] });
    const backend = {
      listObjects: vi.fn().mockResolvedValue({
        entries: [
          { key: "scene_blocks/knowledge/project-scope/a.md", isDirectory: false },
          { key: "scene_blocks/knowledge/project-scope/z.md", isDirectory: false },
        ],
      }),
    };
    const response = await handleAtomicSearch({ query: "all tasks", intent: "list_all", limit: 1, offset: 1 }, auth, "order", dependencies(new StorageAdapter(backend as never)));
    expect(response.data).toMatchObject({ complete: true, degraded: false, source_catalog: { paths: ["knowledge/project-scope/z.md"], unindexed_paths: [], complete: true } });
  });

  it("marks repeating catalogue cursors degraded without looping or claiming completeness", async () => {
    const backend = { listObjects: vi.fn().mockResolvedValue({ entries: [], nextMarker: "repeat" }) };
    const response = await handleAtomicSearch({ query: "all tasks", intent: "list_all" }, auth, "repeat", dependencies(new StorageAdapter(backend as never)));
    expect(backend.listObjects).toHaveBeenCalledTimes(2);
    expect(response.data).toMatchObject({ complete: false, degraded: true, evidence_status: "degraded", source_catalog: { complete: false } });
  });

  it("preserves sanitized degraded status even when fallback evidence exists", async () => {
    executeMemorySearch.mockResolvedValue({ ...searchResult(), complete: false, degraded: true, message: "Candidate census unavailable" });
    const response = await handleAtomicSearch({ query: "a question" }, auth, "degraded", dependencies());
    expect(response.data).toMatchObject({ returned: 1, degraded: true, evidence_status: "degraded", complete: false, message: "Candidate census unavailable" });
  });
});
