/**
 * L1-18 — the work-item detail view's secondary fetches never leak an unhandled rejection
 * (APLANE-29).
 *
 * `fetchIssue` fires activities, comments, sub-issues, relations, project states and the parent
 * item without awaiting them. With no catch, each one becomes an unhandled rejection, and when the
 * work item has just been deleted they all 404 together — an unhandled rejection either way.
 *
 * CORRECTED 2026-11-05: this is NOT what made the iPhone E2E project fail. WebKit reports the abandoned load itself as a page error (verified: playwright-core turns any
 * javascript-source console error into one), which NO `.catch` can suppress — that symptom is
 * handled in the E2E guard, not here. These rejections are a separate, real latent defect:
 * worth fixing on their own merits, but they were never the cause of the L5 flake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { background } from "@/store/issue/issue-details/background";

/** Collect node-level unhandled rejections for the duration of a test. */
const rejections: unknown[] = [];
const record = (reason: unknown) => void rejections.push(reason);

/** One macrotask is enough for node to decide a rejection was not handled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  rejections.length = 0;
  process.on("unhandledRejection", record);
});

afterEach(() => {
  process.off("unhandledRejection", record);
});

describe("background()", () => {
  it("swallows a rejection instead of leaking it", async () => {
    background(Promise.reject(new Error("404")));

    await settle();

    expect(rejections).toEqual([]);
  });

  /**
   * The control. Without it the test above passes even if `background` were a no-op, or if this
   * environment simply never reported unhandled rejections — which would make the whole file
   * decorative.
   */
  it("and the same rejection DOES leak without it, so this test can fail", async () => {
    void Promise.reject(new Error("404"));

    await settle();

    expect(rejections).toHaveLength(1);
    expect((rejections[0] as Error).message).toBe("404");
  });

  it("leaves a resolving promise alone", async () => {
    const onward = vi.fn();
    const promise = Promise.resolve("ok").then(onward);

    background(promise);
    await promise;

    expect(onward).toHaveBeenCalledWith("ok");
    expect(rejections).toEqual([]);
  });

  it("ignores a non-promise, because not every store action returns one", async () => {
    expect(() => background(undefined)).not.toThrow();
    expect(() => background("not a promise")).not.toThrow();
    expect(() => background(null)).not.toThrow();

    await settle();

    expect(rejections).toEqual([]);
  });

  it("handles several failing fetches at once, which is the real case", async () => {
    // a deleted work item 404s every section fetch in the same tick
    for (const section of ["activities", "comments", "sub-issues", "relations", "states", "parent"])
      background(Promise.reject(new Error(`404 ${section}`)));

    await settle();

    expect(rejections).toEqual([]);
  });
});
