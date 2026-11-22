// The service worker's logic (src/worker-core.ts). Its build helper is tested in apps/web (Node).
import { describe, expect, it } from "vitest";
import type { QueueState } from "@plane/inventory";
import { createQueue, makeLock, OP_VERSION, refreshed, tap } from "@plane/inventory";
import { memoryStore } from "../src/store";
import type { AppStore } from "../src/store";
import { StoredQueueError } from "../src/store";
import { expectedType, precacheInto, precacheProblem, sendQueues, SHELL_MARKER } from "../src/worker-core";
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

function fakeCaches(existing: string[], putFails = false) {
  const names = new Set(existing);
  const puts: string[] = [];
  const deleted: string[] = [];
  const caches = {
    has: async (n: string) => names.has(n),
    open: async (n: string) => {
      names.add(n);
      return {
        put: async (url: string) => {
          if (putFails && puts.length > 0) throw new Error("quota");
          puts.push(url);
        },
      } as unknown as Cache;
    },
    delete: async (n: string) => {
      deleted.push(n);
      return names.delete(n);
    },
  };
  return { caches, puts, deleted, names };
}

const fetchFrom = (answers: Record<string, () => Response>) => async (req: Request) => answers[req.url]!();

describe("precacheInto (the install)", () => {
  const SCOPE = "/shopping/";
  const ASSETS = ["https://x/shopping/", "https://x/shopping/assets/a.js", "https://x/shopping/icon-512.png"];
  const good: Record<string, () => Response> = {
    "https://x/shopping/": () => respond(200, "text/html", SHELL),
    "https://x/shopping/assets/a.js": () => respond(200, "text/javascript"),
    "https://x/shopping/icon-512.png": () => respond(200, "image/png"),
  };

  it("checks every file before touching any cache: one wrong answer stores nothing and deletes nothing", async () => {
    const f = fakeCaches(["plane-shopping-v1"]);
    const answers = {
      ...good,
      "https://x/shopping/icon-512.png": () => respond(200, "text/html", "<html>main</html>"),
    };
    await expect(
      precacheInto({
        fetchImpl: fetchFrom(answers),
        caches: f.caches,
        cacheName: "plane-shopping-v1",
        assets: ASSETS,
        scope: SCOPE,
      })
    ).rejects.toThrow(/icon-512.png/);
    expect(f.puts).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.names.has("plane-shopping-v1")).toBe(true);
  });

  it("refuses a list without the shell: nothing would open offline", async () => {
    const f = fakeCaches([]);
    await expect(
      precacheInto({
        fetchImpl: fetchFrom(good),
        caches: f.caches,
        cacheName: "plane-shopping-v4",
        assets: ASSETS.slice(1),
        scope: SCOPE,
      })
    ).rejects.toThrow(/shell/);
    expect(f.puts).toEqual([]);
  });

  it("stores every file when all are right", async () => {
    const f = fakeCaches([]);
    await precacheInto({
      fetchImpl: fetchFrom(good),
      caches: f.caches,
      cacheName: "plane-shopping-v2",
      assets: ASSETS,
      scope: SCOPE,
    });
    expect(new Set(f.puts)).toEqual(new Set(ASSETS));
  });

  it("storing fails half way: a cache this install created is removed, one that existed is kept", async () => {
    const fresh = fakeCaches([], true);
    await expect(
      precacheInto({
        fetchImpl: fetchFrom(good),
        caches: fresh.caches,
        cacheName: "plane-shopping-v3",
        assets: ASSETS,
        scope: SCOPE,
      })
    ).rejects.toThrow(/quota/);
    expect(fresh.deleted).toEqual(["plane-shopping-v3"]);
    const live = fakeCaches(["plane-shopping-v3"], true);
    await expect(
      precacheInto({
        fetchImpl: fetchFrom(good),
        caches: live.caches,
        cacheName: "plane-shopping-v3",
        assets: ASSETS,
        scope: SCOPE,
      })
    ).rejects.toThrow(/quota/);
    expect(live.deleted).toEqual([]);
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

  it("a queue the server refused for its format waits for the updated app: nothing sent, no retry (S25)", async () => {
    const { deps, stores, sent } = setup({ status: 200, id: ANA });
    const outdated = queueWithTap(ANA, { kind: "outdated", attempts: 1, nextTryAt: 0, opVersion: OP_VERSION });
    stores.set(`${ANA}:home`, memoryStore(outdated));
    expect(await sendQueues(deps)).toEqual({ kind: "sent", waiting: 1 });
    expect(sent).toHaveLength(0);
    expect((await stores.get(`${ANA}:home`)!.read()).failure?.kind).toBe("outdated");
  });

  it("one unreadable queue is skipped; the person's other queues are still sent", async () => {
    const { deps, stores, sent } = setup({ status: 200, id: ANA });
    stores.set(`${ANA}:work`, memoryStore(queueWithTap(ANA)));
    const open = deps.openStore;
    deps.openStore = async (userId, workspace) => {
      if (workspace === "home") throw new StoredQueueError("newer");
      return open(userId, workspace);
    };
    expect(await sendQueues(deps)).toEqual({ kind: "sent", waiting: 0 });
    expect(sent.map((x) => x.url)).toEqual(["/api/workspaces/work/inventory/ops/"]);
  });
});
