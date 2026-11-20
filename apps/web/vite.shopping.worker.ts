// The service worker's precache list and version, from the files the shopping app's build wrote. Lives in
// apps/web, never under a build/ directory (M1: TS6307, .gitignore).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type TPrecache = { version: string; assets: string[] };

/**
 * The shell (the scope URL itself, never "index.html": that is what a launch from the icon requests) plus
 * every emitted file, without the worker itself or source maps. The version hashes the list AND the shell's
 * text, because the shell can change while every hashed asset keeps its name.
 */
export function precacheList(base: string, files: readonly string[], shell: string): TPrecache {
  const assets = [base];
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; the web lib is es2022 (no toSorted)
  const sorted = [...new Set(files)].sort();
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    if (f === "sw.js" || f === "index.html" || f.endsWith(".map")) continue;
    assets.push(base + f);
  }
  const version = createHash("sha256").update(assets.join("\n")).update("\n").update(shell).digest("hex").slice(0, 12);
  return { version, assets };
}

/** Every file under `dir`, relative, with forward slashes. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out.push(path.relative(dir, path.join(f.parentPath, f.name)).split(path.sep).join("/"));
  return out;
}

export function precacheFromBuild(dir: string, base: string): TPrecache {
  return precacheList(base, filesUnder(dir), readFileSync(path.join(dir, "index.html"), "utf8"));
}
