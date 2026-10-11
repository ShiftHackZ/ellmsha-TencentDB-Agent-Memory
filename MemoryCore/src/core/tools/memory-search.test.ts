import { describe, expect, it } from "vitest";
import { applyRetrievalPlan, executeMemorySearch, formatSearchResponse, paginateSourceCatalog, type MemorySearchResultItem } from "./memory-search.js";

function item(overrides: Partial<MemorySearchResultItem> & Pick<MemorySearchResultItem, "id" | "content">): MemorySearchResultItem {
  return {
    type: "episodic",
    priority: 70,
    scene_name: "fixture",
    score: 0.5,
    version: 1,
    created_at: "2026-10-11T00:00:00.000Z",
    updated_at: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyRetrievalPlan", () => {
  it("keeps current project and global rules separate across new and imported scopes", () => {
    const records = [
      item({
        id: "new",
        content: "current project fact",
        source_path: "knowledge/demoproject-1234567890/current.md",
      }),
      item({
        id: "legacy",
        content: "legacy project fact",
        source_path: "v2/projects/demoproject-347d/decision.md",
      }),
      item({
        id: "other",
        content: "other project fact",
        source_path: "v2/projects/samp-1234/task.md",
      }),
      item({
        id: "global",
        content: "global rule",
        type: "instruction",
        source_path: "knowledge/global/git-rule.md",
      }),
    ];
    const scoped = applyRetrievalPlan(records, {
      limit: 10,
      scopeMode: "current_project",
      projectScopes: ["demoproject-1234567890"],
      projectAliases: ["DemoProject"],
    });
    expect(scoped.results.map((record) => record.id)).toEqual(["new", "legacy"]);

    const ambiguous = applyRetrievalPlan(
      [
        item({
          id: "wrong",
          content: "mobile note",
          source_path: "v2/projects/unrelated/mobile/decision.md",
        }),
      ],
      {
        limit: 10,
        scopeMode: "current_project",
        projectAliases: ["mobile"],
      }
    );
    expect(ambiguous.results).toEqual([]);

    const rules = applyRetrievalPlan(records, {
      limit: 10,
      scopeMode: "current_project",
      projectScopes: ["demoproject-1234567890"],
      projectAliases: ["DemoProject"],
      includeGlobal: true,
    });
    expect(rules.results.map((record) => record.id)).toEqual(["new", "legacy", "global"]);
    expect(applyRetrievalPlan(records, { limit: 10, scopeMode: "cross_project" }).results).toHaveLength(4);
  });

  it("returns no similar ticket for a nonexistent exact id", () => {
    const result = applyRetrievalPlan(
      [
        item({
          id: "one",
          content: "Implemented DEMO-4567",
          source_path: "v2/projects/demoproject/tasks.md",
        }),
        item({
          id: "two",
          content: "Verified DEMO4645",
          source_path: "v2/projects/demoproject/latest.md",
        }),
      ],
      { limit: 10, intent: "exact_ids", exactIds: ["DEMO-999999"] }
    );
    expect(result.results).toEqual([]);
    expect(result.matchedExactIds).toEqual([]);
    expect(result.missingExactIds).toEqual(["DEMO-999999"]);
  });

  it("requires evidence for every id in a comparison", () => {
    const result = applyRetrievalPlan(
      [
        item({
          id: "first",
          content: "DEMO-4510 result",
          source_path: "v2/projects/demoproject/4510.md",
        }),
        item({
          id: "second",
          content: "DEMO4543 result",
          source_path: "v2/projects/demoproject/4543.md",
        }),
      ],
      { limit: 10, intent: "exact_ids", exactIds: ["DEMO-4510", "DEMO-4543"] }
    );
    expect(result.results.map((record) => record.id)).toEqual(["first", "second"]);
    expect(result.matchedExactIds).toEqual(["DEMO-4510", "DEMO-4543"]);
    expect(result.missingExactIds).toEqual([]);
  });

  it("prefers dated current accepted evidence over a superseded proposal", () => {
    const result = applyRetrievalPlan(
      [
        item({
          id: "proposal",
          content: "Status: proposed\nQueued architecture. Reference target: 2027-12-31",
          source_path: "v2/projects/demoproject/proposal-2026-10-11.md",
        }),
        item({
          id: "accepted",
          content: "Accepted and implemented architecture on 2026-10-10",
          source_path: "v2/projects/demoproject/current-architecture-2026-10-10.md",
        }),
      ],
      { limit: 10, intent: "current_decision" }
    );
    expect(result.results[0]).toMatchObject({
      id: "accepted",
      event_date: "2026-10-10",
      status_hint: "accepted",
    });
  });

  it("paginates beyond four and reports truthful completeness", () => {
    const records = Array.from({ length: 11 }, (_, index) =>
      item({
        id: `task-${index}`,
        content: `open task ${index}`,
        source_path: `knowledge/project-scope/task-${index}.md`,
      })
    );
    const first = applyRetrievalPlan(records, {
      limit: 4,
      intent: "list_all",
      candidateRecallComplete: true,
    });
    expect(first.results).toHaveLength(4);
    expect(first.complete).toBe(false);
    expect(first.nextOffset).toBe(4);
    const last = applyRetrievalPlan(records, {
      limit: 4,
      offset: 8,
      intent: "list_all",
      candidateRecallComplete: true,
    });
    expect(last.results).toHaveLength(3);
    expect(last.complete).toBe(true);
    expect(last.nextOffset).toBeUndefined();

    const catalogFirst = paginateSourceCatalog(
      records.map((record) => record.source_path!),
      {
        limit: 4,
        scopeMode: "current_project",
        projectScopes: ["project-scope"],
      }
    );
    expect(catalogFirst).toMatchObject({ returned: 4, total: 11, complete: false, next_offset: 4 });
    const catalogLast = paginateSourceCatalog(
      records.map((record) => record.source_path!),
      {
        limit: 4,
        offset: 8,
        scopeMode: "current_project",
        projectScopes: ["project-scope"],
      }
    );
    expect(catalogLast).toMatchObject({ returned: 3, total: 11, complete: true });

    const boundedCatalog = paginateSourceCatalog(
      records.map((record) => record.source_path!),
      {
        limit: 20,
        scopeMode: "current_project",
        projectScopes: ["project-scope"],
        catalogComplete: false,
      }
    );
    expect(boundedCatalog).toMatchObject({ returned: 11, total: 11, complete: false });
    expect(boundedCatalog.next_offset).toBeUndefined();
  });

  it("does not claim completeness when candidate recall hit its bound", () => {
    const result = applyRetrievalPlan([item({ id: "one", content: "one", source_path: "knowledge/project-scope/one.md" })], {
      limit: 20,
      intent: "list_all",
      candidateRecallComplete: false,
    });
    expect(result.complete).toBe(false);
    expect(result.nextOffset).toBeUndefined(); // no invented cursor beyond a bounded pool
    const empty = applyRetrievalPlan([], {
      limit: 20,
      intent: "list_all",
      candidateRecallComplete: false,
    });
    expect(empty.complete).toBe(false);
    expect(empty.nextOffset).toBeUndefined();
  });
});


describe("scope-first execution", () => {
  function row(id: string, path: string, content: string, type = "episodic", priority = 70) {
    return { record_id: id, content, type, priority, scene_name: "fixture", version: 1,
      timestamp_start: "2026-10-11", timestamp_end: "2026-10-11", team_id: "team", user_id: "user", agent_id: "agent", task_id: "",
      metadata_json: JSON.stringify({ source_path: path }), score: 0.5 };
  }
  function store(rows: ReturnType<typeof row>[], recalled = rows) {
    return { isDegraded: () => false, isFtsAvailable: () => true, getCapabilities: () => ({ nativeHybridSearch: false }),
      searchL1Fts: () => recalled,
      queryL1Paginated: (filter: any) => {
        expect(filter).toMatchObject({ teamId: "team", userId: "user", agentId: "agent", offset: 0, limit: 4096 });
        const selected = rows.filter((r) => !filter.type || r.type === filter.type);
        return { rows: selected, total: selected.length };
      },
    } as never;
  }
  const base = { query: "latest task for Example", limit: 8, scopeMode: "current_project" as const,
    projectScopes: ["example-123"], projectAliases: ["Example"], filter: { teamId: "team", userId: "user", agentId: "agent" } };

  it("finds dated work omitted by global semantic top-K without crossing project isolation", async () => {
    const old = row("old", "v2/projects/example-ab/EX-121-release.md", "Released 2026-09-28");
    const fresh = row("fresh", "v2/projects/example-ab/EX-122-proposal.md", "Implemented EX-122 on 2026-10-08");
    const other = row("foreign", "v2/projects/unrelated-ab/OTHER-234.md", "Completed 2026-10-11");
    const diagnostic = row("audit", "knowledge/example-123/import-audit.md", "V2 migration reconciliation, 2026-10-11\n- As of: 2026-08-10\nA database fact.");
    const result = await executeMemorySearch({ ...base, intent: "latest", vectorStore: store([old, fresh, other, diagnostic], [old, other]) });
    expect(result.results.map((r) => r.id)).toEqual(["fresh", "old"]);
    expect(result.results[0].event_date).toBe("2026-10-08");
    expect(result.complete).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it("preserves imported global preferences and keeps them labelled evidence", async () => {
    const preference = row("pref", "v2/wiki/workflow-preference.md", "User prefers reviewing changes before committing.", "persona", 75);
    const project = row("rule", "knowledge/example-123/testing.md", "Test project changes.", "instruction");
    const unrelated = row("foreign", "v2/projects/unrelated-ab/private-rule.md", "Other project rule.", "instruction", 100);
    const result = await executeMemorySearch({ ...base, query: "fix a bug", intent: "rules", includeGlobal: true,
      vectorStore: store([preference, project, unrelated], [unrelated]) });
    expect(result.results.map((r) => r.id)).toEqual(["pref", "rule"]);
    expect(result.results[0].type).toBe("persona");
  });

  it("does not replace a topical unknown-status decision with an unrelated accepted document", async () => {
    const actual = row("actual", "knowledge/example-123/distribution.md", "2026-10-10: selected AGPL commercial licensing.", "instruction");
    const generic = row("generic", "knowledge/example-123/release.md", "Accepted release and implementation on 2026-10-11.", "instruction");
    const result = await executeMemorySearch({ ...base, query: "Which licensing decision?", intent: "current_decision", vectorStore: store([actual, generic], [actual, generic]) });
    expect(result.results[0].id).toBe("actual");
  });

  it("proves an exact negative only against the bounded source census", async () => {
    const actual = row("actual", "knowledge/example-123/EX-123.md", "EX-123 completed");
    const result = await executeMemorySearch({ ...base, query: "EX-999", intent: "exact_ids", exactIds: ["EX-999"], vectorStore: store([actual]) });
    expect(result.results).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.missingExactIds).toEqual(["EX-999"]);
  });

  it("reports a failed or bounded census without fabricating completion or a cursor", async () => {
    const actual = row("actual", "knowledge/example-123/EX-123.md", "EX-123 completed 2026-10-10");
    const bounded = { ...(store([actual]) as any), queryL1Paginated: () => ({ rows: [actual], total: 5000 }) };
    const result = await executeMemorySearch({ ...base, intent: "latest", vectorStore: bounded });
    expect(result).toMatchObject({ complete: false, degraded: true });
    expect(result.nextOffset).toBeUndefined();
    const failed = { ...bounded, queryL1Paginated: () => ({ rows: [], total: 0, error: "query_failed" }) };
    const unavailable = await executeMemorySearch({ ...base, vectorStore: failed });
    expect(unavailable).toMatchObject({ complete: false, degraded: true });
  });

  it("reports a failed semantic branch even when a keyword census finds fallback evidence", async () => {
    const actual = row("actual", "knowledge/example-123/topic.md", "database topic evidence");
    const adapter = { ...(store([actual]) as any), searchL1Fts: () => { throw new Error("fixture failure"); } };
    const result = await executeMemorySearch({ ...base, query: "database", vectorStore: adapter });
    expect(result.results[0].id).toBe("actual");
    expect(result.degraded).toBe(true);
    expect(result.message).toContain("search branch failed");
  });

  it("reads a census without an embedding provider and preserves original source dates", async () => {
    const imported = row("imported", "v2/projects/example-ab/history.md", "Undated subject\nEvidence\nSource: eLLMsha v2 projects/example/history.md; SHA-256: abc; Status: active; Date: 2026-08-01T00:00:00Z; Confidence: high");
    const adapter = { ...(store([imported]) as any), isFtsAvailable: () => false };
    const result = await executeMemorySearch({ ...base, query: "history", vectorStore: adapter });
    expect(result.results[0].event_date).toBe("2026-08-01");
    expect(result.degraded).toBe(false);
  });
});


describe("retrieval regressions", () => {
  it("does not treat body-level supersession as a superseded note", () => {
    const result = applyRetrievalPlan([
      item({ id: "new", content: "Implementation and validation\nOn 2026-10-08 a failed state is superseded by the next state.", source_path: "v2/projects/example/EX-122.md", source_status: "active" }),
      item({ id: "old", content: "Implemented 2026-10-07", source_path: "v2/projects/example/EX-121.md" }),
    ], { intent: "latest", limit: 8 });
    expect(result.results[0]).toMatchObject({ id: "new", status_hint: "unknown" });
  });

  it("does not match an unrelated nested alias or a different explicit version", () => {
    const result = applyRetrievalPlan([
      item({ id: "same", content: "same", source_path: "v2/projects/example-abc123/rule.md" }),
      item({ id: "nested", content: "nested", source_path: "v2/projects/isolated-example-v2-abc123/rule.md" }),
      item({ id: "version", content: "version", source_path: "v2/projects/example-v2-abc123/rule.md" }),
    ], { limit: 8, scopeMode: "current_project", projectAliases: ["example_v3"] });
    expect(result.results.map((item) => item.id)).toEqual(["same"]);
  });

  it("keeps warning and evidence together for legacy tool consumers", () => {
    const result = formatSearchResponse({ results: [item({ id: "one", content: "Verified evidence" })], total: 1, complete: false, matchedExactIds: [], missingExactIds: [], strategy: "fts", message: "Top-K only" });
    expect(result).toContain("Top-K only");
    expect(result).toContain("Verified evidence");
  });
});
