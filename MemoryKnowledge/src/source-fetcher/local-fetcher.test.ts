import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalSourceFetcher, LOCAL_SNAPSHOT_MANIFEST } from "./local-fetcher.js";

const fixtures: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-local-"));
  fixtures.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  execFileSync("git", ["init", "-q", source]);
  return { root, source, destination: join(root, "snapshot"), fetcher: new LocalSourceFetcher([source]) };
}

describe("allowlisted local code snapshots", () => {
  it("includes uncommitted source, respects ignores, and omits tracked secrets/build output", async () => {
    const { source, destination, fetcher } = fixture();
    writeFileSync(join(source, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(source, "tracked.ts"), "export const before = 1;");
    writeFileSync(join(source, ".env"), "PRIVATE=fixture");
    mkdirSync(join(source, "build"));
    writeFileSync(join(source, "build/generated.ts"), "generated");
    execFileSync("git", ["-C", source, "add", "."]);
    writeFileSync(join(source, "tracked.ts"), "export const current = 2;");
    writeFileSync(join(source, "untracked.ts"), "export const newFile = true;");
    writeFileSync(join(source, "ignored.ts"), "ignored");
    const result = await fetcher.fetch(pathToFileURL(source).href, "ignored-branch", destination);
    expect(result.sourceType).toBe("local");
    expect(readFileSync(join(destination, "tracked.ts"), "utf8")).toContain("current = 2");
    expect(existsSync(join(destination, "untracked.ts"))).toBe(true);
    for (const omitted of [".git", ".env", "build", "ignored.ts"]) expect(existsSync(join(destination, omitted))).toBe(false);
    expect(existsSync(join(source, LOCAL_SNAPSHOT_MANIFEST))).toBe(false);
  });

  it("rejects paths outside the allowlist and excludes symlinked files/directories", async () => {
    const { root, source, destination, fetcher } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.ts"), "private fixture");
    symlinkSync(join(outside, "secret.ts"), join(source, "link.ts"));
    symlinkSync(outside, join(source, "linked-dir"));
    expect(() => fetcher.validate(join(source, "..", "outside"))).toThrow("outside KNOWLEDGE_LOCAL_ROOTS");
    expect(() => fetcher.validate(pathToFileURL(join(source, "linked-dir")).href)).toThrow("outside KNOWLEDGE_LOCAL_ROOTS");
    expect(() => new LocalSourceFetcher([]).validate(source)).toThrow("outside KNOWLEDGE_LOCAL_ROOTS");
    await expect(fetcher.fetch(source, "main", join(source, "snapshot"))).rejects.toThrow("separate");
    await fetcher.fetch(source, "main", destination);
    expect(existsSync(join(destination, "link.ts"))).toBe(false);
    expect(existsSync(join(destination, "linked-dir"))).toBe(false);
  });

  it("syncs changes/deletions and nested repositories while preserving the generated index", async () => {
    const { source, destination, fetcher } = fixture();
    writeFileSync(join(source, "deleted.ts"), "export const deleted = true;");
    const nested = join(source, "fork");
    mkdirSync(nested);
    execFileSync("git", ["init", "-q", nested]);
    writeFileSync(join(nested, "code.ts"), "export const revision = 1;");
    const first = await fetcher.fetch(source, "main", destination);
    expect(readFileSync(join(destination, "fork/code.ts"), "utf8")).toContain("revision = 1");
    mkdirSync(join(destination, ".codegraph"));
    writeFileSync(join(destination, ".codegraph/index.db"), "fixture-index");
    rmSync(join(source, "deleted.ts"));
    writeFileSync(join(nested, "code.ts"), "export const revision = 2;");
    const next = await fetcher.sync(source, "main", destination);
    expect(next.version).not.toBe(first.version);
    expect(existsSync(join(destination, "deleted.ts"))).toBe(false);
    expect(readFileSync(join(destination, "fork/code.ts"), "utf8")).toContain("revision = 2");
    expect(existsSync(join(destination, ".codegraph/index.db"))).toBe(true);
  });
});

it("reads new native project grants without restart and refuses removed roots", async () => {
  const { root, source } = fixture();
  const grants = join(root, "grants"); mkdirSync(grants);
  vi.stubEnv("KNOWLEDGE_LOCAL_PROJECTS_DIR", grants);
  const fetcher = new LocalSourceFetcher([]);
  expect(() => fetcher.validate(source)).toThrow("outside KNOWLEDGE_LOCAL_ROOTS");
  const file = join(grants, "a".repeat(64) + ".json");
  writeFileSync(file, JSON.stringify([source]));
  expect(() => fetcher.validate(source)).not.toThrow();
  writeFileSync(file, JSON.stringify([]));
  expect(() => fetcher.validate(source)).toThrow("outside KNOWLEDGE_LOCAL_ROOTS");
});
