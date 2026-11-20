// Phase 6: the app opens offline from its last snapshot, keeps every tap, never sends before it knows who
// is signed in, and starts again in full when the connection returns.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueue, makeLock, newUuid } from "@plane/inventory";
import { App } from "../src/app";
import { Controller } from "../src/controller";
import { memorySnapshots, memoryStore, prefs } from "../src/store";
import type { AppStore, SnapshotStore } from "../src/store";
import { FakeApi, GROCERIES, ME, state, uid } from "./fake-api";

const MILK = uid();
let api: FakeApi;
let offline = false;
let snapshots: SnapshotStore;
let stores: Map<string, AppStore>;
/** Someone else signed in on the device: settings and lists answer for them. `gate` holds the lists answer. */
let person: { id: string; display_name: string } | null = null;
let listsGate: Promise<void> | null = null;
let listsOffline = false;
let listsAsked = 0;
/** How the workspace lists answer for `person`: refused (a guest) or with no lists. */
let listsAs: "403" | "empty" | null = null;
const OTHER = { id: "00000000-0000-4000-8000-0000000000ff", display_name: "Other" };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fetchImpl: typeof fetch = async (input, init) => {
  if (offline) throw new TypeError("Failed to fetch");
  const path = String(input);
  if (path.endsWith("/inventory/lists/") && !path.includes("/projects/")) {
    listsAsked++;
    if (listsOffline) throw new TypeError("Failed to fetch");
    if (listsGate) await listsGate;
  }
  const res = await api.fetch(input, init);
  if (!person) return res;
  if (listsAs && path.endsWith("/inventory/lists/") && !path.includes("/projects/")) {
    if (listsAs === "403")
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    return json({ ...(await res.json()), me: person, lists: [] });
  }
  if (path.endsWith("/api/users/me/settings/")) return json({ ...(await res.json()), id: person.id });
  if (path.endsWith("/inventory/lists/") && !path.includes("/projects/"))
    return json({ ...(await res.json()), me: person });
  return res;
};

function make(): Controller {
  return new Controller({
    base: "",
    fetchImpl,
    lock: makeLock(undefined),
    snapshots,
    openStore: async (userId, workspace) => {
      const key = `${userId}:${workspace}`;
      if (!stores.has(key)) stores.set(key, memoryStore(createQueue(userId, newUuid())));
      return stores.get(key)!;
    },
  });
}

/** Lets the controller's debounced snapshot write happen. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 350)));
const opsSent = () => api.calls.filter((c) => c.path.endsWith("/inventory/ops/")).length;

beforeEach(() => {
  window.location.hash = "#/";
  localStorage.clear();
  offline = false;
  person = null;
  listsGate = null;
  listsOffline = false;
  listsAsked = 0;
  listsAs = null;
  snapshots = memorySnapshots();
  stores = new Map();
  api = new FakeApi([{ state: state(MILK, "on_demand", { needed: true }), data: { name: "Milk", list: GROCERIES } }]);
});
afterEach(() => cleanup());

describe("offline start", () => {
  it("opens from the last snapshot, says so, keeps a tap, and sends it once back online", async () => {
    const first = make();
    await first.start();
    await settle();
    expect(prefs.get("user")).toBe(ME.id);

    offline = true;
    const c = make();
    await c.start();
    expect(c.get().phase).toBe("ready");
    expect(c.get().offlineSince).not.toBeNull();
    render(<App controller={c} locale="en" />);
    expect(screen.getByText(/No connection: this is the list from/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(c.get().queue.entries).toHaveLength(1));
    expect(opsSent()).toBe(0);

    offline = false;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    c.attach(window);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(c.get().queue.entries).toHaveLength(0));
    expect(opsSent()).toBe(1);
    expect(c.get().offlineSince).toBeNull();
  });

  it("without a snapshot for the last user and workspace, offline ends on the error screen", async () => {
    offline = true;
    const c = make();
    await c.start();
    expect(c.get().phase).toBe("error");
  });

  it("a sign-out is not an offline start: the person must sign in again", async () => {
    const first = make();
    await first.start();
    await settle();
    api.fail = { status: 401, json: { detail: "no" } };
    const c = make();
    await c.start();
    expect(c.get().phase).toBe("signed_out");
  });

  /** Started once online as Ana (snapshot saved), then opened offline with one tap of hers waiting. */
  async function offlineWithTap(): Promise<Controller> {
    const first = make();
    await first.start();
    await settle();
    offline = true;
    const c = make();
    await c.start();
    await act(async () => {
      await c.act("buy", MILK, {}, { tick: true });
    });
    expect(c.get().queue.entries).toHaveLength(1);
    return c;
  }

  it("another person signed in when the connection returns: a tap, poll or flush during the restart sends nothing as them", async () => {
    const c = await offlineWithTap();
    const before = await snapshots.load(ME.id, "home");
    offline = false;
    person = OTHER;
    let release!: () => void;
    listsGate = new Promise((r) => (release = r));
    const asked = listsAsked;
    void c.refresh(); // the reconnect starts, and waits on the lists answer
    await waitFor(() => expect(listsAsked).toBeGreaterThan(asked));
    // Inside the window the audit found: the store is still Ana's, the screen still "ready".
    void c.flush();
    void c.refresh();
    await act(async () => {
      await c.act("buy", MILK, {}, { tick: true }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(opsSent()).toBe(0);
    release();
    await waitFor(() => expect(c.get().lists?.me.id).toBe(OTHER.id));
    await settle();
    expect(opsSent()).toBe(0);
    expect((await stores.get(`${ME.id}:home`)!.read()).entries.length).toBeGreaterThanOrEqual(1);
    // Ana's snapshot is still hers, and the other person's was saved under their own key.
    expect((await snapshots.load(ME.id, "home"))?.savedAt).toBe(before?.savedAt);
    expect((await snapshots.load(OTHER.id, "home"))?.userId).toBe(OTHER.id);
    expect(c.get().offlineSince).toBeNull();
  });

  it("a person who just signed in and then lost the network is not shown the previous person's snapshot", async () => {
    const first = make();
    await first.start();
    await settle();
    person = OTHER; // settings answers for them
    listsOffline = true; // then the network drops
    const c = make();
    await c.start();
    expect(c.get().phase).toBe("error");
    expect(c.get().lists).toBeNull();
  });

  it("the network is back but the session is gone: sign in, and the device forgets who used it", async () => {
    const c = await offlineWithTap();
    offline = false;
    api.fail = { status: 401, json: { detail: "no" } };
    await act(async () => {
      await c.refresh();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(c.get().phase).toBe("signed_out"));
    expect(prefs.get("user")).toBeNull();
    // Her tap stays stored for when she signs in again.
    expect((await stores.get(`${ME.id}:home`)!.read()).entries).toHaveLength(1);
  });

  for (const as of ["403", "empty"] as const) {
    it(`another person whose start ends on ${as === "403" ? "no access" : "no inventory"}: a focus afterwards sends nothing`, async () => {
      const c = await offlineWithTap();
      offline = false;
      person = OTHER;
      listsAs = as;
      await act(async () => {
        await c.refresh();
        await new Promise((r) => setTimeout(r, 100));
      });
      await waitFor(() => expect(c.get().phase).toBe(as === "403" ? "no_access" : "no_inventory"));
      await act(async () => {
        await c.flush();
        await c.refresh();
      });
      expect(opsSent()).toBe(0);
      expect((await stores.get(`${ME.id}:home`)!.read()).entries).toHaveLength(1);
    });
  }

  it("a signed-out answer to a refresh, not only at the start, makes the device forget who used it", async () => {
    const c = make();
    await c.start();
    await settle();
    expect(prefs.get("user")).toBe(ME.id);
    api.fail = { status: 401, json: { detail: "no" } };
    await act(async () => {
      await c.refresh();
    });
    expect(prefs.get("user")).toBeNull();
  });
});
