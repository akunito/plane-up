// M4's three cases (measured on dev and with curl, brief "Measured in phase 0").

import { describe, expect, it } from "vitest";

import { sendOps } from "../src/client";

const respond = (init: { status: number; json?: unknown; type?: ResponseType; html?: boolean }) =>
  (async () => {
    const body = init.json !== undefined ? JSON.stringify(init.json) : "<html></html>";
    const r = new Response(init.status === 0 ? null : body, {
      status: init.status === 0 ? 200 : init.status,
      headers: { "content-type": init.json !== undefined ? "application/json" : "text/html" },
    });
    if (init.type) Object.defineProperty(r, "type", { value: init.type });
    if (init.status === 0) Object.defineProperty(r, "status", { value: 0 });
    return r;
  }) as unknown as typeof fetch;

const opts = (fetchImpl: typeof fetch) => ({ base: "", slug: "home", fetchImpl });

describe("sendOps", () => {
  it("returns the results", async () => {
    const out = await sendOps(
      opts(respond({ status: 200, json: { results: [{ client_op_id: "a", result: "applied" }] } })),
      []
    );
    expect(out).toEqual({ kind: "ok", results: [{ client_op_id: "a", result: "applied" }] });
  });

  it.each([
    [{ status: 401, json: { detail: "no" } }, "signed_out_app"],
    [{ status: 401, html: true }, "signed_out_proxy"],
    [{ status: 0, type: "opaqueredirect" as ResponseType }, "signed_out_proxy"],
    [{ status: 302, html: true }, "signed_out_proxy"],
    [{ status: 502, html: true }, "server"],
    [{ status: 500, json: { error: "x" } }, "server"],
    [{ status: 200, html: true }, "server"],
  ])("%o is a failure: %s", async (init, failure) => {
    expect(await sendOps(opts(respond(init)), [])).toMatchObject({ kind: "failed", failure });
  });

  it("no answer at all is offline", async () => {
    const fail = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await sendOps(opts(fail), [])).toMatchObject({ kind: "failed", failure: "offline" });
  });

  it("a refused request (e.g. over 100 operations) says why", async () => {
    expect(await sendOps(opts(respond({ status: 400, json: { error: "at most 100" } })), [])).toEqual({
      kind: "refused",
      status: 400,
      error: "at most 100",
    });
  });

  it("asks for JSON, manual redirects and the same-origin session", async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await sendOps(opts(spy), []);
    expect(seen).toMatchObject({ method: "POST", redirect: "manual", credentials: "same-origin" });
    expect((seen!.headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");
  });
});
