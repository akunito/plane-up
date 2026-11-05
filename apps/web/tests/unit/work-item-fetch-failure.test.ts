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
