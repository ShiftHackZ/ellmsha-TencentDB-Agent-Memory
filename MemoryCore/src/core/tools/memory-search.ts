/**
 * memory_search tool: Agent-callable tool for searching L1 memory records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged via Reciprocal Rank Fusion (RRF).
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 */

import { createHash } from "node:crypto";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { extractQueryTokens } from "../store/tokenize.js";
import { recallL1Candidates } from "./l1-candidate-recall.js";

// ============================
// Types
// ============================

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  priority: number;
  scene_name: string;
  score: number;
  version: number;
  created_at: string;
  updated_at: string;
  /** Exact L2 scenario path, when the record was indexed from a document. */
  source_path?: string;
  event_date?: string;
  status_hint?: string;
  /** Original source lifecycle, distinct from inferred implementation state. */
  source_status?: string;
  /** Storage provenance, not a claim that a user personally authored the text. */
  source_origin?: "scenario_write" | "v2_import";
  source_sha256?: string;
  guidance_scope?: "project" | "global";
  guidance_status?: "active" | "unverified";
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  total: number;
  complete: boolean;
  nextOffset?: number;
  matchedExactIds: string[];
  missingExactIds: string[];
  strategy: string;
  /** Retrieval capability failed or its bounded candidate census was incomplete. */
  degraded?: boolean;
  /** Internal bounded index coverage for comparison with the independent L2 catalogue. */
  indexedSourcePaths?: string[];
  /** Optional message, e.g. when embedding is not configured. */
  message?: string;
}

export type RetrievalIntent = "search" | "continue" | "latest" | "current_decision" | "exact_ids" | "list_all" | "rules";
export type RetrievalScopeMode = "current_project" | "cross_project" | "projectless";
export type SourceCatalogPage = {
  paths: string[];
  returned: number;
  total: number;
  complete: boolean;
  next_offset?: number;
};

const TAG = "[memory-tdai][tdai_memory_search]";

function toSearchItem(r: L1SearchResult): MemorySearchResultItem {
  let sourcePath: string | undefined;
  let sourceStatus: string | undefined;
  let sourceOrigin: MemorySearchResultItem["source_origin"];
  let sourceHash: string | undefined;
  try {
    const metadata = JSON.parse(r.metadata_json || "{}");
    if (typeof metadata.source_path === "string") {
      sourcePath = metadata.source_path;
      if (metadata.source_origin === "scenario_write") sourceOrigin = "scenario_write";
      if (typeof metadata.source_status === "string") sourceStatus = metadata.source_status;
      // Earlier explicit scenario writes had only source_path. Verify their
      // stable owner/path identity and reserved session, rather than requiring
      // new metadata or treating arbitrary historical prose as active guidance.
      const scenarioId = `scenario-${createHash("sha256")
        .update(JSON.stringify([r.team_id ?? "", r.user_id ?? "", r.agent_id ?? "", sourcePath]))
        .digest("hex")
        .slice(0, 40)}`;
      if (r.record_id === scenarioId && r.session_key === "ellmsha-durable-memory") {
        sourceOrigin = "scenario_write";
        if (!sourceStatus && (r.type === "instruction" || r.type === "persona")) sourceStatus = "active";
      }
    } else if (metadata.migration?.source === "ellmsha-v2-vault" && typeof metadata.migration.source_path === "string") {
      sourcePath = `v2/${metadata.migration.source_path}`;
      sourceOrigin = "v2_import";
      if (typeof metadata.migration.source_sha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.migration.source_sha256)) sourceHash = metadata.migration.source_sha256;
      if (typeof metadata.migration.status === "string") sourceStatus = metadata.migration.status;
    }
  } catch {
    /* Legacy records may have no structured provenance. */
  }
  return {
    id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    score: r.score,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    version: r.version ?? 0,
    created_at: r.timestamp_start,
    updated_at: r.timestamp_end,
    source_path: sourcePath,
    source_status: sourceStatus,
    source_origin: sourceOrigin,
    source_sha256: sourceHash,
  };
}

function hasNativeL1Hybrid(store: IMemoryStore): boolean {
  return typeof store.getCapabilities === "function" && !!store.getCapabilities().nativeHybridSearch && typeof store.searchL1Hybrid === "function";
}

function normalizeId(value: string): string {
  return value.toUpperCase().replace(/-/g, "");
}

function idsIn(value: string): Set<string> {
  return new Set((value.match(/\b[A-Z][A-Z0-9]{1,15}-?\d{2,}\b/gi) ?? []).map(normalizeId));
}

function normalizedSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function aliasVariants(alias: string): string[] {
  const normalized = normalizedSlug(alias);
  const withoutVersion = normalized.replace(/-v?\d+(?:-\d+)*$/, "");
  return [...new Set([normalized, withoutVersion].filter((value) => value.length >= 4))];
}

function isGlobalSource(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.startsWith("knowledge/global/") || normalized.startsWith("global/") || normalized.startsWith("v2/wiki/") || normalized.startsWith("wiki/") || normalized.includes("/global-rules/");
}

export function matchesRetrievalProjectPath(sourcePath: string, scopes: string[], aliases: string[], includeGlobal: boolean): boolean {
  const source = sourcePath.toLowerCase();
  if (includeGlobal && isGlobalSource(source)) return true;
  if (!source) return false;
  if (scopes.some((scope) => source.includes(`/` + scope.toLowerCase() + `/`))) return true;
  const variants = aliases.flatMap(aliasVariants);
  const legacyProject = source.match(/^v2\/projects\/([^/]+)(?:\/|$)/)?.[1];
  if (!legacyProject) return false;
  return variants.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:$|[-_][a-f0-9]{2,}(?:[-_][a-f0-9]+)*$)`, "i").test(legacyProject);
  });
}

function matchesProject(item: MemorySearchResultItem, scopes: string[], aliases: string[], includeGlobal: boolean): boolean {
  return matchesRetrievalProjectPath(item.source_path ?? "", scopes, aliases, includeGlobal);
}

export function paginateSourceCatalog(
  paths: string[],
  options: {
    limit: number;
    offset?: number;
    scopeMode?: RetrievalScopeMode;
    projectScopes?: string[];
    projectAliases?: string[];
    includeGlobal?: boolean;
    catalogComplete?: boolean;
  }
): SourceCatalogPage {
  const { limit, offset = 0, scopeMode = "projectless", projectScopes = [], projectAliases = [], includeGlobal = false, catalogComplete = true } = options;
  const filtered = [...new Set(paths)].filter((sourcePath) => scopeMode !== "current_project" || matchesRetrievalProjectPath(sourcePath, projectScopes, projectAliases, includeGlobal)).sort((left, right) => left.localeCompare(right));
  const page = filtered.slice(offset, offset + limit);
  const complete = catalogComplete && offset + page.length >= filtered.length;
  return {
    paths: page,
    returned: page.length,
    total: filtered.length,
    complete,
    next_offset: offset + page.length < filtered.length ? offset + page.length : undefined,
  };
}

function sourceEventDate(item: MemorySearchResultItem): string | undefined {
  const asOf = item.content.match(/(?:^|\n)\s*(?:-\s*)?(?:as of|effective(?: date)?|по состоянию на)\s*:?\s*((?:19|20)\d{2}[-/.]\d{2}[-/.]\d{2})/i)?.[1];
  if (asOf) return asOf.replace(/[/.]/g, "-");
  // Import timestamps reflect the migration, never the fact. The importer
  // retains the original source date in a labelled provenance footer.
  if (item.source_path?.startsWith("v2/")) {
    const original = item.content.match(/(?:^|\n)Source: eLLMsha v2 [^\n]*; Date: ((?:19|20)\d{2}-\d{2}-\d{2})/);
    if (original) return original[1];
  }
  const datePattern = /\b(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])\b/g;
  const pathDates = (item.source_path ?? "").match(datePattern) ?? [];
  if (pathDates.length > 0)
    return pathDates
      .map((value) => value.replace(/[/.]/g, "-"))
      .sort()
      .at(-1);
  const header = item.content.slice(0, 2000);
  const explicit = header.match(/(?:^|\n)(?:date|created|updated|verified|released|дата|обновлено)\s*:\s*((?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01]))/i)?.[1];
  if (explicit) return explicit.replace(/[/.]/g, "-");
  return header.match(datePattern)?.[0]?.replace(/[/.]/g, "-");
}

function statusHint(content: string): string {
  // A lifecycle word in implementation prose can describe an event/state, not
  // this note. Only an explicit header or the subject's own declaration counts.
  const explicit = content.match(/(?:^|\n)\s*(?:-\s*)?status\s*:\s*(accepted|implemented|verified|complete|completed|passed|released|proposed|proposal|queued|planned|pending|draft|superseded|obsolete|replaced)\b/i)?.[1]?.toLowerCase();
  const subject = content.split("\n", 1)[0].toLowerCase();
  const value = explicit ?? subject.match(/^(?:#*\s*)?(?:\d{4}-\d{2}-\d{2}[: ,]*\s*)?(accepted|implemented|verified|completed|passed|released|proposed|queued|planned|pending|draft|superseded|obsolete)\b/)?.[1];
  if (value && /^(accepted|implemented|verified|complete|completed|passed|released)$/.test(value)) return "accepted";
  if (value && /^(proposed|proposal|queued|planned|pending|draft)$/.test(value)) return "proposed";
  if (value) return "superseded";
  return "unknown";
}

function statusRank(status: string | undefined): number {
  if (status === "accepted") return 3;
  if (status === "unknown") return 2;
  if (status === "proposed") return 1;
  return 0;
}

function canonicalRank(item: MemorySearchResultItem): number {
  const path = (item.source_path ?? "").toLowerCase();
  if (/(current|status|decision|acceptance|implementation|handoff|release)/.test(path)) return 2;
  if (/(discovery|suggestion|proposal|transcript|raw-log)/.test(path)) return 0;
  return 1;
}

function rankPlanned(items: MemorySearchResultItem[], intent: RetrievalIntent, exactIds: string[], query?: string): MemorySearchResultItem[] {
  const requested = exactIds.map(normalizeId);
  const enriched = items.map((item) => ({
    ...item,
    event_date: sourceEventDate(item),
    status_hint: /^(archived|superseded|obsolete|inactive)$/i.test(item.source_status ?? "") ? "superseded" : statusHint(item.content),
  }));
  if (intent === "list_all") {
    const inventoryRank = (item: MemorySearchResultItem) => {
      const subject = (item.source_path?.split("/").at(-1) ?? "").toLowerCase();
      const inventory = /(?:backlog|roadmap|todo|inventory|task.*status|status.*task)/.test(subject);
      return inventory ? (/current|status/.test(subject) ? 2 : 1) : 0;
    };
    return enriched.sort((a, b) => inventoryRank(b) - inventoryRank(a) || b.score - a.score || a.id.localeCompare(b.id));
  }
  if (intent === "search" || intent === "continue" || intent === "rules") return enriched.sort((a, b) => b.score - a.score || b.priority - a.priority);
  return enriched.sort((left, right) => {
    const leftIds = idsIn(`${left.source_path ?? ""}\n${left.content}`);
    const rightIds = idsIn(`${right.source_path ?? ""}\n${right.content}`);
    const idDelta = requested.filter((id) => rightIds.has(id)).length - requested.filter((id) => leftIds.has(id)).length;
    if (idDelta) return idDelta;
    // Relevance first for a topical decision: an unrelated "accepted" release
    // must not displace the actual licensing/database/etc. decision.
    const topicalLatest = intent === "latest" && query && !/\b(task|ticket|issue)\b|задач/iu.test(query);
    if ((intent === "current_decision" || topicalLatest) && right.score !== left.score) return right.score - left.score;
    if (intent === "current_decision") {
      const statusDelta = statusRank(right.status_hint) - statusRank(left.status_hint);
      if (statusDelta) return statusDelta;
    }
    const obsoleteDelta = Number(left.status_hint === "superseded") - Number(right.status_hint === "superseded");
    if (obsoleteDelta) return obsoleteDelta;
    const dateDelta = (right.event_date ?? "").localeCompare(left.event_date ?? "");
    if (dateDelta) return dateDelta;
    const statusDelta = statusRank(right.status_hint) - statusRank(left.status_hint);
    if (statusDelta) return statusDelta;
    return right.score - left.score || canonicalRank(right) - canonicalRank(left) || left.id.localeCompare(right.id);
  });
}

export function applyRetrievalPlan(
  input: MemorySearchResultItem[],
  options: {
    limit: number;
    query?: string;
    offset?: number;
    intent?: RetrievalIntent;
    scopeMode?: RetrievalScopeMode;
    projectScopes?: string[];
    projectAliases?: string[];
    includeGlobal?: boolean;
    exactIds?: string[];
    candidateRecallComplete?: boolean;
  }
): Pick<MemorySearchResult, "results" | "total" | "complete" | "nextOffset" | "matchedExactIds" | "missingExactIds"> {
  const { limit, offset = 0, intent = "search", scopeMode = "projectless", projectScopes = [], projectAliases = [], includeGlobal = false, exactIds = [], candidateRecallComplete = true } = options;
  let results = input;
  if (scopeMode === "current_project") {
    results = results.filter((item) => matchesProject(item, projectScopes, projectAliases, includeGlobal));
  }
  const normalizedExactIds = exactIds.map(normalizeId);
  if (normalizedExactIds.length > 0) {
    results = results.filter((item) => {
      const found = idsIn(`${item.source_path ?? ""}\n${item.content}`);
      return normalizedExactIds.some((id) => found.has(id));
    });
  }
  results = rankPlanned(results, intent, exactIds, options.query);
  const matchedSet = new Set<string>();
  for (const item of results) {
    const found = idsIn(`${item.source_path ?? ""}\n${item.content}`);
    for (const [index, normalized] of normalizedExactIds.entries()) {
      if (found.has(normalized)) matchedSet.add(exactIds[index]);
    }
  }
  const matchedExactIds = exactIds.filter((id) => matchedSet.has(id));
  const missingExactIds = exactIds.filter((id) => !matchedSet.has(id));
  const page = results.slice(offset, offset + limit);
  const hasMoreKnown = offset + limit < results.length;
  return {
    results: page,
    total: results.length,
    complete: candidateRecallComplete && !hasMoreKnown,
    // A candidate bound is not a pagination cursor: advancing would just
    // return an empty page from the same bounded pool.
    nextOffset: hasMoreKnown ? offset + page.length : undefined,
    matchedExactIds,
    missingExactIds,
  };
}

/** Fuse lexical relevance inside the selected project with the semantic recall. */
function rankScopedCandidates(items: MemorySearchResultItem[], recalled: L1SearchResult[], query: string, rules = false): MemorySearchResultItem[] {
  const cleanQuery = query.replace(/^applicable stable rules and decisions for:\s*/i, "");
  // Weight explicit questions over surrounding execution/QA boilerplate without
  // discarding the task in an earlier sentence ("Prepare X. Which rules apply?").
  // This only ranks candidates; it never changes the fact query, ID or authority.
  const questions = rules ? cleanQuery.match(/[^.!?\n]+\?/g) : undefined;
  const questionTokens = new Set(extractQueryTokens(questions?.join(" ") ?? "").filter((token) => !GUIDANCE_GENERIC_TOKENS.has(token)));
  const tokens = extractQueryTokens(cleanQuery).filter((token) => !rules || !GUIDANCE_GENERIC_TOKENS.has(token));
  const documents = items.map((item) => new Set(extractQueryTokens(`${item.source_path ?? ""} ${item.content}`)));
  const weights = tokens.map((token) => Math.log(1 + items.length / (1 + documents.filter((doc) => doc.has(token)).length)) * (questionTokens.has(token) ? 3 : 1));
  const averageLength = documents.reduce((sum, doc) => sum + doc.size, 0) / Math.max(items.length, 1) || 1;
  const lexical = items
    .map((item, index) => {
      const body = tokens.reduce((sum, token, t) => sum + (documents[index].has(token) ? weights[t] : 0), 0);
      // Guidance has a subject: long backlogs/status instructions must not win
      // every small rule page merely by mentioning more words in the user prompt.
      // Apply BM25-style length normalization and a subject boost only to rules;
      // ordinary fact/semantic ranking remains unchanged.
      const subject = rules ? new Set(extractQueryTokens(`${item.source_path?.split("/").at(-1) ?? ""} ${item.content.split("\n", 1)[0]}`)) : new Set<string>();
      const topical = tokens.reduce((sum, token, t) => sum + (subject.has(token) ? weights[t] : 0), 0);
      const value = rules ? (body * 2.2) / (1 + 1.2 * (0.25 + (0.75 * documents[index].size) / averageLength)) + 2 * topical : body;
      return { item, value };
    })
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.item.id.localeCompare(b.item.id));
  const lexicalRanks = new Map(lexical.map((entry, index) => [entry.item.id, index]));
  const ids = new Set(items.map((item) => item.id));
  const semanticRanks = new Map(recalled.filter((hit) => ids.has(hit.record_id)).map((hit, index) => [hit.record_id, index]));
  return items
    .map((item) => {
      const lexicalScore = lexicalRanks.has(item.id) ? 1 / (60 + lexicalRanks.get(item.id)!) : 0;
      const semanticScore = semanticRanks.has(item.id) ? 1 / (60 + semanticRanks.get(item.id)!) : 0;
      // Best-rank fusion lets either channel nominate a rule. A semantic-only
      // cross-language match must not lose to incidental lexical overlap, nor
      // must long records matching both channels crowd out a precise rule subject.
      return { ...item, score: rules ? Math.max(lexicalScore, semanticScore) : lexicalScore + semanticScore };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Lifecycle/scope come from storage, never from "User says" inside a search hit. */
const GUIDANCE_GENERIC_TOKENS = new Set([
  "project",
  "task",
  "user",
  "goal",
  "current",
  "fix",
  "bug",
  "work",
  "applicable",
  "stable",
  "rule",
  "rules",
  "guidance",
  "policy",
  "policies",
  "apply",
  "follow",
  "prepare",
  "next",
  "latest",
  "against",
  "decisions",
  "проект",
  "задача",
]);
function applicableGuidance(items: MemorySearchResultItem[], query: string): MemorySearchResultItem[] {
  const tokens = new Set(extractQueryTokens(query.replace(/^applicable stable rules and decisions for:\s*/i, "")).filter((token) => !GUIDANCE_GENERIC_TOKENS.has(token)));
  const relevant = (item: MemorySearchResultItem) => extractQueryTokens(item.content).some((token) => tokens.has(token));
  return items.flatMap((item) => {
    if (item.type !== "instruction" && item.type !== "persona") return [];
    if (/^(archived|superseded|obsolete|inactive|draft|unverified)$/i.test(item.source_status ?? "") || statusHint(item.content) === "superseded") return [];
    const global = isGlobalSource(item.source_path ?? "");
    const active = item.source_status === "active";
    // Canonical global rules (the importer assigns priority 90 to rules/guidance)
    // apply across tasks. Personal facts and project-alias notes need relevance.
    const globalRule = global && active && item.type === "instruction" && (item.source_origin === "scenario_write" || item.priority >= 90);
    if (global && !globalRule && !relevant(item)) return [];
    if (!global && !active && item.score <= 0) return [];
    return [
      {
        ...item,
        guidance_scope: global ? ("global" as const) : ("project" as const),
        guidance_status: active ? ("active" as const) : ("unverified" as const),
        // Project active rules cannot lose every slot to semantically similar global notes.
        score: (active && !global ? 4 : globalRule ? 2 : 0) + item.score,
      },
    ];
  });
}

// ============================
// Search implementation
// ============================

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  type?: string;
  scene?: string;
  filter?: IsolationFilter;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  offset?: number;
  intent?: RetrievalIntent;
  scopeMode?: RetrievalScopeMode;
  projectScopes?: string[];
  projectAliases?: string[];
  includeGlobal?: boolean;
  exactIds?: string[];
}): Promise<MemorySearchResult> {
  const {
    query,
    limit,
    type: typeFilter,
    scene: sceneFilter,
    filter: isolationFilter,
    vectorStore,
    embeddingService,
    logger,
    offset = 0,
    intent = "search",
    scopeMode = "projectless",
    projectScopes = [],
    projectAliases = [],
    includeGlobal = false,
    exactIds = [],
  } = params;

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
      `typeFilter=${typeFilter ?? "(none)"}, sceneFilter=${sceneFilter ?? "(none)"}, ` +
      `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
      `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`
  );

  if (!query || query.trim().length === 0) {
    logger?.debug?.(`${TAG} Empty query, returning empty`);
    return {
      results: [],
      total: 0,
      complete: true,
      matchedExactIds: [],
      missingExactIds: exactIds,
      strategy: "none",
    };
  }

  if (!vectorStore || vectorStore.isDegraded?.()) {
    logger?.warn?.(`${TAG} VectorStore not available`);
    return {
      results: [],
      total: 0,
      complete: false,
      matchedExactIds: [],
      missingExactIds: exactIds,
      strategy: "none",
      degraded: true,
      message: "Memory store is unavailable; absence of evidence is not a negative result.",
    };
  }

  // Native hybrid (TCVDB) is a valid search path even with NoopEmbeddingService.
  const hasEmbedding = hasClientEmbedding(embeddingService);
  const hasFts = vectorStore.isFtsAvailable();
  const nativeHybrid = hasNativeL1Hybrid(vectorStore);

  if (!hasEmbedding && !hasFts && !nativeHybrid && !vectorStore.queryL1Paginated) {
    logger?.warn?.(`${TAG} Neither EmbeddingService nor FTS5 available — cannot search`);
    return {
      results: [],
      total: 0,
      complete: false,
      matchedExactIds: [],
      missingExactIds: exactIds,
      strategy: "none",
      degraded: true,
      message:
        "Embedding service is not configured and FTS is not available. " +
        "Memory search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  const candidateK = scopeMode === "current_project" ? 256 : Math.min(Math.max((offset + limit) * 6, 48), 256);
  const recalled = await recallL1Candidates({
    query,
    topK: candidateK,
    vectorStore,
    embeddingService,
    logger,
    filter: isolationFilter,
    logTag: TAG,
  }).catch(() => ({ hits: [] as L1SearchResult[], strategy: "none" as const, failedPaths: ["semantic"] }));

  // A semantic top-K is not a source census. Enumerate a bounded isolated
  // candidate pool BEFORE project/intent filtering, retaining semantic ranks.
  // Existing paginated store API keeps identity isolation in every backend.
  const censusLimit = 4096;
  let candidateRecallComplete = false;
  let degraded = !!recalled.failedPaths?.length;
  let message: string | undefined = degraded ? "A search branch failed; fallback evidence may omit relevant sources." : undefined;
  let candidates = recalled.hits;
  if (vectorStore.queryL1Paginated && (scopeMode === "current_project" || intent !== "search" || exactIds.length > 0)) {
    try {
      // Rule retrieval has its own bounded census: ordinary facts must not
      // consume every slot before active project guidance is even considered.
      const pages =
        intent === "rules" && !typeFilter
          ? await Promise.all((["instruction", "persona"] as const).map((type) => vectorStore.queryL1Paginated!({ ...isolationFilter, type, limit: censusLimit / 2, offset: 0 })))
          : [await vectorStore.queryL1Paginated({ ...isolationFilter, type: typeFilter, limit: censusLimit, offset: 0 })];
      for (const page of pages) if (page.error) throw new Error(page.error);
      const page = { rows: pages.flatMap((page) => page.rows), total: pages.reduce((sum, page) => sum + page.total, 0) };
      const seen = new Set(page.rows.map((row) => row.record_id));
      candidates = [...page.rows.map((row) => ({ ...row, score: 0 })), ...recalled.hits.filter((hit) => !seen.has(hit.record_id))];
      candidateRecallComplete = page.rows.length >= page.total;
      if (!candidateRecallComplete) {
        degraded = true;
        message = "Candidate census reached its bound; latest/all/negative claims are not exhaustive.";
      }
    } catch {
      degraded = true;
      message = "Candidate census unavailable; returning partial semantic evidence only.";
    }
  } else {
    message = "Semantic top-K only; completeness of the source corpus is unknown.";
  }
  if (recalled.strategy === "none" && !candidateRecallComplete) degraded = true;
  let results = candidates.map(toSearchItem);
  if (scopeMode === "current_project") results = results.filter((item) => matchesProject(item, projectScopes, projectAliases, includeGlobal));

  const preFilterCount = results.length;
  if (typeFilter) {
    results = results.filter((r) => r.type === typeFilter);
    logger?.debug?.(`${TAG} After type filter "${typeFilter}": ${results.length}/${preFilterCount}`);
  }
  if (sceneFilter) {
    const normalizedScene = sceneFilter.toLowerCase();
    results = results.filter((r) => r.scene_name.toLowerCase().includes(normalizedScene));
    logger?.debug?.(`${TAG} After scene filter "${sceneFilter}": ${results.length}/${preFilterCount}`);
  }

  results = rankScopedCandidates(results, recalled.hits, query, intent === "rules");
  const indexedSourcePaths = intent === "list_all" ? [...new Set(results.flatMap((item) => (item.source_path ? [item.source_path] : [])))] : undefined;
  if (["search", "continue", "current_decision"].includes(intent) || (intent === "latest" && !/\b(task|ticket|issue)\b|задач/iu.test(query))) {
    results = results.filter((item) => item.score > 0);
  }
  if (intent === "latest" && /\b(task|ticket|issue)\b|задач/iu.test(query)) {
    // Task recency concerns work records, not a newer migration/retrieval audit
    // mentioning a project. Prefer records whose own subject is an issue.
    const workRecords = results.filter((item) => /\b[A-Z][A-Z0-9]{1,15}-\d{2,}\b/i.test(`${item.source_path?.split("/").at(-1) ?? ""}\n${item.content.split("\n", 1)[0]}`));
    if (workRecords.length) results = workRecords;
  }
  if (intent === "rules") results = applicableGuidance(results, query);
  const planned = applyRetrievalPlan(results, {
    limit,
    query,
    offset,
    intent,
    scopeMode,
    projectScopes,
    projectAliases,
    includeGlobal,
    exactIds,
    candidateRecallComplete,
  });

  logger?.debug?.(`${TAG} RESULT (strategy=${recalled.strategy}): returning ${planned.results.length} memories ` + `(scores: [${planned.results.map((r) => r.score.toFixed(3)).join(", ")}])`);

  return {
    ...planned,
    indexedSourcePaths,
    strategy: candidateRecallComplete ? `${recalled.strategy}+scoped-census` : recalled.strategy,
    degraded,
    message,
  };
}

// ============================
// Tool response formatter
// ============================

export function formatSearchResponse(result: MemorySearchResult): string {
  if (result.results.length === 0) {
    return result.message ?? "No matching memories found.";
  }

  const lines: string[] = [...(result.message ? [`Retrieval note: ${result.message}`, ""] : []), `Found ${result.total} matching memories:`, ""];

  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const sceneStr = item.scene_name ? ` [scene: ${item.scene_name}]` : "";
    const priorityStr = item.priority >= 0 ? ` (priority: ${item.priority})` : " (global instruction)";
    lines.push(`- **[${item.type}]**${priorityStr}${sceneStr}${scoreStr}`);
    lines.push(`  ${item.content}`);
    lines.push("");
  }

  return lines.join("\n");
}
