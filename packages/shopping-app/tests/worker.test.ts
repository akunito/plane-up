// The service worker's logic (src/worker-core.ts). Its build helper is tested in apps/web (Node).
import { describe, expect, it } from "vitest";
import type { QueueState } from "@plane/inventory";
import { createQueue, makeLock, refreshed, tap } from "@plane/inventory";
import { memoryStore } from "../src/store";
import type { AppStore } from "../src/store";
import { expectedType, precacheProblem, sendQueues, SHELL_MARKER } from "../src/worker-core";
import { state } from "./fake-api";

const SHELL = `<html><head><meta ${SHELL_MARKER} content="1"></head></html>`;
const respond = (status: number, type: string, body = "", extra: Partial<Response> = {}) =>
  Object.assign(new Response(body, { status, headers: type ? { "content-type": type } : {} }), extra);

describe("precache refuses what M1 serves for a missing file", () => {
  it("knows each file's type, the scope URL being the shell", () => {
    expect(expectedType("/shopping/", "/shopping/")).toBe("text/html");
    expect(expectedType("/shopping/assets/x.js", "/shopping/")).toBe("javascript");
    expect(expectedType("/shopping/manifest.json", "/shopping/")).toBe("json");
    expect(expectedType("/shopping/what.bin", "/shopping/")).toBe("");
  });

  it("refuses the main app's HTML for a script, the main app's page for the shell, a redirect, an error", async () => {
    const js = "/shopping/assets/x.js";
    expect(await precacheProblem(js, respond(200, "application/javascript"), "/shopping/")).toBeNull();
    expect(await precacheProblem(js, respond(200, "text/html", "<html>main</html>"), "/shopping/")).toMatch(
      /expected javascript/
    );
    expect(
      await precacheProblem("/shopping/", respond(200, "text/html; charset=utf-8", SHELL), "/shopping/")
    ).toBeNull();
    expect(
      await precacheProblem("/shopping/", respond(200, "text/html", "<html>main app</html>"), "/shopping/")
    ).toMatch(/marker/);
    expect(await precacheProblem(js, respond(404, "application/javascript"), "/shopping/")).toMatch(/404/);
    expect(
      await precacheProblem(
        js,
        Object.defineProperty(respond(200, "application/javascript"), "redirected", { value: true }),
        "/shopping/"
      )
    ).toMatch(/redirected/);
    expect(await precacheProblem("/shopping/x.bin", respond(200, "application/octet-stream"), "/shopping/")).toMatch(
      /no known/
    );
  });
});

describe("sendQueues (background sync)", () => {
  const ANA = "00000000-0000-4000-8000-0000000000a1";
  const BO = "00000000-0000-4000-8000-0000000000b2";
  const item = state("30000000-0000-4000-8000-000000000001", "on_demand");

  const queueWithTap = (userId: string, failure: QueueState["failure"] = null): QueueState => {
    let q = refreshed(createQueue(userId, "q-" + userId), [item]);
    q = tap(q, "set_needed", item.id, { needed: true }, { now: Date.now(), newId: () => crypto.randomUUID() });
    return { ...q, failure };
  };

  function setup(me: { status: number; id?: string } | "offline", ops: "ok" | "offline" | 503 = "ok") {
    const stores = new Map<string, AppStore>([
      [`${ANA}:home`, memoryStore(queueWithTap(ANA, { kind: "offline", attempts: 3, nextTryAt: Date.now() + 60_000 }))],
      [`${BO}:home`, memoryStore(queueWithTap(BO))],
    ]);
    const sent: { url: string; body: { ops: { client_op_id: string; queue_id: string }[] } }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/users/me/")) {
        if (me === "offline") throw new TypeError("offline");
        return respond(me.status, "application/json", JSON.stringify(me.id ? { id: me.id } : { detail: "no" }));
      }
      if (url.endsWith("/inventory/ops/")) {
        if (ops === "offline") throw new TypeError("offline");
        if (ops === 503) return respond(503, "text/html", "down");
        const body = JSON.parse(String(init.body));
        sent.push({ url, body });
        return respond(
          200,
          "application/json",
          JSON.stringify({
            results: body.ops.map((o: { client_op_id: string }) => ({
              client_op_id: o.client_op_id,
              result: "applied",
              rev: 1,
            })),
          })
        );
      }
      return respond(404, "application/json", "{}");
    }) as unknown as typeof fetch;
    const deps = {
      fetchImpl,
      base: "",
      listQueues: async () =>
        [...stores.keys()].map((k) => ({ userId: k.split(":")[0]!, workspace: k.split(":")[1]! })),
      openStore: async (userId: string, workspace: string) => stores.get(`${userId}:${workspace}`)!,
      lock: makeLock(undefined),
      now: Date.now,
    };
    return { deps, stores, sent };
  }

  it("sends only the queue of the person signed in now, past its backoff (the network is back)", async () => {
    const { deps, stores, sent } = setup({ status: 200, id: ANA });
    expect(await sendQueues(deps)).toEqual({ kind: "sent", waiting: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/api/workspaces/home/inventory/ops/");
    expect(sent[0]!.body.ops[0]!.queue_id).toBe(`q-${ANA}`);
    expect((await stores.get(`${BO}:home`)!.read()).entries).toHaveLength(1);
  });

  it("signed out: nothing is sent, and the browser need not retry", async () => {
    const { deps, sent } = setup({ status: 401 });
    expect(await sendQueues(deps)).toEqual({ kind: "nothing" });
    expect(sent).toHaveLength(0);
  });

  it("no network or a failing server: the browser should fire the sync again", async () => {
    expect(await sendQueues(setup("offline").deps)).toEqual({ kind: "retry" });
    expect(await sendQueues(setup({ status: 200, id: ANA }, "offline").deps)).toEqual({ kind: "retry" });
    expect(await sendQueues(setup({ status: 200, id: ANA }, 503).deps)).toEqual({ kind: "retry" });
  });

  it("a queue held by the two-hour rule waits for the person and does not make the browser retry", async () => {
    const { deps, stores, sent } = setup({ status: 200, id: ANA });
    const old = queueWithTap(ANA);
    old.entries = old.entries.map((e) => ({ ...e, tappedAt: Date.now() - 3 * 60 * 60 * 1000 }));
    stores.set(`${ANA}:home`, memoryStore(old));
    expect(await sendQueues(deps)).toEqual({ kind: "sent", waiting: 1 });
    expect(sent).toHaveLength(0);
  });
});
