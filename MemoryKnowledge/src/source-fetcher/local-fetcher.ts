import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchResult, ISourceFetcher } from "./types.js";

export const LOCAL_SNAPSHOT_MANIFEST = ".tdai-local-snapshot.json";
const OMIT_DIRS = new Set([".git", ".data", ".codegraph", "node_modules", "vendor", "build", "dist", "out", "target", "coverage", ".next", ".venv", ".cache", "__pycache__"]);
const OMIT_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.tdai-local-snapshot\.json|credentials(?:\.json)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?)$|\.(?:pem|p12|pfx|key)$/i;
const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + sep);

/** Opt-in snapshots of allowlisted Git workspaces, including uncommitted files.
 * Indexes live in service storage; the mounted source is never modified.
 */
export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType = "local" as const;
  constructor(private readonly roots = (process.env.KNOWLEDGE_LOCAL_ROOTS ?? "").split(delimiter).filter(Boolean)) {}

  private allowedRoots(): string[] {
    const directory = process.env.KNOWLEDGE_LOCAL_PROJECTS_DIR;
    if (!directory || !existsSync(directory)) return this.roots;
    const roots = [...this.roots];
    for (const file of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const full = join(directory, file);
      if (lstatSync(full).isSymbolicLink()) continue;
      const value: unknown = JSON.parse(readFileSync(full, "utf8"));
      if (!Array.isArray(value) || value.some((root) => typeof root !== "string" || !isAbsolute(root)))
        throw new Error("Invalid native project root allowlist");
      roots.push(...value.filter((root) => existsSync(root)));
    }
    return roots;
  }

  private source(sourceUrl: string): string {
    const path = sourceUrl.startsWith("file://") ? fileURLToPath(sourceUrl) : sourceUrl;
    if (!isAbsolute(path)) throw new Error("Local code source must be an absolute path");
    const canonical = realpathSync(path);
    if (!this.allowedRoots().some((root) => within(realpathSync(root), canonical))) {
      throw new Error("Local code source is outside KNOWLEDGE_LOCAL_ROOTS");
    }
    if (!lstatSync(canonical).isDirectory()) throw new Error("Local code source must be a directory");
    return canonical;
  }

  validate(sourceUrl: string): void { this.source(sourceUrl); }

  private isPlainPath(source: string, rel: string): boolean {
    let path = source;
    return rel.split(sep).every((part) => {
      path = join(path, part);
      return existsSync(path) && !lstatSync(path).isSymbolicLink();
    });
  }

  async fetch(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    const source = this.source(sourceUrl);
    const requested = resolve(localPath);
    let ancestor = requested;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const destination = resolve(realpathSync(ancestor), relative(ancestor, requested));
    if (within(source, destination) || within(destination, source)) throw new Error("Snapshot must be separate from its source");
    const files: string[] = [];
    const enumerate = (directory: string) => {
      // git's ignore rules omit generated/private local artifacts. Recurse
      // explicitly into gitlinks/nested repos so a fork monorepo is complete.
      const names = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", `safe.directory=${directory}`, "-C", directory,
        "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split("\0").filter(Boolean);
      for (const name of new Set(names)) {
        const path = resolve(directory, name);
        if (!within(source, path)) throw new Error("Source path escapes the selected workspace");
        const rel = relative(source, path);
        if (rel.split(sep).some((part) => OMIT_DIRS.has(part) || OMIT_FILES.test(part))) continue;
        if (!this.isPlainPath(source, rel)) continue; // tracked deletion / symlink
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !within(source, realpathSync(path))) continue;
        if (stat.isDirectory()) {
          if (existsSync(join(path, ".git"))) enumerate(path);
          continue;
        }
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        files.push(rel);
        if (files.length > 20_000) throw new Error("Local snapshot exceeds 20000 files; select a smaller workspace");
      }
    };
    enumerate(source);
    mkdirSync(destination, { recursive: true });
    const manifest = join(destination, LOCAL_SNAPSHOT_MANIFEST);
    const previous: string[] = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
    const current = new Set(files);
    for (const old of previous) {
      const path = resolve(destination, old);
      if (!within(destination, path) || path === destination) throw new Error("Invalid snapshot manifest");
      if (!current.has(old)) rmSync(path, { force: true });
    }
    const digest = createHash("sha256");
    for (const rel of [...current].sort()) {
      if (!this.isPlainPath(source, rel)) throw new Error("Workspace changed during snapshot; retry sync");
      const fd = openSync(join(source, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Workspace changed during snapshot; retry sync");
        content = readFileSync(fd);
      } finally { closeSync(fd); }
      const target = join(destination, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      digest.update(rel).update("\0").update(content).update("\0");
    }
    writeFileSync(manifest, JSON.stringify([...current]));
    return { localPath: destination, version: digest.digest("hex").slice(0, 12), sourceType: "local" };
  }

  sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    return this.fetch(sourceUrl, branch, localPath);
  }
}
