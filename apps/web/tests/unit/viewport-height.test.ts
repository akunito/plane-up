/**
 * L1-28 — apps/web never sizes a box with 100vh (`h-screen`, `min-h-screen`); it uses 100dvh.
 *
 * On a mobile browser 100vh is the viewport with the browser's bars HIDDEN. The app shell
 * (app/root.tsx) is overflow-hidden, so the document never scrolls and the bars never hide: a
 * 100vh shell is taller than the visible area by the bar's height, and that strip — the last
 * sidebar rows, the last list rows — sat under Edge Canary's bottom bar, unreachable (Android
 * prod, 2026-11-13). Everything in the app hangs off that shell through `h-full`, so one class
 * decided it for the sidebar, the lists and the work-item peek alike.
 *
 * Why a source scan and not a browser test: Playwright's browsers have no browser bars, so 100vh
 * and 100dvh measure the same there and a geometry assertion passes with or without the fix.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** Same walk-up as L1-24: `import.meta.url` is not a file: URL under this vitest setup. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find pnpm-workspace.yaml above ${process.cwd()}`);
}

const REPO_ROOT = repoRoot();
const SCANNED = ["apps/web/app", "apps/web/core", "apps/web/ce"];
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", ".react-router", "build"]);
const SCANNED_EXT = /\.(ts|tsx|css)$/;
/** `h-screen` / `min-h-screen` / `max-h-screen`, with any variant prefix (`sm:`), as a whole class;
 * `h-lvh` and `100lvh` are the same large viewport under another name. The boundaries matter:
 * `auth-screens` is a directory name all over apps/web. */
const VH_CLASS = /(?<![A-Za-z0-9_-])(?:min-|max-)?h-(?:screen|lvh)(?![A-Za-z0-9_-])|\b100l?vh\b/;
/** A line that STARTS with a comment marker is documentation, not a class. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;

function scan(): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(abs, entry.name), `${rel}/${entry.name}`);
        continue;
      }
      if (!SCANNED_EXT.test(entry.name)) continue;
      files++;
      const path = `${rel}/${entry.name}`;
      readFileSync(join(abs, entry.name), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (VH_CLASS.test(line) && !COMMENT_LINE.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
        });
    }
  };
  for (const dir of SCANNED) if (existsSync(join(REPO_ROOT, dir))) walk(join(REPO_ROOT, dir), dir);
  return { hits, files };
}

describe("apps/web uses dynamic viewport height, never 100vh (L1-28)", () => {
  it("the pattern matches every 100vh spelling and nothing else", () => {
    for (const bad of [
      'className="h-screen w-full"',
      'className="flex min-h-screen"',
      'className="max-h-screen"',
      'className="sm:h-screen"',
      "`h-screen w-full`",
      "height: 100vh;",
      'className="h-lvh"',
      'className="min-h-lvh"',
      "height: 100lvh;",
      'className="h-[100vh]"',
    ])
      expect(VH_CLASS.test(bad), bad).toBe(true);
    for (const good of [
      'import { X } from "@/components/auth-screens/header";',
      'className="h-dvh w-full"',
      'className="min-h-dvh"',
      'className="h-screen-safe"',
      "height: 100dvh;",
      'className="h-svh"',
    ])
      expect(VH_CLASS.test(good), good).toBe(false);
  });

  it("finds no 100vh in apps/web", () => {
    const { hits, files } = scan();
    // A floor, so a wrong root or a renamed directory cannot pass by scanning nothing.
    expect(files).toBeGreaterThan(1000);
    expect(hits).toEqual([]);
  });

  it("the app shell itself is h-dvh", () => {
    // The class that actually decides the bug; asserted positively so the test above cannot pass
    // because the shell moved somewhere the scan does not look.
    const root = readFileSync(join(REPO_ROOT, "apps/web/app/root.tsx"), "utf8");
    expect(root).toMatch(/className=\{cn\("relative flex h-dvh w-full flex-col overflow-hidden/);
  });
});
