// M4's three cases (measured on dev and with curl, brief "Measured in phase 0").

import { describe, expect, it } from "vitest";

import { createItem, fetchListItems, requestJson, sendOps, updateItem } from "../src/client";

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

// ---------------------------------------------------------------- the reads and online-only writes (APLANE-62)

describe("requestJson and the online-only writes", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const recording = (status: number, json?: unknown, contentType = "application/json") =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify(json ?? {}), {
        status,
        headers: status === 204 ? {} : { "content-type": contentType },
      });
    }) as unknown as typeof fetch;

  it("a 204 is success with no body, not a server failure", async () => {
    expect(await requestJson(opts(recording(204)), "DELETE", "x/")).toEqual({ kind: "ok", body: null, status: 204 });
  });

  it("follows the queue's failure rules: 401 JSON signed out, 5xx server, network error offline", async () => {
    expect(await requestJson(opts(recording(401, { detail: "no" })), "GET", "x/")).toMatchObject({
      kind: "failed",
      failure: "signed_out_app",
    });
    expect(await requestJson(opts(recording(503, {}, "text/html")), "GET", "x/")).toMatchObject({
      kind: "failed",
      failure: "server",
    });
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await requestJson(opts(offline), "GET", "x/")).toMatchObject({ kind: "failed", failure: "offline" });
  });

  it("a duplicate name comes back as a conflict carrying the existing item", async () => {
    const out = await createItem(opts(recording(409, { error: "exists", item: { id: "i1" } })), "p", "l", {
      name: "Milk",
    });
    expect(out).toEqual({ kind: "conflict", status: 409, body: { error: "exists", item: { id: "i1" } } });
  });

  it("other refusals keep their error, and nothing is retried", async () => {
    calls.length = 0;
    const out = await updateItem(opts(recording(400, { error: "invalid", field: "restock_to" })), "p", "i", {
      restock_to: 1,
    });
    expect(out).toEqual({ kind: "refused", status: 400, error: "invalid" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/workspaces/home/projects/p/inventory/items/i/");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("a list's items come with its open orders", async () => {
    const out = await fetchListItems(
      opts(recording(200, { items: [{ id: "a" }], open_orders: [{ id: "o" }] })),
      "p",
      "l"
    );
    expect(out).toEqual({ kind: "ok", items: [{ id: "a" }], open_orders: [{ id: "o" }] });
  });
});
