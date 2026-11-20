// The screens against the fake API: what is shown, what a tap sends, undo, dialogs, phases.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueue, makeLock, newUuid, tap } from "@plane/inventory";
import { App } from "../src/app";
import { Controller } from "../src/controller";
import { memoryStore } from "../src/store";
import type { AppStore } from "../src/store";
import { BABY, FakeApi, GROCERIES, SUPPLEMENTS, state, uid } from "./fake-api";
import type { Data } from "./fake-api";
import type { ItemState } from "@plane/inventory";

const MILK = uid();
const BREAD = uid();
const DETERGENT = uid();
const WIPES = uid();
const PROTEIN = uid();
const NAPPIES = uid();
const SALT = uid();

function catalog(): { state: ItemState; data: Data }[] {
  return [
    { state: state(MILK, "on_demand", { needed: true }), data: { name: "Milk", list: GROCERIES, category: "Dairy" } },
    {
      state: state(BREAD, "pinned", { last_bought_at: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
      data: { name: "Bread", list: GROCERIES, category: "Bakery" },
    },
    {
      state: state(DETERGENT, "level", { level: "out" }),
      data: { name: "Detergent", list: GROCERIES, category: "Cleaning" },
    },
    {
      state: state(WIPES, "units", { quantity: 1, min_quantity: 3 }),
      data: { name: "Wipes", list: BABY, category: "Baby" },
    },
    {
      state: state(PROTEIN, "units", { quantity: 0, min_quantity: 2, restock_to: 3 }),
      data: { name: "Protein", list: SUPPLEMENTS, buy_online: true },
    },
    { state: state(NAPPIES, "level", { level: "low" }), data: { name: "Nappies", list: BABY, category: "Baby" } },
    { state: state(SALT, "on_demand"), data: { name: "Salt", list: GROCERIES, category: "Pantry" } },
  ];
}

let api: FakeApi;
let controller: Controller;

async function boot(items = catalog(), hash = "#/") {
  window.location.hash = hash;
  api = new FakeApi(items);
  controller = new Controller({
    base: "",
    fetchImpl: (input, init) => api.fetch(input, init),
    lock: makeLock(undefined),
    openStore: async (userId) => memoryStore(createQueue(userId, newUuid())),
  });
  await controller.start();
  render(<App controller={controller} locale="en" />);
}

/** Wait until every request the app started has been answered and the queue is empty. */
async function settle() {
  await waitFor(() => expect(controller.get().queue.entries.length).toBe(0));
  await act(async () => {
    await controller.refresh();
  });
}

async function go(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("the to-buy list", () => {
  it("shows what is missing, grouped by category, with the counter leaving pinned rows out", async () => {
    await boot();
    // Milk, Detergent, Wipes, Nappies, Protein count; Bread is pinned.
    expect(screen.getByText("5 missing · 1 pinned")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Dairy" })).toBeTruthy();
    expect(screen.queryByText("Salt")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Cleaning" })).getByText("Out")).toBeTruthy();
    // Wipes: 1 of minimum 3 → ×2.
    const wipes = screen.getByRole("checkbox", { name: "Wipes: bought" }).closest("label")!;
    expect(wipes.textContent).toContain("×2");
    expect(wipes.textContent).toContain("1 / min 3");
  });

  it("a tick buys what the list asks for, moves the row under Done and offers Undo", async () => {
    await boot();
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Done · 1" })).toBeTruthy());
    expect(screen.queryByRole("checkbox", { name: "Wipes: bought" })).toBeNull();
    await settle();
    const buy = api.ops().find((o) => o.op === "buy")!;
    expect(buy.target).toBe(WIPES);
    expect(buy.args).toEqual({ quantity: 2 });
    expect(api.server.items.get(WIPES)!.quantity).toBe(3);
    // The toast offers Undo; it reverts what the server applied.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await settle();
    expect(api.ops().some((o) => o.op === "revert")).toBe(true);
    expect(api.server.items.get(WIPES)!.quantity).toBe(1);
    expect(screen.getByRole("checkbox", { name: "Wipes: bought" })).toBeTruthy();
  });

  it("a ticked pinned row stays under Done until Finish shopping, then comes back unticked", async () => {
    await boot();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bread: bought" }));
    await settle();
    expect(screen.queryByRole("checkbox", { name: "Bread: bought" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Bread: not bought after all" })).toBeTruthy();
    await act(async () => controller.finishShopping());
    expect(screen.getByRole("checkbox", { name: "Bread: bought" })).toBeTruthy();
  });

  it("an item bought online is marked ordered through the order dialog, and then shown On the way", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Mark Protein as ordered" }));
    const dialog = screen.getByRole("dialog", { name: "Mark Protein as ordered" });
    expect((within(dialog).getByLabelText("Quantity") as HTMLInputElement).value).toBe("3");
    fireEvent.change(within(dialog).getByLabelText("Reference (shop, order number)"), { target: { value: "A-17" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark ordered" }));
    await settle();
    const order = api.ops().find((o) => o.op === "mark_ordered")!;
    expect(order.args).toMatchObject({ quantity: 3, reference: "A-17" });
    expect(screen.getByRole("region", { name: "On the way · 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark Protein as ordered" })).toBeNull();
    // An order action has no Undo (brief: Orders).
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("Arrived asks how much came and closes the order; the stock goes up by that much", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Mark Protein as ordered" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark ordered" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Protein: the order arrived" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Quantity received"), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Arrived" }));
    await settle();
    expect(api.ops().find((o) => o.op === "arrived")!.args).toMatchObject({ quantity: 1 });
    expect(api.server.items.get(PROTEIN)!.quantity).toBe(1);
    expect(screen.queryByRole("region", { name: /On the way/ })).toBeNull();
  });

  it("marking ordered warns when the item already has an open order", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Mark Protein as ordered" }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark ordered" }));
    await settle();
    // One of three ordered: 0 at home + 1 on order is below the minimum of 2, so it is still to buy,
    // and ordering again warns.
    fireEvent.click(screen.getByRole("button", { name: "Mark Protein as ordered" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain("already has an open order");
  });

  it("grouping by urgency puts out first and pinned last", async () => {
    await boot();
    fireEvent.change(screen.getByRole("combobox", { name: /Group/ }), { target: { value: "urgency" } });
    await settle();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(["Out", "Running low", "Needed", "Pinned"]);
    expect(api.calls.some((c) => c.method === "PUT" && c.path.endsWith("/preferences/"))).toBe(true);
  });
});

describe("shopping mode", () => {
  it("hides items bought online, steps the quantity of a units row, and counts progress", async () => {
    await boot(catalog(), "#/shop");
    expect(screen.getByText("0 of 5")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Protein: bought" })).toBeNull();
    expect(screen.getByText(/Ordered online, not shown here: Protein/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wipes: one more" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    await settle();
    expect(api.ops().find((o) => o.op === "buy")!.args).toEqual({ quantity: 3 });
    expect(screen.getByText("1 of 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Finish shopping" }));
    await waitFor(() => expect(Object.keys(controller.get().queue.done)).toHaveLength(0));
  });
});

describe("quick capture", () => {
  it("finds an item and acts on it in one tap, by its mode", async () => {
    await boot(catalog(), "#/capture");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search or add an item" }), { target: { value: "sa" } });
    const needed = await screen.findByRole("button", { name: "Salt: needed" });
    expect(needed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(needed);
    await settle();
    expect(api.server.items.get(SALT)!.needed).toBe(true);
    expect(screen.getByRole("button", { name: "Salt: needed" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a slow answer to an older search never replaces the newer one", async () => {
    await boot(catalog(), "#/capture");
    const fast = api.fetch;
    api.fetch = async (input, init) => {
      // The answer for "s" arrives after the answer for "sa".
      if (String(input).endsWith("suggestions/?q=s")) await new Promise((r) => setTimeout(r, 400));
      return fast(input, init);
    };
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "s" } });
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.change(box, { target: { value: "sa" } });
    await screen.findByRole("button", { name: "Salt: needed" });
    await new Promise((r) => setTimeout(r, 500));
    // "s" matches Wipes, Detergent and others too; only Salt matches "sa".
    expect(document.querySelectorAll("[data-item]")).toHaveLength(1);
  });

  it("creates a new item into the chosen list, and offers the existing one for a duplicate", async () => {
    await boot(catalog(), "#/capture");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Oat milk" } });
    const create = await screen.findByRole("button", { name: "Create “Oat milk” and add it to the shopping" });
    fireEvent.click(screen.getByRole("button", { name: "Baby" }));
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByText("Oat milk: added to the shopping list.")).toBeTruthy());
    const created = api.calls.find((c) => c.method === "POST" && c.path.includes("/items/"))!;
    expect(created.path).toContain(BABY);
    // Shown as needed at once; a second create of the same name is refused and offers the item.
    expect(await screen.findByRole("button", { name: "Oat milk: needed" })).toBeTruthy();
    await act(async () => {
      const out = await controller.createItem(BABY, "oat MILK");
      expect(out.kind).toBe("exists");
    });
  });
});

describe("inventory", () => {
  it("shows every list with who can see it, and a recount is typed", async () => {
    await boot(catalog(), "#/inventory");
    await waitFor(() => expect(screen.getByRole("region", { name: "Supplements" })).toBeTruthy());
    expect(within(screen.getByRole("region", { name: "Supplements" })).getByText(/project Me · only you/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Groceries" })).getByText(/project Home · with Bo/)).toBeTruthy();
    // Salt is not to buy, yet the inventory lists it.
    expect(screen.getByRole("link", { name: "Open Salt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wipes: type the count, now 1" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("At home"), { target: { value: "7" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(api.server.items.get(WIPES)!.quantity).toBe(7);
  });

  it("a negative total shows 0 with the recount mark", async () => {
    const items = catalog();
    items[3]!.state.quantity = -2;
    await boot(items, "#/inventory");
    const row = (await screen.findByRole("link", { name: "Open Wipes" })).closest("[data-item]")!;
    expect(row.querySelector('[data-badge="recount"]')).toBeTruthy();
    expect(within(row as HTMLElement).getByRole("button", { name: "Wipes: type the count, now 0" })).toBeTruthy();
  });

  it("tapping the level already shown sends nothing", async () => {
    await boot(catalog(), "#/inventory");
    const out = await screen.findByRole("button", { name: "Detergent: Out" });
    expect(out.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(out);
    fireEvent.click(screen.getByRole("button", { name: "Detergent: Running low" }));
    await settle();
    expect(api.ops().map((o) => [o.op, o.args.level])).toEqual([["set_level", "low"]]);
  });

  it("the pin toggles pinned and occasional in one tap", async () => {
    await boot(catalog(), "#/inventory");
    fireEvent.click(await screen.findByRole("button", { name: "Bread: unpin" }));
    await settle();
    expect(api.server.items.get(BREAD)!.mode).toBe("on_demand");
    expect(screen.getByRole("button", { name: "Bread: pin" })).toBeTruthy();
  });
});

describe("item sheet", () => {
  it("changing to units asks how many are at home", async () => {
    await boot(catalog(), `#/item/${SALT}`);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Salt" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Track Salt as: Units" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("How many are at home now?"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    const change = api.ops().find((o) => o.op === "change_mode")!;
    expect(change.args).toEqual({ mode: "units", quantity: 2 });
  });

  it("a data field saves when it is left, online, never through the queue", async () => {
    await boot(catalog(), `#/item/${SALT}`);
    const field = await screen.findByLabelText("Category / aisle");
    fireEvent.change(field, { target: { value: "Spices" } });
    fireEvent.blur(field);
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ category: "Spices" });
    expect(api.ops()).toHaveLength(0);
  });
});

describe("phases and failures", () => {
  it("signed out of the app: says so and offers a full navigation to sign in", async () => {
    api = new FakeApi(catalog());
    api.fail = { status: 401, json: { error: "unauthorized" } };
    controller = new Controller({ base: "", fetchImpl: api.fetch, lock: makeLock(undefined) });
    await controller.start();
    render(<App controller={controller} locale="en" />);
    expect(screen.getByText("You are signed out.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/");
  });

  it("a failing send keeps the tap and says how many changes wait", async () => {
    await boot();
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    expect(screen.getByText("Waiting to be sent: 1")).toBeTruthy();
    expect(screen.getByText("The server did not answer properly. Retrying.")).toBeTruthy();
    api.fail = null;
    await act(async () => controller.retry());
    await settle();
    expect(api.server.items.get(MILK)!.needed).toBe(false);
    expect(screen.queryByText(/Waiting to be sent/)).toBeNull();
  });

  it("a change refused as stale is listed with Apply anyway", async () => {
    await boot(catalog(), "#/capture");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "deter" } });
    await screen.findByRole("button", { name: "Detergent: Running low" });
    // Someone else sets it ok first: the device's set_level is compared on the revision it saw.
    api.server.apply(
      [
        {
          v: 1,
          client_op_id: newUuid(),
          queue_id: null,
          target: DETERGENT,
          op: "set_level",
          args: { level: "ok" },
          base_rev: 0,
        },
      ],
      "someone-else"
    );
    fireEvent.click(screen.getByRole("button", { name: "Detergent: Running low" }));
    await waitFor(() => expect(controller.get().queue.notices).toHaveLength(1));
    await go("#/pending");
    expect(screen.getByRole("button", { name: "Apply anyway" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply anyway" }));
    await settle();
    expect(api.server.items.get(DETERGENT)!.level).toBe("low");
  });

  it("a workspace whose projects have no list yet says so", async () => {
    api = new FakeApi([]);
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await api.fetch(input, init);
      if (!String(input).endsWith("/inventory/lists/")) return response;
      const body = await response.json();
      return new Response(JSON.stringify({ ...body, lists: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    controller = new Controller({ base: "", fetchImpl, lock: makeLock(undefined) });
    await controller.start();
    render(<App controller={controller} locale="en" />);
    expect(screen.getByText(/No list here yet/)).toBeTruthy();
  });

  it("a guest (403 on the lists) is told there is no access", async () => {
    api = new FakeApi([]);
    const fetchImpl: typeof fetch = async (input, init) =>
      String(input).endsWith("/inventory/lists/")
        ? new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          })
        : api.fetch(input, init);
    controller = new Controller({ base: "", fetchImpl, lock: makeLock(undefined) });
    await controller.start();
    render(<App controller={controller} locale="en" />);
    expect(screen.getByText("You have no access to the lists in this workspace.")).toBeTruthy();
  });
});

describe("the queue belongs to its workspace", () => {
  it("a workspace switch never sends one workspace's waiting taps to another", async () => {
    window.location.hash = "#/";
    api = new FakeApi(catalog());
    const stores = new Map<string, AppStore>();
    controller = new Controller({
      base: "",
      fetchImpl: (input, init) => api.fetch(input, init),
      lock: makeLock(undefined),
      openStore: async (userId, workspace) => {
        const key = `${userId}:${workspace}`;
        if (!stores.has(key)) stores.set(key, memoryStore(createQueue(userId, newUuid())));
        return stores.get(key)!;
      },
    });
    await controller.start();
    render(<App controller={controller} locale="en" />);
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    api.fail = null;
    await act(async () => controller.switchWorkspace("work"));
    await act(async () => controller.flush());
    // Nothing went to the other workspace, where the item does not exist and would be refused as gone.
    expect(api.calls.filter((c) => c.path.includes("/workspaces/work/inventory/ops/"))).toHaveLength(0);
    expect(controller.get().queue.entries).toHaveLength(0);
    await act(async () => controller.switchWorkspace("home"));
    await act(async () => controller.retry());
    await settle();
    expect(api.calls.filter((c) => c.path.includes("/workspaces/home/inventory/ops/")).length).toBeGreaterThan(0);
    expect(api.server.items.get(MILK)!.needed).toBe(false);
  });

  it("a held entry at the head does not make the app retry in a loop", async () => {
    await boot();
    await act(async () => {
      // A tap three hours old, never sent: held until the person approves it.
      await (
        controller as unknown as {
          updateQueue: (fn: (s: ReturnType<typeof createQueue>) => ReturnType<typeof createQueue>) => Promise<unknown>;
        }
      ).updateQueue((s) => ({
        ...tap(s, "buy", MILK, {}, { now: Date.now() - 3 * 3_600_000, newId: newUuid }),
        failure: { kind: "server", attempts: 3, nextTryAt: Date.now() - 1 },
      }));
    });
    const before = api.calls.length;
    await act(async () => controller.flush());
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    // One refresh after the flush, then quiet: before the fix a 50 ms timer refetched for ever.
    expect(api.calls.length - before).toBeLessThanOrEqual(3);
    expect(api.ops()).toHaveLength(0);
  });
});

describe("accessibility", () => {
  it("every control that acts on an item names the item, and every button has a name", async () => {
    // Sequential on purpose: one screen mounted at a time.
    /* oxlint-disable no-await-in-loop */
    for (const hash of ["#/", "#/shop", "#/inventory"]) {
      cleanup();
      await boot(catalog(), hash);
      await settle();
      for (const b of screen.getAllByRole("button"))
        expect(b.getAttribute("aria-label") ?? b.textContent?.trim()).toBeTruthy();
      for (const row of document.querySelectorAll<HTMLElement>("[data-item]")) {
        const name = controller.get().known[row.dataset.item!]!.data.name;
        for (const control of row.querySelectorAll("button, input"))
          expect((control.getAttribute("aria-label") ?? "") + (control.textContent ?? ""), hash).toContain(name);
      }
    }
    /* oxlint-enable no-await-in-loop */
  });
});
