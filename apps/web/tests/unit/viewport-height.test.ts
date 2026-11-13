/**
 * L1-28 — apps/web and the UI packages it bundles never size a box in `vh`; they use `dvh`.
 *
 * On a mobile browser 100vh is the viewport with the browser's bars HIDDEN. The app shell
 * (app/root.tsx) is overflow-hidden, so the document never scrolls and the bars never hide: a
 * 100vh shell is taller than the visible area by the bar's height, and that strip — the last
 * sidebar rows, the last list rows — sat under Edge Canary's bottom bar, unreachable (Android
 * prod, 2026-11-13). Everything in the app hangs off that shell through `h-full`, so one class
 * decided it for the sidebar, the lists and the work-item peek alike.
 *
 * Fractional sizes (`max-h-[90vh]` dialogs, `max-h-[85vh]` sheets) are the same unit and overflow
 * the same way once the bars take more than the remaining 10–15 % (APLANE-55), so they are banned too.
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
/** Root -> minimum file count, so a wrong root or a renamed directory cannot pass by scanning nothing
 * (2026-11-13: app 188, core 1691, helpers 8, styles 3; ui 125, propel 387, editor 232).
 * apps/web/ce was listed here until 2026-11-13 and does not exist in v1.4.1 — it scanned nothing. */
const SCANNED: Record<string, number> = {
  "apps/web/app": 100,
  "apps/web/core": 1000,
  "apps/web/helpers": 1,
  "apps/web/styles": 1,
  "packages/ui/src": 60,
  "packages/propel/src": 200,
  "packages/editor/src": 100,
};
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", ".react-router", "build"]);
const SCANNED_EXT = /\.(ts|tsx|css)$/;
/** `h-screen` / `min-h-screen` / `max-h-screen`, with any variant prefix (`sm:`), as a whole class,
 * or any number followed by `vh` / `lvh` (`max-h-[90vh]`, `height: 100vh`); `lvh` is the same large
 * viewport under another name. The boundaries matter: `auth-screens` is a directory name all over
 * apps/web, and `100dvh` must not match through its `0`. `_` is NOT a boundary character: Tailwind
 * writes spaces as `_` inside arbitrary values (`h-[calc(100vh_-_4rem)]`). Not caught: units built
 * in JS (`${n}vh`) and uppercase `VH`. */
const VH_CLASS =
  /(?<![A-Za-z0-9_-])(?:min-|max-)?h-(?:screen|lvh)(?![A-Za-z0-9_-])|(?<![A-Za-z0-9.])(?:\d+(?:\.\d+)?|\.\d+)l?vh(?![A-Za-z0-9])/;
/** A line that STARTS with a comment marker is documentation, not a class. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;

function scan(): { hits: string[]; files: Record<string, number> } {
  const hits: string[] = [];
  const files: Record<string, number> = {};
  let root = "";
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(abs, entry.name), `${rel}/${entry.name}`);
        continue;
      }
      if (!SCANNED_EXT.test(entry.name)) continue;
      files[root]++;
      const path = `${rel}/${entry.name}`;
      readFileSync(join(abs, entry.name), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (VH_CLASS.test(line) && !COMMENT_LINE.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
        });
    }
  };
  for (const dir of Object.keys(SCANNED)) {
    root = dir;
    files[dir] = 0;
    if (existsSync(join(REPO_ROOT, dir))) walk(join(REPO_ROOT, dir), dir);
  }
  return { hits, files };
}

describe("apps/web uses dynamic viewport height, never vh (L1-28)", () => {
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
      'className="flex max-h-[90vh] flex-col"',
      'optionsClassName="max-h-[85vh]"',
      'className="pt-[30vh] md:pt-[35vh]"',
      "height: 37.5vh;",
      'className="h-[calc(100vh_-_4rem)]"',
      'className="grid-rows-[1fr_50vh]"',
      "height: .5vh;",
    ])
      expect(VH_CLASS.test(bad), bad).toBe(true);
    for (const good of [
      'import { X } from "@/components/auth-screens/header";',
      'className="h-dvh w-full"',
      'className="min-h-dvh"',
      'className="h-screen-safe"',
      "height: 100dvh;",
      'className="h-svh"',
      'className="max-h-[90dvh]"',
      'className="max-h-[85svh]"',
      'className="w-[50vw]"',
    ])
      expect(VH_CLASS.test(good), good).toBe(false);
  });

  it("finds no vh size in apps/web or the UI packages", () => {
    const { hits, files } = scan();
    for (const [dir, floor] of Object.entries(SCANNED)) expect(files[dir], dir).toBeGreaterThanOrEqual(floor);
    expect(hits).toEqual([]);
  });

  it("the app shell itself is h-dvh", () => {
    // The class that actually decides the bug; asserted positively so the test above cannot pass
    // because the shell moved somewhere the scan does not look.
    const root = readFileSync(join(REPO_ROOT, "apps/web/app/root.tsx"), "utf8");
    expect(root).toMatch(/"relative flex h-dvh w-full flex-col overflow-hidden bg-canvas"/);
  });

  it("routes serve viewport-fit=cover, so the shell pads the iOS safe area (APLANE-54)", () => {
    // cover draws the page under the home indicator and the notch; only env(safe-area-inset-*)
    // brings the content back out. Playwright's WebKit has no home indicator or notch, so no browser
    // test here can see it; the iPhone check is still OPEN on APLANE-54 (no iPhone here). No top inset
    // on purpose — see the comment on the shell in root.tsx.
    const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const f of ["apps/web/app/(all)/layout.tsx", "apps/web/app/(home)/layout.tsx"])
      expect(read(f), f).toContain("viewport-fit=cover");
    // Only the Root component's own code, comments dropped: a padding class in HydrateFallback or
    // in a comment must not satisfy this.
    const src = read("apps/web/app/root.tsx");
    const root = src
      .slice(src.indexOf("export default function Root()"), src.indexOf("export function HydrateFallback"))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const side of ["right", "bottom", "left"])
      expect(root, side).toMatch(new RegExp(`p${side[0]}-\\[env\\(safe-area-inset-${side}\\)\\]`));
  });
});
