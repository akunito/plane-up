// The screens against the fake API: what is shown, what a tap sends, undo, dialogs, phases.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueue, makeLock, newUuid, OP_VERSION, tap } from "@plane/inventory";
import { App } from "../src/app";
import { Controller, DONE_RESET_MS } from "../src/controller";
import { memoryStore } from "../src/store";
import type { AppStore } from "../src/store";
import type { ImageEnv } from "@plane/inventory";
import { BABY, BO, FakeApi, GROCERIES, ME, STORAGE, SUPPLEMENTS, state, uid } from "./fake-api";
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
/** The size every re-encode answers; jsdom has no canvas, so the photo's shrink is faked (APLANE-66). */
let encodedSize = 300_000;
const fakeImages: ImageEnv = {
  decode: async () => ({ width: 4032, height: 3024, close: () => undefined }),
  encode: async () => new Blob([new Uint8Array(encodedSize)], { type: "image/jpeg" }),
};

async function boot(items = catalog(), hash = "#/", now?: () => number, setup?: (a: FakeApi) => void) {
  window.location.hash = hash;
  api = new FakeApi(items);
  setup?.(api);
  controller = new Controller({
    base: "",
    fetchImpl: (input, init) => api.fetch(input, init),
    lock: makeLock(undefined),
    openStore: async (userId) => memoryStore(createQueue(userId, newUuid())),
    imageEnv: fakeImages,
    ...(now ? { now } : {}),
  });
  await controller.start();
  render(<App controller={controller} locale="en" {...(now ? { now } : {})} />);
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

  it("S18: Done survives a reload, and empties after six hours without a tick", async () => {
    let clock = Date.now();
    const stores = new Map<string, AppStore>();
    const openStore = async (userId: string) => {
      if (!stores.has(userId)) stores.set(userId, memoryStore(createQueue(userId, newUuid())));
      return stores.get(userId)!;
    };
    api = new FakeApi(catalog());
    const start = async () => {
      cleanup();
      controller = new Controller({
        base: "",
        fetchImpl: (input, init) => api.fetch(input, init),
        lock: makeLock(undefined),
        openStore,
        now: () => clock,
      });
      await controller.start();
      render(<App controller={controller} locale="en" />);
    };
    window.location.hash = "#/";
    await start();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bread: bought" }));
    await settle();
    // A reload: a new page over the same stored queue.
    await start();
    expect(screen.getByRole("checkbox", { name: "Bread: not bought after all" })).toBeTruthy();
    clock += DONE_RESET_MS + 60_000;
    await start();
    expect(screen.getByRole("checkbox", { name: "Bread: bought" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Bread: not bought after all" })).toBeNull();
  });

  it("an item bought online is marked ordered through the order dialog, and then shown On the way", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Protein: Mark ordered" }));
    const dialog = screen.getByRole("dialog", { name: "Mark Protein as ordered" });
    expect((within(dialog).getByLabelText("Quantity") as HTMLInputElement).value).toBe("3");
    fireEvent.change(within(dialog).getByLabelText("Reference (shop, order number)"), { target: { value: "A-17" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark ordered" }));
    await settle();
    const order = api.ops().find((o) => o.op === "mark_ordered")!;
    expect(order.args).toMatchObject({ quantity: 3, reference: "A-17" });
    expect(screen.getByRole("region", { name: "On the way · 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Protein: Mark ordered" })).toBeNull();
    // An order action has no Undo (brief: Orders).
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("Arrived asks how much came and closes the order; the stock goes up by that much", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Protein: Mark ordered" }));
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
    // S71: an order action has no Undo, the arrival included (brief: Orders).
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("S01: A and B tick in different stores; A finishing leaves B's Done and items alone", async () => {
    await boot();
    const b = new Controller({
      base: "",
      fetchImpl: (input, init) => api.fetch(input, init),
      lock: makeLock(undefined),
      openStore: async (userId) => memoryStore(createQueue(userId, newUuid())),
    });
    await b.start();
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await b.act("buy", BREAD, {}, { tick: true });
    await settle();
    await waitFor(() => expect(b.get().queue.entries).toHaveLength(0));
    const sent = api.ops().length;
    const before = structuredClone([...api.server.items.values()]);
    await act(async () => controller.finishShopping());
    expect(Object.keys(controller.get().queue.done)).toEqual([]);
    expect(Object.keys(b.get().queue.done)).toEqual([BREAD]);
    // Finishing is the device's own: nothing is sent and no item changes.
    expect(api.ops()).toHaveLength(sent);
    expect([...api.server.items.values()]).toEqual(before);
  });

  it("S06: unticking after B changed the item is refused, the tick stays under Done, and A is told why", async () => {
    await boot();
    fireEvent.click(screen.getByRole("checkbox", { name: "Detergent: bought" }));
    await settle();
    const rev = api.server.items.get(DETERGENT)!.rev;
    api.server.apply(
      [
        {
          v: 1,
          client_op_id: newUuid(),
          queue_id: null,
          target: DETERGENT,
          op: "set_level",
          args: { level: "low" },
          base_rev: rev,
        },
      ],
      "bea-id"
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Detergent: not bought after all" }));
    await waitFor(() => expect(controller.get().queue.notices).toHaveLength(1));
    expect(api.server.items.get(DETERGENT)!.level).toBe("low");
    expect(screen.getByRole("checkbox", { name: "Detergent: not bought after all" })).toBeTruthy();
    await go("#/pending");
    expect(screen.getByText("Detergent: not applied (someone changed it first).")).toBeTruthy();
  });

  it("S17: a pinned item someone else bought stays on the list, saying who bought it and when", async () => {
    // The model server keeps no last_bought_*: the item arrives as the engine sends it after B's purchase.
    const items = catalog();
    const bread = items.find((i) => i.state.id === BREAD)!;
    bread.state.last_bought_by = BO.id;
    await boot(items);
    const row = screen.getByRole("checkbox", { name: "Bread: bought" }).closest("label")!;
    expect(row.textContent).toMatch(/Pinned · bought .* by Bo$/);
    // Bought by the viewer: no name.
    cleanup();
    bread.state.last_bought_by = ME.id;
    await boot(items);
    expect(screen.getByRole("checkbox", { name: "Bread: bought" }).closest("label")!.textContent).not.toMatch(/ by /);
  });

  it("marking ordered warns when the item already has an open order", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Protein: Mark ordered" }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark ordered" }));
    await settle();
    // One of three ordered: 0 at home + 1 on order is below the minimum of 2, so it is still to buy,
    // and ordering again warns.
    fireEvent.click(screen.getByRole("button", { name: "Protein: Mark ordered" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain("already has an open order");
  });

  it("S15: with two open orders, Arrived asks which one and the other stays open", async () => {
    await boot();
    for (const [n, ref] of [
      ["1", "A-1"],
      ["2", "B-2"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Protein: Mark ordered" }));
      const d = screen.getByRole("dialog");
      fireEvent.change(within(d).getByLabelText("Quantity"), { target: { value: n } });
      fireEvent.change(within(d).getByLabelText("Reference (shop, order number)"), { target: { value: ref } });
      fireEvent.click(within(d).getByRole("button", { name: "Mark ordered" }));
      // Sequential on purpose: the second order is placed after the first is answered.
      // oxlint-disable-next-line no-await-in-loop
      await settle();
    }
    expect(screen.getByRole("region", { name: "On the way · 2" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Protein: the order arrived" })[0]!);
    const dialog = screen.getByRole("dialog");
    const choices = within(within(dialog).getByRole("group", { name: "Which order" })).getAllByRole("radio");
    expect(choices).toHaveLength(2);
    // The fake API keeps no reference: the orders are told apart by quantity (×1 and ×2).
    fireEvent.click(choices.find((r) => r.closest("label")!.textContent!.includes("×2"))!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Arrived" }));
    await settle();
    const arrived = api.ops().find((o) => o.op === "arrived")!;
    const b2 = api.ops().find((o) => o.op === "mark_ordered" && o.args.reference === "B-2")!;
    expect(arrived.args).toMatchObject({ order_id: b2.args.order_id, quantity: 2 });
    const left = screen.getByRole("region", { name: "On the way · 1" });
    expect(within(left).getByText("×1")).toBeTruthy();
  });

  it("S64: A buys it offline while B orders it; the order stays open, marked bought since, with an offer to cancel", async () => {
    await boot();
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    const orderId = newUuid();
    api.server.apply(
      [
        {
          v: 1,
          client_op_id: newUuid(),
          queue_id: null,
          target: WIPES,
          op: "mark_ordered",
          args: { order_id: orderId, quantity: 3 },
        },
      ],
      BO.id
    );
    api.fail = null;
    await act(async () => controller.retry());
    await settle();
    expect(api.server.orders.get(orderId)!.status).toBe("open");
    const row = screen.getByRole("region", { name: /On the way/ });
    expect(within(row).getByText(/Ana bought it .*after it was ordered\./)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Wipes: Cancel order" }));
    await settle();
    expect(api.server.orders.get(orderId)!.status).toBe("cancelled");
  });

  it("grouping by urgency puts out first and pinned last", async () => {
    await boot();
    fireEvent.change(screen.getByRole("combobox", { name: /Group/ }), { target: { value: "urgency" } });
    await settle();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(["Out", "Running low", "Needed", "Pinned"]);
    // S60: Wipes (units, 1 of minimum 3) is below its minimum, so it sits with "Running low".
    expect(within(screen.getByRole("region", { name: "Running low" })).getByText("Wipes")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Out" })).getByText("Detergent")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Needed" })).getByText("Milk")).toBeTruthy();
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
    const create = await screen.findByRole("button", { name: "Create “Oat milk” and add it to the shopping list" });
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

  it("S11: units → level → units asks the quantity again and never offers the old number", async () => {
    await boot(catalog(), `#/item/${WIPES}`);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Wipes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Track Wipes as: Levels" }));
    const toLevel = screen.queryByRole("dialog");
    if (toLevel) fireEvent.click(within(toLevel).getByRole("button", { name: "Save" }));
    await settle();
    expect(api.server.items.get(WIPES)!.mode).toBe("level");
    fireEvent.click(screen.getByRole("button", { name: "Track Wipes as: Units" }));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText("How many are at home now?") as HTMLInputElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(api.server.items.get(WIPES)).toMatchObject({ mode: "units", quantity: 4 });
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

  it("a photo is shrunk, sent to storage and confirmed, then shown; removing it clears it (APLANE-66)", async () => {
    encodedSize = 300_000;
    await boot(catalog(), `#/item/${SALT}`);
    const input = await screen.findByLabelText("Add photo");
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(6_000_000)], "IMG_1.jpg", { type: "image/jpeg" })] },
    });
    const img = (await screen.findByAltText("Photo of Salt")) as HTMLImageElement;
    const confirmed = api.calls.find((c) => c.method === "PATCH" && c.path.includes("/photo/"))!;
    const assetId = confirmed.path.match(/\/photo\/([^/]+)\/$/)![1];
    expect(img.getAttribute("src")).toMatch(
      new RegExp(`^/api/workspaces/home/projects/[^/]+/inventory/items/${SALT}/photo/${assetId}/$`)
    );
    expect(api.calls.filter((c) => c.path.includes("/photo/") || c.path === STORAGE).map((c) => c.method)).toEqual([
      "POST",
      "POST",
      "PATCH",
    ]);
    // What was sent is the shrunk photo, not the 6 MB original.
    expect(api.calls.find((c) => c.method === "POST" && c.path.endsWith("/photo/"))!.body).toEqual({
      type: "image/jpeg",
      size: 300_000,
    });
    expect(api.ops()).toHaveLength(0);
    expect(screen.getByLabelText("Change photo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Salt: Remove photo" }));
    await waitFor(() => expect(screen.queryByAltText("Photo of Salt")).toBeNull());
    expect(screen.getByLabelText("Add photo")).toBeTruthy();
  });

  it("on a touch screen the camera has its own button, and both buttons upload (Android's picker has no camera)", async () => {
    encodedSize = 300_000;
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === "(pointer: coarse)", media: q })) as typeof window.matchMedia;
    try {
      await boot(catalog(), `#/item/${SALT}`);
      const camera = (await screen.findByLabelText("Take photo")) as HTMLInputElement;
      const gallery = screen.getByLabelText("Gallery") as HTMLInputElement;
      expect(camera.getAttribute("capture")).toBe("environment");
      expect(gallery.hasAttribute("capture")).toBe(false);
      expect(screen.queryByLabelText("Add photo")).toBeNull();
      fireEvent.change(camera, {
        target: { files: [new File([new Uint8Array(10)], "c.jpg", { type: "image/jpeg" })] },
      });
      const first = ((await screen.findByAltText("Photo of Salt")) as HTMLImageElement).getAttribute("src");
      fireEvent.change(screen.getByLabelText("Gallery"), {
        target: { files: [new File([new Uint8Array(10)], "g.jpg", { type: "image/jpeg" })] },
      });
      await waitFor(() =>
        expect((screen.getByAltText("Photo of Salt") as HTMLImageElement).getAttribute("src")).not.toBe(first)
      );
      expect(api.calls.filter((c) => c.method === "PATCH" && c.path.includes("/photo/"))).toHaveLength(2);
    } finally {
      window.matchMedia = real;
    }
  });

  it("a history that cannot load offline says so, and loads when the network returns", async () => {
    await boot(catalog(), `#/item/${SALT}`, undefined, (a) => {
      a.dropHistory = true;
    });
    expect(await screen.findByText("The history cannot be loaded now.")).toBeTruthy();
    api.dropHistory = false;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });

  it("a history that failed is tried again on focus, without an online event (the network dropped silently)", async () => {
    await boot(catalog(), `#/item/${SALT}`, undefined, (a) => {
      a.dropHistory = true;
    });
    expect(await screen.findByText("The history cannot be loaded now.")).toBeTruthy();
    api.dropHistory = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });

  it("a refresh that runs during the upload does not hide the photo once it is confirmed (audit F1)", async () => {
    encodedSize = 300_000;
    // A clock that moves on every read: with the real one, two reads in the same millisecond made this pass
    // without the fix (re-review).
    let tick = Date.now();
    await boot(catalog(), `#/item/${SALT}`, () => ++tick);
    // A list refresh started and answered while the bytes are on their way: it says "no photo" and was
    // fetched after the upload began. The confirmation's answer is newer still and must win.
    api.onStorage = () => controller.loadList(GROCERIES);
    const input = await screen.findByLabelText("Add photo");
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], "x.jpg", { type: "image/jpeg" })] } });
    expect(await screen.findByAltText("Photo of Salt")).toBeTruthy();
    expect(controller.get().known[SALT]!.data.photo).toMatch(/^9/);
    api.onStorage = null;
  });

  it("a photo that cannot be shrunk under the limit is refused before anything is sent", async () => {
    encodedSize = 6_000_000;
    await boot(catalog(), `#/item/${SALT}`);
    const input = await screen.findByLabelText("Add photo");
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], "x.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(screen.getByText("Not saved: the photo is too large")).toBeTruthy());
    expect(api.calls.filter((c) => c.path.includes("/photo/") || c.path === STORAGE)).toHaveLength(0);
    encodedSize = 300_000;
  });
});

describe("phase 9 device review", () => {
  async function bootWith(openStore: (userId: string) => Promise<AppStore>, hash = "#/", now?: () => number) {
    window.location.hash = hash;
    api = new FakeApi(catalog());
    controller = new Controller({
      base: "",
      fetchImpl: (input, init) => api.fetch(input, init),
      lock: makeLock(undefined),
      openStore,
      ...(now ? { now } : {}),
    });
    await controller.start();
    render(<App controller={controller} locale="en" {...(now ? { now } : {})} />);
  }

  it("an 'outdated' queue is tried once more when the page loads (a fixed server unblocks it)", async () => {
    const queue = createQueue(ME.id, newUuid());
    const queued = tap(
      { ...queue, known: { [MILK]: { ...state(MILK, "on_demand"), rev: 0 } } },
      "set_needed",
      MILK,
      { needed: false },
      { now: Date.now() - 60_000, newId: newUuid }
    );
    const outdated = {
      ...queued,
      failure: { kind: "outdated" as const, attempts: 1, nextTryAt: 0, opVersion: OP_VERSION },
    };
    await bootWith(async () => memoryStore(outdated));
    await waitFor(() => expect(api.ops().filter((o) => o.target === MILK)).toHaveLength(1));
    await waitFor(() => expect(controller.get().queue.entries).toHaveLength(0));
    expect(controller.get().queue.failure).toBeNull();
  });

  it("the item sheet's footer actions name their item (S34: TalkBack read a bare 'Mark ordered')", async () => {
    await boot(catalog(), `#/item/${SALT}`);
    expect(await screen.findByRole("button", { name: "Salt: Mark ordered" })).toBeTruthy();
    // The photo input is visually hidden, not display:none: in the accessibility tree and reachable by keyboard.
    const input = screen.getByLabelText(/^Salt: (Add photo|Gallery)$/) as HTMLInputElement;
    expect(input.hidden).toBe(false);
    expect(input.className).toBe("visually-hidden");
  });

  it("quick capture finds an item by a keyword and says which one matched", async () => {
    await boot(catalog(), "#/capture", undefined, (a) => {
      a.data.get(SALT)!.keywords = "salt, sal, sól";
    });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sól" } });
    expect(await screen.findByRole("link", { name: "Salt" })).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "also: sól")).toBeTruthy();
  });

  it("the workspace picker is in the list's scroll area, not under the full-height screen", async () => {
    await boot(catalog(), "#/", undefined, (a) => a.workspaces.push({ slug: "other", name: "Other" }));
    const picker = await screen.findByRole("combobox", { name: /Workspace/ });
    expect(picker.closest("main.scroll")).not.toBeNull();
  });

  it("a store that cannot keep changes is said on screen", async () => {
    await bootWith(async (userId) => ({ ...memoryStore(createQueue(userId, newUuid())), volatile: true }));
    expect(screen.getByText(/This device cannot keep changes/)).toBeTruthy();
  });

  it("a tap that cannot be written is said, not lost silently", async () => {
    let broken = false;
    await bootWith(async (userId) => {
      const inner = memoryStore(createQueue(userId, newUuid()));
      return {
        read: inner.read,
        update: async (fn) => {
          if (broken) throw new DOMException("quota", "QuotaExceededError");
          return inner.update(fn);
        },
      };
    });
    broken = true;
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    expect(await screen.findByText(/A change could not be saved on this device/)).toBeTruthy();
    expect(api.ops()).toHaveLength(0);
    // The next tap that is stored takes the warning away (phase 9 re-review: it stayed until a reload).
    broken = false;
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(screen.queryByText(/A change could not be saved on this device/)).toBeNull());
  });

  it("a double tap on a row buys once", async () => {
    await boot();
    const box = screen.getByRole("checkbox", { name: "Wipes: bought" });
    fireEvent.click(box);
    fireEvent.click(box);
    await settle();
    expect(api.ops().filter((o) => o.target === WIPES && o.op === "buy")).toHaveLength(1);
    expect(api.server.items.get(WIPES)!.quantity).toBe(3);
  });

  it("an edit that fails says why in the person's words, not a code", async () => {
    await boot(catalog(), `#/item/${SALT}`);
    const field = await screen.findByLabelText("Category / aisle");
    api.fail = { status: 502 };
    fireEvent.change(field, { target: { value: "Spices" } });
    fireEvent.blur(field);
    expect(await screen.findByText("Not saved: the server did not answer properly")).toBeTruthy();
    api.fail = null;
  });

  it("a held change on an item off the to-buy list shows its name, and discarding it re-reads its list", async () => {
    let clock = Date.now();
    const store = memoryStore(createQueue(ME.id, newUuid()));
    await bootWith(
      async () => store,
      "#/capture",
      () => clock
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "salt" } });
    const needed = await screen.findByRole("button", { name: "Salt: needed" });
    api.fail = { status: 502 };
    fireEvent.click(needed);
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    api.fail = null;
    clock += 3 * 60 * 60 * 1000;
    // An online start the next time: the app knows only the to-buy list, and Salt is not on it.
    cleanup();
    controller = new Controller({
      base: "",
      fetchImpl: (input, init) => api.fetch(input, init),
      lock: makeLock(undefined),
      openStore: async () => store,
      now: () => clock,
    });
    window.location.hash = "#/";
    await controller.start();
    render(<App controller={controller} locale="en" now={() => clock} />);
    await waitFor(() => expect(window.location.hash).toBe("#/pending"));
    const held = within(await screen.findByRole("region", { name: "Not sent for more than two hours" }));
    expect(await held.findByText(/^Salt:/)).toBeTruthy();
    const reads = () => api.calls.filter((c) => c.path.endsWith(`/lists/${GROCERIES}/items/`)).length;
    const before = reads();
    fireEvent.click(held.getByRole("button", { name: "Salt: Discard" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(controller.get().queue.needsRefresh).toEqual([]);
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

  it("a server that no longer accepts this app's format: the tap is kept and the app asks to be updated (S25)", async () => {
    await boot();
    api.outdatedOps = true;
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("outdated"));
    expect(screen.getByText("Waiting to be sent: 1")).toBeTruthy();
    expect(screen.getByText(/no longer accepts this version of the app/)).toBeTruthy();
    // A retry sends nothing: only an updated app does.
    const sent = api.ops().length;
    await act(async () => controller.retry());
    expect(api.ops()).toHaveLength(sent);
    await go("#/pending");
    expect(screen.getByRole("button", { name: "Update the app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    expect(api.server.items.get(MILK)!.needed).toBe(true);
  });

  it("S40: after server errors the app retries by itself; both taps arrive once each, in order", async () => {
    await boot();
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    // The backoff's own retries (1 s, then 2 s) keep failing; nobody taps anything.
    await waitFor(() => expect(controller.get().queue.failure?.attempts ?? 0).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
    });
    api.fail = null;
    await waitFor(() => expect(controller.get().queue.entries).toHaveLength(0), { timeout: 6000 });
    const delivered = api.ops().filter((o) => api.server.effects.get(o.client_op_id));
    expect(new Set(delivered.map((o) => o.target))).toEqual(new Set([MILK, WIPES]));
    for (const o of delivered) expect(api.server.effects.get(o.client_op_id)).toBe(1);
    expect(
      api
        .ops()
        .map((o) => o.target)
        .filter((t, i, all) => all.indexOf(t) === i)
    ).toEqual([MILK, WIPES]);
    expect(api.server.items.get(WIPES)!.quantity).toBe(3);
  }, 15_000);

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
    expect(screen.getByRole("button", { name: "Detergent: Apply anyway" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Detergent: Apply anyway" }));
    await settle();
    expect(api.server.items.get(DETERGENT)!.level).toBe("low");
    // The notice leaves with it, on a store that parses the queue afresh as IndexedDB does (phase 9 review:
    // compared by identity, it stayed and every tap queued another operation).
    expect(controller.get().queue.notices).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Detergent: Apply anyway" })).toBeNull();
    expect(api.ops().filter((o) => o.target === DETERGENT && o.op === "set_level")).toHaveLength(2);
  });

  it("OK takes a notice away (phase 9 review: it did nothing on the phone)", async () => {
    await boot(catalog(), "#/capture");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "deter" } });
    await screen.findByRole("button", { name: "Detergent: Running low" });
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
    fireEvent.click(screen.getByRole("button", { name: "Detergent: OK" }));
    await waitFor(() => expect(controller.get().queue.notices).toHaveLength(0));
  });

  it("an old 'signed out' behind a held head does not restart the app over and over (phase 9 review)", async () => {
    let clock = Date.now();
    await boot(catalog(), "#/", () => clock);
    api.fail = { status: 401, json: { error: "unauthorized" } };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("signed_out_app"));
    api.fail = null;
    // Signed in again the next day: the tap is now held, and the queue still carries the old failure.
    clock += 20 * 60 * 60 * 1000;
    await act(async () => controller.start());
    const starts = () => api.calls.filter((c) => c.path === "/api/users/me/workspaces/").length;
    const before = starts();
    await act(async () => {
      await controller.flush();
      await controller.refresh();
      await controller.flush();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(starts() - before).toBeLessThanOrEqual(1);
  });

  /** Phase 9 matrix (S03, S04): A's level set while the send fails; B changes the item on the server. */
  async function staleWhileFailing(item: string, search: string, mine: string, theirs: Record<string, unknown>) {
    await boot(catalog(), "#/capture");
    api.server.names.set("bea-id", "Bea");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: search } });
    const button = await screen.findByRole("button", { name: `${item}: ${mine}` });
    api.fail = { status: 502 };
    fireEvent.click(button);
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    const id = [...api.data.entries()].find(([, d]) => d.name === item)![0];
    const rev = api.server.items.get(id)!.rev;
    const op = Object.keys(theirs)[0]!;
    api.server.apply(
      [
        {
          v: 1,
          client_op_id: newUuid(),
          queue_id: null,
          target: id,
          op: op as never,
          args: theirs[op] as never,
          base_rev: rev,
        },
      ],
      "bea-id"
    );
    api.fail = null;
    await act(async () => controller.retry());
    await waitFor(() => expect(controller.get().queue.notices).toHaveLength(1));
    await go("#/pending");
    return id;
  }

  it("S03: A's 'out' sent after B bought it is not applied, and A is told who changed it", async () => {
    const id = await staleWhileFailing("Nappies", "nap", "Out", { buy: {} });
    expect(screen.getByText(/Nappies: Bea changed it .*after you looked\. Your change was not applied\./)).toBeTruthy();
    expect(api.server.items.get(id)!.level).toBe("ok");
  });

  it("S04: A's 'in stock' sent after B set it low stays low, and A is told who changed it", async () => {
    const id = await staleWhileFailing("Detergent", "deter", "In stock", { set_level: { level: "low" } });
    expect(screen.getByText(/Detergent: Bea changed it .*Your change was not applied\./)).toBeTruthy();
    expect(api.server.items.get(id)!.level).toBe("low");
  });

  it("S35: changes left unsent for over two hours are listed, each sent or discarded by hand", async () => {
    let clock = Date.now();
    await boot(catalog(), "#/", () => clock);
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    await waitFor(() => expect(controller.get().queue.entries).toHaveLength(2));
    // The failed attempt marked them transmitted: they are held all the same (decision 3, 2026-11-22).
    api.fail = null;
    clock += 3 * 60 * 60 * 1000;
    const failed = api.ops().length; // the 502 attempts are recorded too
    await act(async () => controller.retry());
    expect(api.ops()).toHaveLength(failed);
    // The status says why nothing goes, not the old failure (decision 3 audit).
    expect(screen.getByText("Waiting for you, older than two hours: 2. Send or discard them.")).toBeTruthy();
    expect(screen.queryByText(/did not answer properly/)).toBeNull();
    await go("#/pending");
    expect(screen.queryByRole("region", { name: "Sending is failing" })).toBeNull();
    expect(screen.getAllByText("An earlier attempt may already have reached the server.")).toHaveLength(2);
    const held = within(screen.getByRole("region", { name: "Not sent for more than two hours" }));
    const rows = held.getAllByRole("button", { name: /: Send$/ });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(api.ops()).toHaveLength(failed + 1));
    fireEvent.click(held.getByRole("button", { name: /: Discard$/ }));
    await waitFor(() => expect(controller.get().queue.entries).toHaveLength(0));
    expect(api.ops()).toHaveLength(failed + 1);
    expect(api.server.items.get(MILK)!.needed).toBe(false);
    expect(api.server.items.get(WIPES)!.quantity).toBe(1);
    expect(controller.get().queue.notices.map((n) => [n.kind, n.mayHaveApplied])).toEqual([["discarded", true]]);
  });

  it("S35: an app opened with held changes shows them at once, from the to-buy list only", async () => {
    let clock = Date.now();
    const store = memoryStore(createQueue(ME.id, newUuid()));
    api = new FakeApi(catalog());
    const start = async (hash: string) => {
      cleanup();
      window.location.hash = hash;
      controller = new Controller({
        base: "",
        fetchImpl: (input, init) => api.fetch(input, init),
        lock: makeLock(undefined),
        openStore: async () => store,
        now: () => clock,
      });
      await controller.start();
      render(<App controller={controller} locale="en" now={() => clock} />);
    };
    await start("#/");
    api.fail = { status: 502 };
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    api.fail = null;
    clock += 3 * 60 * 60 * 1000;
    await start(`#/item/${SALT}`);
    expect(window.location.hash).toBe(`#/item/${SALT}`);
    await start("#/");
    await waitFor(() => expect(window.location.hash).toBe("#/pending"));
  });

  it("S41: an operation the server keeps failing on blocks the queue until it is discarded; the rest then goes", async () => {
    await boot();
    api.poisonOp = (op) => op.target === MILK;
    fireEvent.click(screen.getByRole("checkbox", { name: "Milk: bought" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wipes: bought" }));
    await waitFor(() => expect(controller.get().queue.failure?.kind).toBe("server"));
    await act(async () => controller.retry());
    expect(controller.get().queue.entries).toHaveLength(2);
    await go("#/pending");
    fireEvent.click(screen.getByRole("button", { name: "Milk: Discard the first change" }));
    await act(async () => controller.retry());
    await waitFor(() => expect(controller.get().queue.entries).toHaveLength(0));
    expect(api.server.items.get(WIPES)!.quantity).toBe(3);
    expect(api.server.items.get(MILK)!.needed).toBe(true);
    api.poisonOp = null;
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

  it("after a reload, an order answered before it is not shown again as a phantom", async () => {
    window.location.hash = "#/";
    api = new FakeApi(catalog());
    // A queue from the previous page load: it marked Salt ordered and got the answer; the order has since
    // arrived on another phone, so no snapshot returns Salt or the order any more.
    const old = createQueue("00000000-0000-4000-8000-000000000001", newUuid());
    const salt = { ...state(SALT, "on_demand"), rev: 1 };
    const queued = tap(
      { ...old, known: { [SALT]: salt } },
      "mark_ordered",
      SALT,
      { order_id: newUuid() },
      { now: Date.now() - 60_000, newId: newUuid }
    );
    const answered = {
      ...queued,
      entries: [],
      known: {},
      recent: [{ ...queued.entries[0]!, transmission: "answered" as const, resultRev: 2 }],
    };
    controller = new Controller({
      base: "",
      fetchImpl: (input, init) => api.fetch(input, init),
      lock: makeLock(undefined),
      openStore: async () => memoryStore(answered),
    });
    await controller.start();
    render(<App controller={controller} locale="en" />);
    expect(screen.getByText("5 missing · 1 pinned")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /On the way/ })).toBeNull();
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

describe("the workspace a link names (?ws=)", () => {
  it("opens it when the person is in it, and falls through otherwise (phase 5 re-review)", async () => {
    api = new FakeApi(catalog());
    const make = (slug: string) =>
      new Controller({
        base: "",
        slug,
        fetchImpl: (input, init) => api.fetch(input, init),
        lock: makeLock(undefined),
        openStore: async (userId) => memoryStore(createQueue(userId, newUuid())),
      });
    controller = make("home");
    await controller.start();
    expect([controller.get().slug, controller.get().phase]).toEqual(["home", "ready"]);
    controller = make("not-mine");
    await controller.start();
    expect([controller.get().slug, controller.get().phase]).toEqual(["home", "ready"]);
  });
});
