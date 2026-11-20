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

const fetchImpl: typeof fetch = async (input, init) => {
  if (offline) throw new TypeError("Failed to fetch");
  return api.fetch(input, init);
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

  it("another person signed in when the connection returns: the first one's queue is not sent as them", async () => {
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
    // Back online as someone else: the lists endpoint answers for another user.
    offline = false;
    const other = { id: "00000000-0000-4000-8000-0000000000ff", display_name: "Other" };
    const real = api.fetch;
    api.fetch = async (input, init) => {
      const res = await real(input, init);
      if (!String(input).endsWith("/inventory/lists/")) return res;
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, me: other }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await act(async () => {
      await c.refresh();
    });
    expect(c.get().lists?.me.id).toBe(other.id);
    expect(opsSent()).toBe(0);
    expect((await stores.get(`${ME.id}:home`)!.read()).entries).toHaveLength(1);
  });
});
