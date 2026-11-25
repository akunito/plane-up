// The pure rules behind the screens: which rows are on the list, orders tapped on this device, grouping,
// badges, who can see a list.

import { describe, expect, it } from "vitest";
import type { ItemState, QueueState } from "@plane/inventory";
import { buildOp, createQueue, enqueue, onDelivered, refreshed } from "@plane/inventory";
import type { ItemData, Known, Order } from "../src/model";
import {
  audience,
  badge,
  board,
  dropMissingFromList,
  group,
  mergeFetched,
  mergeSnapshot,
  openOrders,
} from "../src/model";
import { state, uid } from "./fake-api";

function data(s: ItemState, extra: Partial<ItemData> = {}): ItemData {
  return {
    ...s,
    name: extra.name ?? s.id.slice(-4),
    list: { id: "L", name: "List" },
    project: { id: "P", name: "Home", identifier: "H" },
    category: "",
    store: "",
    buy_online: false,
    purchase_url: "",
    variant: "",
    last_price: null,
    currency: "",
    expires_on: null,
    barcode: "",
    sort_order: 0,
    on_order: 0,
    to_buy: 1,
    ...extra,
  };
}

const tap = { now: 1000, queueId: "q", newId: () => uid("9") };

function queueWith(items: ItemData[]): QueueState {
  return refreshed(createQueue("me", "q"), items);
}

describe("what the server last said", () => {
  it("a snapshot that leaves an item out takes it off the list, unless something fetched later says otherwise", () => {
    const a = data(state(uid(), "on_demand", { needed: true }));
    const b = data(state(uid(), "on_demand", { needed: true }));
    let known: Record<string, Known> = mergeFetched({}, [a], 10);
    known = mergeFetched(known, [b], 30);
    known = mergeSnapshot(known, [], 20);
    expect(known[a.id]!.onList).toBe(false);
    expect(known[b.id]!.onList).toBe(true);
  });

  it("an older fetch never replaces a newer one with an older revision", () => {
    const s = state(uid(), "level", { level: "low" });
    const newer = data({ ...s, rev: 3 }, { name: "new" });
    const older = data({ ...s, rev: 2 }, { name: "old" });
    const known = mergeFetched(mergeFetched({}, [newer], 50), [older], 40);
    expect(known[s.id]!.data.name).toBe("new");
    // Data edits do not advance the revision: a later fetch at the same revision brings the new name.
    expect(mergeFetched(known, [data({ ...s, rev: 3 }, { name: "renamed" })], 60)[s.id]!.data.name).toBe("renamed");
  });

  it("a full list fetch drops what it no longer returns", () => {
    const a = data(state(uid(), "pinned"));
    const known = dropMissingFromList(mergeFetched({}, [a], 1), "L", [], 5);
    expect(known[a.id]).toBeUndefined();
  });
});

describe("the board", () => {
  it("someone else bought it: the next snapshot removes the row even though the device's state says needed", () => {
    const milk = data(state(uid(), "on_demand", { needed: true }));
    const q = queueWith([milk]);
    let known = mergeSnapshot({}, [milk], 1);
    expect(board(known, q, [], new Set()).toBuy).toHaveLength(1);
    known = mergeSnapshot(known, [], 2);
    expect(board(known, q, [], new Set()).toBuy).toHaveLength(0);
  });

  it("an item this device flagged needed shows at once, and stays after its answer, before any snapshot", () => {
    const salt = data(state(uid(), "on_demand"), { to_buy: 0 });
    let q = queueWith([salt]);
    const known = mergeFetched({}, [salt], 1);
    const e = buildOp("set_needed", salt, { needed: true }, tap);
    q = enqueue(q, e);
    expect(board(known, q, [], new Set()).toBuy.map((r) => r.id)).toEqual([salt.id]);
    q = { ...q, entries: q.entries.map((x) => ({ ...x, transmission: "transmitted" as const })) };
    q = onDelivered(q, [
      { client_op_id: e.op.client_op_id, result: "applied", rev: 1, item: { ...salt, needed: true, rev: 1 } },
    ]);
    expect(q.entries).toHaveLength(0);
    expect(board(known, q, [], new Set()).toBuy.map((r) => r.id)).toEqual([salt.id]);
  });

  it("a tick puts the row under Done and keeps it off the list, pinned ones too", () => {
    const bread = data(state(uid(), "pinned"));
    let q = queueWith([bread]);
    q = enqueue(q, buildOp("buy", bread, {}, tap, { tick: true }));
    const b = board(mergeSnapshot({}, [bread], 1), q, [], new Set());
    expect(b.toBuy).toHaveLength(0);
    expect(b.done.map((r) => r.id)).toEqual([bread.id]);
  });

  it("an order tapped on this device covers the item at once; the server's open orders count too", () => {
    const wipes = data(state(uid(), "units", { quantity: 0, min_quantity: 2 }), { to_buy: 2 });
    let q = queueWith([wipes]);
    const known = mergeSnapshot({}, [wipes], 1);
    q = enqueue(q, buildOp("mark_ordered", wipes, { order_id: "o1", quantity: 2 }, { ...tap, now: 5 }));
    const b = board(known, q, [], new Set());
    expect(b.toBuy).toHaveLength(0);
    expect(b.onTheWay.map((o) => o.order.id)).toEqual(["o1"]);
    const server: Order[] = [
      {
        id: "o2",
        item: wipes.id,
        item_name: "",
        quantity: 1,
        status: "open",
        reference: "",
        expected_on: null,
        ordered_at: "",
        ordered_by: null,
        overdue: false,
        bought_since_at: null,
        bought_since_by: null,
      },
    ];
    const partly = board(known, queueWith([wipes]), server, new Set());
    expect(partly.toBuy[0]!.quantity).toBe(1);
  });

  it("an answered order action shows until a snapshot that started after its answer; never one from before", () => {
    const item = data(state(uid(), "pinned"));
    const q0 = queueWith([item]);
    const e = buildOp("mark_ordered", item, { order_id: "o9" }, { ...tap, now: 100 });
    const q = { ...q0, recent: [{ ...e, transmission: "answered" as const, resultRev: 1 }] };
    // Answered after the last snapshot started: the snapshot's On the way may not have it yet.
    expect(openOrders([], q, new Set()).map((o) => o.id)).toEqual(["o9"]);
    // A snapshot that started after the answer is the server's word: no open order in it, none shown
    // (the order arrived on another phone).
    expect(openOrders([], q, new Set([e.op.client_op_id]))).toEqual([]);
    // Re-review: after a reload nothing is known and no snapshot has run yet; an old answer in `recent`
    // must not come back as a phantom order.
    expect(openOrders([], q, null)).toEqual([]);
  });

  it("a snapshot that leaves an item out covers the newer state the device held when it started", () => {
    // Off the list at rev 4; this device answered "out" at rev 5 (on the list); someone bought it (rev 6).
    const bread = data(state(uid(), "level", { level: "ok", rev: 4 }), { to_buy: 0 });
    let q = queueWith([bread]);
    let known = mergeFetched({}, [bread], 1);
    q = refreshed(q, [{ ...bread, level: "out", rev: 5 }]);
    expect(board(known, q, [], new Set()).toBuy.map((r) => r.id)).toEqual([bread.id]);
    // The next snapshot, started while the device held rev 5, does not list it: off the list for good.
    known = mergeSnapshot(known, [], 10, { [bread.id]: 5 });
    expect(board(known, q, [], new Set()).toBuy).toEqual([]);
    // A snapshot started BEFORE the answer (rev 4 then) does not cover rev 5: the device's state stands.
    expect(
      board(mergeSnapshot(mergeFetched({}, [bread], 1), [], 10, { [bread.id]: 4 }), q, [], new Set()).toBuy
    ).toHaveLength(1);
  });
});

describe("grouping and badges", () => {
  const row = (name: string, category: string, s: ItemState) => {
    const d = data(s, { name, category });
    return board(mergeSnapshot({}, [d], 1), queueWith([d]), [], new Set()).toBuy[0]!;
  };

  it("follows the person's aisle order, then names, with unnamed groups last", () => {
    const rows = [
      row("a", "", state(uid(), "pinned", { needed: true })),
      row("b", "Bakery", state(uid(), "pinned", { needed: true })),
      row("c", "Dairy", state(uid(), "pinned", { needed: true })),
      row("d", "Baby", state(uid(), "pinned", { needed: true })),
    ];
    expect(group(rows, "category", ["dairy"]).map((g) => g.label)).toEqual(["Dairy", "Baby", "Bakery", ""]);
  });

  it("low and out differ by text and icon, a negative count asks for a recount", () => {
    expect(badge(state("x", "level", { level: "out" }))).toBe("out");
    expect(badge(state("x", "level", { level: "low" }))).toBe("low");
    expect(badge(state("x", "units", { quantity: -1, min_quantity: 1 }))).toBe("recount");
    expect(badge(state("x", "units", { quantity: 1, min_quantity: 1 }))).toBe("ok");
    expect(badge(state("x", "units", { quantity: 0, min_quantity: 1 }))).toBe("below");
  });
});

describe("who can see a list", () => {
  const me = { id: "me", display_name: "Ana" };
  const bo = { id: "bo", display_name: "Bo" };
  it("says only you only for a secret project with nobody else and no admin outside", () => {
    expect(
      audience({ id: "p", name: "P", identifier: "P", network: 0, members: [me], admins_outside: 0 }, "me")
    ).toEqual({ kind: "only_you" });
    expect(
      audience({ id: "p", name: "P", identifier: "P", network: 0, members: [me], admins_outside: 1 }, "me").kind
    ).toBe("admins");
    expect(
      audience({ id: "p", name: "P", identifier: "P", network: 2, members: [me], admins_outside: 0 }, "me").kind
    ).toBe("public");
    expect(
      audience({ id: "p", name: "P", identifier: "P", network: 0, members: [me, bo], admins_outside: 0 }, "me")
    ).toEqual({ kind: "people", names: ["Bo"] });
  });
});
