/**
 * L1-22 — a failed request always throws something truthy and structured (APLANE-36).
 *
 * Every service method in this repo ends in `throw error?.response?.data`. With no response —
 * connection dropped, server restarting, proxy closing the socket — that threw `undefined`, and
 * the consumer's `catch` had nothing to test: the sign-in button did nothing, an archived work
 * item rendered blank, and the work-item page sat on its skeleton for ever (APLANE-35).
 *
 * The fix is one interceptor per APIService, so the ~380 service methods are untouched. The tests
 * that matter here are the two negative ones: the payload must carry NO prose (181 call sites do
 * `error?.error ?? t("translated")`, and filling `error` would replace every one of those with an
 * English string from the service layer), and a CANCELLED request must stay exactly as it was.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import axios, { AxiosError, CanceledError } from "axios";
import { afterEach, describe, expect, it } from "vitest";

import { APIService, ensureErrorPayload } from "@/services/api.service";

/** What a service does with whatever the interceptor rejected. */
const whatTheServiceThrows = (error: unknown) => (ensureErrorPayload(error) as any)?.response?.data;

const axiosNetworkError = () => ({ message: "Network Error", code: "ERR_NETWORK", config: { url: "/api/x" } });
const axiosTimeout = () => ({ message: "timeout of 0ms exceeded", code: "ECONNABORTED", config: {} });
const axiosCancel = () => new CanceledError("canceled");
const axiosResponse = (status: number, data: unknown) => ({
  message: `Request failed`,
  code: "ERR_BAD_REQUEST",
  response: { status, data },
});

describe("ensureErrorPayload (L1-22)", () => {
  it("turns a response-less failure into a truthy payload", () => {
    const thrown = whatTheServiceThrows(axiosNetworkError());

    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(0);
    expect(thrown.isRequestFailure).toBe(true);
    expect(thrown.axiosCode).toBe("ERR_NETWORK");
  });

  it("and WITHOUT it the same service line throws undefined, so this test can fail", () => {
    // The control: the bug, reproduced in one line.
    const error: any = axiosNetworkError();
    expect(error?.response?.data).toBeUndefined();
  });

  it("carries no error/message/detail, so every translated fallback still wins", () => {
    const thrown = whatTheServiceThrows(axiosNetworkError());

    // The one assertion that protects 181 `error?.error ?? t("…")` call sites.
    expect(thrown.error).toBeUndefined();
    expect(thrown.message).toBeUndefined();
    expect(thrown.detail).toBeUndefined();
    // A Set, so this needs neither `.sort()` (unicorn/no-array-sort) nor `.toSorted()` (ES2023,
    // outside this app's configured lib — the gate's typecheck caught that one).
    expect(new Set(Object.keys(thrown))).toEqual(new Set(["axiosCode", "isRequestFailure", "isTimeout", "status"]));
  });

  it("marks a timeout", () => {
    expect(whatTheServiceThrows(axiosTimeout()).isTimeout).toBe(true);
    expect(whatTheServiceThrows(axiosNetworkError()).isTimeout).toBe(false);
  });

  it("leaves a real API error body completely alone", () => {
    const body = { error: "You do not have permission", status: 403 };
    const error = axiosResponse(403, body);

    expect(ensureErrorPayload(error)).toBe(error);
    expect(whatTheServiceThrows(error)).toBe(body);
  });

  it("leaves DRF field errors alone, including their shape", () => {
    const body = { name: ["This field may not be blank."] };

    expect(whatTheServiceThrows(axiosResponse(400, body))).toEqual(body);
  });

  it.each([
    ["an empty string, which is what a bodyless 502 leaves", ""],
    ["undefined", undefined],
    ["null", null],
  ])("replaces a falsy body (%s) but keeps the real status", (_label, body) => {
    const thrown = whatTheServiceThrows(axiosResponse(502, body));

    expect(thrown.isRequestFailure).toBe(true);
    expect(thrown.status).toBe(502);
  });

  it("treats an object that merely LOOKS like a cancellation as a real failure", () => {
    // axios marks real cancellations with `__CANCEL__`, and that is what `isCancel` reads — a
    // literal carrying only `code`/`name` is not one. Pinned because the first version of this
    // guard matched those strings by hand, and moving to axios' own isCancel silently changed
    // this case. The gate caught it; nothing local could.
    expect(whatTheServiceThrows({ code: "ERR_CANCELED", name: "CanceledError" }).isRequestFailure).toBe(true);
  });

  it("does NOT touch a cancelled request", () => {
    const cancelled = axiosCancel();

    expect(ensureErrorPayload(cancelled)).toBe(cancelled);
    // Still inert downstream, deliberately: navigating away mid-request must not raise an error
    // state in the UI that was never there before.
    expect(whatTheServiceThrows(cancelled)).toBeUndefined();
  });

  it("never throws on something that is not an axios error", () => {
    for (const odd of ["boom", 0, null, undefined, false]) {
      expect(() => ensureErrorPayload(odd)).not.toThrow();
    }
    expect(whatTheServiceThrows("boom").isRequestFailure).toBe(true);
  });

  it("leaves a `response` in place for the one service that reads it without optional chaining", () => {
    // Census 2026-11-06: exactly one `throw error.response.data` (issue.service.ts:466) and it is
    // already guarded by its own `if`, so it never raised a TypeError. An earlier version of this
    // test claimed five unguarded sites; that number came from counting comment and test lines.
    const error: any = ensureErrorPayload(axiosNetworkError());

    expect(() => error.response.data).not.toThrow();
    expect(error.response.status).toBe(0);
  });

  it("gives the 79 `throw error?.response` services a truthy response too", () => {
    // They used to throw `undefined`. Their consumers read `err?.data?.error ?? t(…)` and
    // `err.status === 429 | 400`; `status: 0` matches neither, and `data` carries the flags.
    const thrown = (ensureErrorPayload(axiosNetworkError()) as any)?.response;

    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(0);
    expect(thrown.data.isRequestFailure).toBe(true);
  });
});

/**
 * Upstream keeps two copies of APIService, and a fix to one of them is invisible in the other —
 * which is how the fork has been bitten before. This pins both.
 */
describe("both APIService copies normalise their rejections (L1-22)", () => {
  const CANDIDATES = [
    ["apps/web", join("core", "services", "api.service.ts"), join("apps", "web", "core", "services", "api.service.ts")],
    [
      "packages/services",
      join("..", "..", "packages", "services", "src", "api.service.ts"),
      join("packages", "services", "src", "api.service.ts"),
    ],
  ] as const;

  const read = (relative: string, fromRoot: string) => {
    const path = [join(process.cwd(), relative), join(process.cwd(), fromRoot)].find(existsSync);
    if (!path) throw new Error(`api.service.ts not found for ${relative}`);
    return readFileSync(path, "utf8");
  };

  it.each(CANDIDATES)("%s rejects through ensureErrorPayload", (_name, relative, fromRoot) => {
    const source = read(relative, fromRoot);

    expect(source).toMatch(/interceptors\.response\.use/);
    // Either form: the web copy rejects inside the existing 401 interceptor, the packages copy
    // throws from an async handler (identical rejection, and it keeps that package inside its
    // 6-warning lint budget).
    expect(source).toMatch(/(?:Promise\.reject\(|throw )ensureErrorPayload\(error\)/);
  });

  it("and the two helpers have not drifted apart", () => {
    const helperOf = (source: string) => {
      const start = source.indexOf("export type TRequestFailurePayload");
      const end = source.indexOf("export abstract class APIService");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source
        .slice(start, end)
        .replace(/\/\*\*[\s\S]*?\*\//g, "")
        .trim();
    };

    const [web, pkg] = CANDIDATES.map(([, relative, fromRoot]) => helperOf(read(relative, fromRoot)));
    expect(web).toBe(pkg);
  });
});

/**
 * Through the real axios instance, so the interceptor itself is exercised rather than the helper
 * in isolation — and against axios' own `AxiosError`/`CanceledError` classes instead of the
 * hand-written literals above, which is what the cancel guard actually has to recognise.
 */
describe("the interceptor on a real axios instance (L1-22)", () => {
  class Probe extends APIService {
    constructor() {
      super("/api");
    }

    /** Exactly what a service method does. */
    hit() {
      return this.get("/anything").catch((error: any) => {
        throw error?.response?.data;
      });
    }
  }

  const original = axios.defaults.adapter;

  afterEach(() => {
    axios.defaults.adapter = original;
  });

  it("turns a response-less rejection into a truthy throw", async () => {
    axios.defaults.adapter = async (config) => {
      throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config as any);
    };

    await expect(new Probe().hit()).rejects.toMatchObject({ isRequestFailure: true, status: 0 });
  });

  it("and leaves a cancellation inert, so navigating away raises no error state", async () => {
    axios.defaults.adapter = async () => {
      throw new CanceledError("canceled");
    };

    // `undefined` is what the service throws for a cancel, exactly as before this change.
    await expect(new Probe().hit()).rejects.toBeUndefined();
  });
});
