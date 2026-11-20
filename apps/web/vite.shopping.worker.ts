// The service worker's precache list and version, from the files the shopping app's build wrote. Lives in
// apps/web, never under a build/ directory (M1: TS6307, .gitignore).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type TPrecache = { version: string; assets: string[] };

/**
 * The shell (the scope URL itself, never "index.html": that is what a launch from the icon requests) plus
 * every emitted file, without the worker itself or source maps. The version hashes the list, the shell's
 * text (it can change while every hashed asset keeps its name) and `code`, the worker's own sources: a
 * change to the worker alone otherwise kept the cache name, and the new install wrote into the cache the
 * active worker serves from (phase 6 audit).
 */
export function precacheList(base: string, files: readonly string[], shell: string, code = ""): TPrecache {
  const assets = [base];
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; the web lib is es2022 (no toSorted)
  const sorted = [...new Set(files)].sort();
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    if (f === "sw.js" || f === "index.html" || f.endsWith(".map")) continue;
    assets.push(base + f);
  }
  const version = createHash("sha256")
    .update(assets.join("\n"))
    .update("\n")
    .update(shell)
    .update("\n")
    .update(code)
    .digest("hex")
    .slice(0, 12);
  return { version, assets };
}

/** Every file under `dir`, relative, with forward slashes. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out.push(path.relative(dir, path.join(f.parentPath, f.name)).split(path.sep).join("/"));
  return out;
}

/** The text of every source file under `dirs`, in a stable order (what the worker bundle is built from). */
export function sourcesText(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    const files = filesUnder(dir).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; the web lib is es2022 (no toSorted)
    files.sort();
    for (const f of files) parts.push(f, readFileSync(path.join(dir, f), "utf8"));
  }
  return parts.join("\n");
}

export function precacheFromBuild(dir: string, base: string, sources: readonly string[] = []): TPrecache {
  return precacheList(base, filesUnder(dir), readFileSync(path.join(dir, "index.html"), "utf8"), sourcesText(sources));
}
