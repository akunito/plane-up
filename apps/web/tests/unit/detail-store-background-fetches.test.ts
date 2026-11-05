/**
 * L1-19 — every secondary fetch in the work-item detail store is wrapped in background()
 * (APLANE-29).
 *
 * `fetchIssue` and `fetchIssueWithIdentifier` are near-duplicates, and the first fix wrapped only
 * one of them. The flake survived the deploy and pointed at the other one itself, through the
 * identifier endpoint in its error message (`/work-items/QAB-2/?expand=…`).
 *
 * This reads the source on purpose, because that is where the mistake lives. A behavioural test of
 * either function needs the whole root store mocked, and it still would not notice a third copy of
 * the pattern appearing later — which is the failure mode that actually happened. So the assertion
 * is about the shape of the code: if you add a secondary fetch, it has to be wrapped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Resolved from cwd, not from import.meta.url: under jsdom that URL is http://localhost/..., and
// readFileSync rejects it with "The URL must be of scheme file". Tried from apps/web (where
// vitest.config.ts lives, so the usual cwd) and from the repo root, so it does not depend on where
// the runner was invoked.
const RELATIVE = join("core", "store", "issue", "issue-details", "issue.store.ts");
const CANDIDATES = [join(process.cwd(), RELATIVE), join(process.cwd(), "apps", "web", RELATIVE)];
const STORE_PATH = CANDIDATES.find(existsSync);
if (!STORE_PATH) throw new Error(`issue.store.ts not found; looked in:\n  ${CANDIDATES.join("\n  ")}`);
const SOURCE = readFileSync(STORE_PATH, "utf8");

/** The fire-and-forget section fetches: all 404 at once when the work item has just been deleted. */
const SECONDARY_FETCHES = [
  "fetchActivities",
  "fetchComments",
  "fetchSubIssues",
  "fetchRelations",
  "fetchProjectStates",
] as const;

/** Lines that call one of them, with their 1-based numbers, excluding the import and comments. */
const callSites = (name: string) =>
  SOURCE.split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => text.includes(`.${name}(`) && !text.startsWith("//") && !text.startsWith("*"));

describe("work-item detail store: secondary fetches are guarded (L1-19)", () => {
  it.each(SECONDARY_FETCHES)("every %s call is wrapped in background() or awaited", (name) => {
    const unguarded = callSites(name).filter(({ text }) => !text.includes("background(") && !text.includes("await "));

    expect(unguarded, `unwrapped ${name} call(s) — an unhandled rejection when the work item is gone`).toEqual([]);
  });

  it("finds both copies of the pattern, so a deleted call cannot pass as a fixed one", () => {
    // fetchIssue and fetchIssueWithIdentifier each carry all five
    for (const name of SECONDARY_FETCHES) expect(callSites(name).length, name).toBeGreaterThanOrEqual(2);
  });

  it("both parent-item retrieves are wrapped too", () => {
    // `.retrieve(...).then(...)` with no catch was the sixth leak in each function
    const floatingThen = SOURCE.split("\n")
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(({ text }) => text.includes(".retrieve(") && text.includes(".then("))
      .filter(({ line }) => {
        // the wrap sits on the line above: background(\n  this.issueService.retrieve(...)
        const previous = SOURCE.split("\n")[line - 2] ?? "";
        return !previous.includes("background(");
      });

    expect(floatingThen, "a .retrieve().then() with no background() leaks on a 404").toEqual([]);
  });
});
