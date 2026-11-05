/**
 * L1-20 — a failed work-item fetch must produce a TRUTHY error (APLANE-35).
 *
 * `retrieveWithIdentifier` ended in `throw error?.response?.data`, which is `undefined` for any
 * network-level failure: an aborted request, a dropped connection, DNS, a proxy hiccup. SWR then
 * stored a falsy error, so the browse page's `if (error && !isLoading)` never fired and its
 * `issueLoader = !issue || isLoading` stayed true — the user sat on the skeleton loader for ever,
 * with no error, no retry and nothing to click, until a manual reload.
 *
 * This is the same fork insight already acted on in pinned-entity.service.ts, which keeps the HTTP
 * status precisely because Plane's services throw `error.response.data` and destroy it. Every
 * service in the app has this shape, so this test guards one instance of a class.
 */
import { describe, expect, it, vi } from "vitest";

import { IssueService } from "@/services/issue/issue.service";

/** Drive the service's own catch by making its underlying GET reject the way axios does. */
const failing = (rejection: unknown) => {
  const service = new IssueService();
  vi.spyOn(service as unknown as { get: (...args: unknown[]) => Promise<unknown> }, "get").mockRejectedValue(
    rejection
  );
  return service;
};

const fetch = (service: IssueService) => service.retrieveWithIdentifier("ws", "QAA", "2");

describe("retrieveWithIdentifier error mapping (L1-20)", () => {
  it("throws something truthy when there is no response at all", async () => {
    // axios shape for a network error: no `response`, only a message
    const service = failing({ message: "Network Error" });

    await expect(fetch(service)).rejects.toBeTruthy();
  });

  it("and the thrown value carries the reason, not just truthiness", async () => {
    const service = failing({ message: "Network Error" });

    await expect(fetch(service)).rejects.toThrow("Network Error");
  });

  it("falls back to a readable message when even that is missing", async () => {
    const service = failing({});

    await expect(fetch(service)).rejects.toThrow("The work item could not be loaded");
  });

  // A regression guard, not a reproducer: this passes against the parent commit too, which is the
  // point — the payload path must be byte-identical to what callers already relied on.
  it("still throws the server's payload when there IS a response, so callers see what they saw", async () => {
    const payload = { error: "Issue not found", code: 4001 };
    const service = failing({ response: { status: 404, data: payload } });

    await expect(fetch(service)).rejects.toBe(payload);
  });

  it("does not throw a falsy payload — an empty error body used to reproduce the same bug", async () => {
    const service = failing({ response: { status: 500, data: "" }, message: "Request failed" });

    await expect(fetch(service)).rejects.toBeTruthy();
  });

  /**
   * The control. Without it every assertion above would also pass against a service that rejected
   * with a plain string, and the point of the fix is specifically that `undefined` can no longer
   * come out of here.
   */
  it("never rejects with undefined or null, whatever shape the failure takes", async () => {
    for (const rejection of [undefined, null, {}, { message: "" }, { response: {} }, { response: { data: null } }]) {
      const thrown = await fetch(failing(rejection)).catch((error) => error);

      expect(thrown, `rejection ${JSON.stringify(rejection)} produced a falsy error`).toBeTruthy();
    }
  });
});


/**
 * L1-21 — the browse page's empty state must NOT be keyed on SWR's `error` (APLANE-35).
 *
 * A source-text contract, because this is about the shape of a condition and a behavioural test
 * would need the whole page mocked. SWR's failure path sets `error` and leaves `data` in place, and
 * WEB_SWR_CONFIG enables revalidateOnFocus everywhere — so an `error ||` in that condition turns a
 * single failed focus revalidation into a full-page "work item does not exist" over a work item
 * that is loaded and on screen. Making the service throw a truthy error (the fix above) is exactly
 * what makes that reachable, so the two changes have to stay consistent.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RELATIVE = join("app", "(all)", "[workspaceSlug]", "(projects)", "browse", "[workItem]", "page.tsx");
const CANDIDATES = [join(process.cwd(), RELATIVE), join(process.cwd(), "apps", "web", RELATIVE)];

describe("browse page empty-state condition (L1-21)", () => {
  const path = CANDIDATES.find(existsSync);

  it("the page is where we think it is", () => {
    expect(path, `browse page not found; looked in:\n  ${CANDIDATES.join("\n  ")}`).toBeTruthy();
  });

  it("keys the empty state on settled-with-no-data, not on the error object", () => {
    const source = readFileSync(path!, "utf8");
    const conditions = source
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => text.startsWith("if (") && text.includes("isLoading"));

    expect(conditions, "the guarded condition disappeared — did the page get rewritten?").not.toEqual([]);
    for (const condition of conditions)
      expect(condition, "an error-keyed empty state nukes a loaded page on a transient revalidation").not.toMatch(
        /\berror\b/
      );
  });
});
