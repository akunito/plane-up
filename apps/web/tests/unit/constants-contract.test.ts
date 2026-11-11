/**
 * L1-24 — constants the fork depends on (B-22, B-29, B-30, B-31). These live in shared
 * packages, where an unrelated edit could silently drop an entry.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ISSUE_DISPLAY_FILTERS_BY_PAGE, ISSUE_ORDER_BY_OPTIONS, LOGIN_MEDIUM_LABELS } from "@plane/constants";
import { EIssueLayoutTypes } from "@plane/types";
import { GLOBAL_VIEW_LAYOUTS } from "@/plane-web/components/views/helper";

describe("constants contract (L1-24)", () => {
  it("order-by options include State (everywhere) and Project (global views)", () => {
    const keys = ISSUE_ORDER_BY_OPTIONS.map((o) => o.key);
    expect(keys).toContain("-state__name");
    expect(keys).toContain("project__name");
  });

  it("global views offer exactly Table, Board and Calendar", () => {
    expect(GLOBAL_VIEW_LAYOUTS).toEqual([
      EIssueLayoutTypes.SPREADSHEET,
      EIssueLayoutTypes.KANBAN,
      EIssueLayoutTypes.CALENDAR,
    ]);
  });

  it("my_issues (global views) configures spreadsheet, list, kanban and calendar", () => {
    const layouts = ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions;
    for (const layout of ["spreadsheet", "list", "kanban", "calendar"] as const)
      expect(layouts[layout], layout).toBeDefined();
  });

  it("global spreadsheet/list/kanban allow ordering by project; project pages do not", () => {
    const my = ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions;
    for (const layout of ["spreadsheet", "list", "kanban"] as const)
      expect(my[layout]?.display_filters.order_by, layout).toContain("project__name");
    const issues = ISSUE_DISPLAY_FILTERS_BY_PAGE.issues.layoutOptions;
    for (const opts of Object.values(issues))
      expect(opts?.display_filters.order_by ?? []).not.toContain("project__name");
  });

  it("the global kanban groups by state group only", () => {
    expect(ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions.kanban?.display_filters.group_by).toEqual([
      "state_detail.group",
    ]);
  });
});

/**
 * L1-26 — the repurposed "gitea" OAuth slot presents as Pocket ID (APLANE-45, APLANE-49).
 *
 * The slot's backend adapter talks to Pocket ID OIDC, not Gitea
 * (apps/api/plane/authentication/provider/oauth/gitea.py). The lowercase name is load-bearing and
 * must never be renamed — the /auth/gitea/ routes, the GITEA_* instance-configuration rows and
 * every existing user's provider_id key off it, so a rename logs the whole instance out. Only what
 * a person READS is Pocket ID.
 *
 * B-32 relabelled apps/web alone. The miss cost two tickets: a published board asked visitors to
 * "Sign up with Gitea" (APLANE-45) and the admin panel described Gitea over fields holding Pocket
 * ID's host and secret, with gitea.com prefilled as the host (APLANE-49). So this is asserted from
 * two sides — the label constant that has a real runtime consumer, and a scan of the source for
 * strings nothing imports.
 *
 * The scan is deliberately a second copy of the gate's L0-09 stage (dotfiles
 * system/app/plane-tests/remote/fork-suite.sh). Both exist on purpose: this one travels with the
 * code and fires on a plain `pnpm test`, L0-09 runs pre-build in under a second and does not depend
 * on a test file the fork could delete. If you change the pattern here, change it there.
 *
 * Known holes, the same three as L0-09: a lowercase `gitea` in user-facing copy walks through; so
 * does a label on a line starting with a comment marker, because the filter cannot tell a comment
 * from a template-literal continuation; and it cannot see an ICON, which is why the three
 * gitea-logo.svg files are deleted rather than left unreferenced — a re-import then fails a build.
 */
/**
 * Measured 2026-11-11: under vitest's jsdom environment `import.meta.url` is NOT a file: URL, so
 * `fileURLToPath(new URL("../../../..", import.meta.url))` throws "The URL must be of scheme file"
 * and takes the whole suite down with it. Walking up from cwd to the workspace marker also means
 * the scan cannot silently read the wrong tree: no marker, no test.
 */
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
const SCANNED = [
  "apps/web",
  "apps/space",
  "apps/admin",
  "apps/live",
  "packages/constants",
  "packages/i18n",
  "packages/ui",
  "packages/propel",
  "packages/types",
];
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "test", ".turbo", ".react-router", "build"]);
const SCANNED_EXT = /\.(ts|tsx|json)$/;
/** Capitalised word or the domain only: lowercase `gitea` is the load-bearing slot name. */
const GITEA_LABEL = /\bGitea\b|gitea\.com/;
/** A line that STARTS with a comment marker is documentation about the slot, not a label. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;

function giteaLabelsUnder(dir: string): string[] {
  const hits: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(abs, entry.name), `${rel}/${entry.name}`);
        continue;
      }
      if (!SCANNED_EXT.test(entry.name)) continue;
      const path = `${rel}/${entry.name}`;
      const lines = readFileSync(join(abs, entry.name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (GITEA_LABEL.test(line) && !COMMENT_LINE.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(join(REPO_ROOT, dir), dir);
  return hits;
}

describe("the Pocket ID slot never presents as Gitea (L1-26)", () => {
  it("labels the gitea login medium as Pocket ID", () => {
    // The one with a runtime consumer: the workspace members table prints this as a member's login
    // medium (apps/web/core/components/workspace/settings/useMemberColumns.tsx).
    expect(LOGIN_MEDIUM_LABELS.gitea).toBe("Pocket ID");
  });

  it("still HAS a gitea key, because the slot name is load-bearing", () => {
    // The other half, and the one a careless "fix" would break: relabelling is right, renaming the
    // key is not. Without this, a future edit could satisfy the test above by deleting the entry.
    expect(Object.keys(LOGIN_MEDIUM_LABELS)).toContain("gitea");
  });

  it("names no provider Gitea anywhere else in the label map", () => {
    expect(Object.values(LOGIN_MEDIUM_LABELS).filter((l) => GITEA_LABEL.test(l))).toEqual([]);
  });

  it("leaves no user-facing Gitea string in any shipped app or package", () => {
    const hits = SCANNED.flatMap(giteaLabelsUnder);
    expect(hits, `user-facing Gitea strings:\n${hits.join("\n")}`).toEqual([]);
  });

  it("scans trees that actually exist, so a rename cannot make it pass blindly", () => {
    // The hole this kind of check falls into: a moved directory makes the scan return nothing and
    // the assertion above passes while proving nothing. readdirSync throws on a missing path, so
    // this fails loudly instead.
    for (const dir of SCANNED) expect(() => readdirSync(join(REPO_ROOT, dir)), dir).not.toThrow();
  });
});
