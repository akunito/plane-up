// Randomized: the device queue against a model of the server (plan, phase 3). Lost answers, failed
// requests, restarts from storage, two-hour holds, approvals, discards, undos, order actions and a
// second person changing items on the server happen at every point of an entry's life.
//
// Invariants:
// - At every step, the PREVIEW: for every item whose known revision is the server's, what the device
//   shows equals what the server would hold if the queue were delivered now (a copy of the model
//   applies it). Left out: items where the copy answers stale (someone else's change is the one thing
//   the device cannot foresee), and an undo after a lost-then-duplicate answer (accepted, queue.ts).
// - Retries never mint ids: every id the server received from this device is one the person tapped
//   (the server's ledger makes a repeated id harmless, so "applied once" is the ledger's property).
// - Nothing tapped disappears unless the person removed it, and a discard or undo removes only the
//   entry and what depends on it (its undos; for a never-sent order, its arrivals and cancels).
// - Once the queue is empty, the device shows exactly what the server holds for every item nobody
//   else touched and that no discard made doubtful; after refreshing those (fetchListItems), for all.

import { describe, expect, it } from "vitest";

import {
  applyAnyway,
  approve,
  createQueue,
  discard,
  discardHead,
  dismiss,
  heldEntries,
  HOLD_AFTER_MS,
  nextBatch,
  onDelivered,
  onFailed,
  refreshed,
  tap,
  undo,
  view,
} from "../src/queue";
import type { QueueState } from "../src/queue";
import type { Entry } from "../src/ops";
import { load, serialize } from "../src/storage";
import type { ItemState, Operation } from "../src/types";
import { ModelServer } from "./model-server";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const base = {
  needed: false,
  level: null,
  quantity: null,
  min_quantity: null,
  restock_to: null,
  last_bought_at: null,
  last_bought_by: null,
};
const ITEMS: ItemState[] = [
  { ...base, id: "u1", rev: 0, mode: "units", quantity: 2, min_quantity: 1 },
  { ...base, id: "u2", rev: 0, mode: "units", quantity: 0, min_quantity: 2, restock_to: 4 },
  { ...base, id: "l1", rev: 0, mode: "level", level: "ok" },
  { ...base, id: "d1", rev: 0, mode: "on_demand", needed: true },
];

const newId = () => crypto.randomUUID();

const STATE_KEYS = ["mode", "needed", "level", "quantity"] as const;
const pick = (i: ItemState) => Object.fromEntries(STATE_KEYS.map((k) => [k, i[k]]));

function run(seed: number) {
  const r = rng(seed);
  const pickOf = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const server = new ModelServer(ITEMS);
  let now = 1_000_000;
  let state: QueueState = refreshed(createQueue("me", crypto.randomUUID()), server.snapshot());
  const bobQueue = crypto.randomUUID();
  const tapped = new Set<string>();
  const discardedByUser = new Set<string>();
  // Orders the screen would offer: created here and not known to be refused, discarded or received.
  const myOrders = new Map<string, { item: string; quantity: number; markId: string }>();

  const bobTouched = new Set<string>();
  const sentByMe = new Set<string>();
  // Whatever leaves the queue by the person's own action, checked against what may leave with it.
  const byHand = (target: string, change: () => void) => {
    const before = state.entries;
    const chosen = before.find((e) => e.op.client_op_id === target);
    change();
    const after = new Set(state.entries.map((e) => e.op.client_op_id));
    for (const e of before) {
      if (after.has(e.op.client_op_id)) continue;
      const allowed =
        e.op.client_op_id === target ||
        (e.op.op === "revert" && e.op.args.reverts === target) ||
        (chosen?.op.op === "mark_ordered" &&
          chosen.transmission === "never" &&
          (e.op.op === "arrived" || e.op.op === "cancel") &&
          e.op.args.order_id === chosen.op.args.order_id);
      expect(allowed, `removed ${e.op.op} along with ${chosen?.op.op}`).toBe(true);
      discardedByUser.add(e.op.client_op_id);
    }
  };

  const send = (lose: boolean) => {
    const next = nextBatch(state, now, "me");
    if (!next) return;
    state = next.state;
    for (const o of next.batch) sentByMe.add(o.client_op_id);
    const results = server.apply(next.batch, "me");
    state = lose ? onFailed(state, "offline", now) : onDelivered(state, results);
  };

  const checkPreview = () => {
    const shown = view(state);
    const copy = server.clone();
    const stale = new Set<string>();
    for (const e of state.entries) {
      const [res] = copy.apply([e.op as Operation], "me");
      if (res!.result === "stale") stale.add(e.op.target);
    }
    // Accepted (queue.ts header): an undo (other than of a ±n) of a step whose prior server state the
    // device never held is not previewed until answered.
    const unknownUndo = new Set(
      state.entries
        .filter((e) => e.op.op === "revert")
        .map((e) => state.recent.find((x) => x.op.client_op_id === e.op.args.reverts))
        .filter((x): x is Entry => x !== undefined && !x.serverBefore && x.op.op !== "adjust")
        .map((x) => x.op.target)
    );
    // Accepted too: an arrival or cancel of an order the device holds no record of (its order sent and
    // then discarded, or older than the last 50 applied entries) is previewed as applied.
    const seenOrders = new Set(
      [...state.recent, ...state.entries].filter((e) => e.op.op === "mark_ordered").map((e) => e.op.args.order_id)
    );
    const unknownOrder = new Set(
      state.entries
        .filter((e) => (e.op.op === "arrived" || e.op.op === "cancel") && !seenOrders.has(e.op.args.order_id))
        .map((e) => e.op.target)
    );
    for (const item of server.snapshot()) {
      if (state.known[item.id]?.rev !== item.rev || stale.has(item.id) || unknownUndo.has(item.id)) continue;
      if (unknownOrder.has(item.id)) continue;
      const why = () =>
        JSON.stringify({
          known: pick(state.known[item.id]!),
          rev: item.rev,
          queue: state.entries
            .filter((e) => e.op.target === item.id)
            .map((e) => [e.op.op, e.op.args, e.transmission, e.orderQuantity]),
          recent: state.recent
            .filter((e) => e.op.target === item.id)
            .slice(-3)
            .map((e) => [e.op.op, e.op.args, e.resultRev, e.undone]),
        });
      expect(pick(shown[item.id]!), `preview of ${item.id}, seed ${seed}: ${why()}`).toEqual(
        pick(copy.items.get(item.id)!)
      );
    }
  };

  for (let step = 0; step < 80; step++) {
    const roll = r();
    if (roll < 0.4) {
      const item = pickOf(Object.values(view(state)));
      const known = state.known[item.id]!;
      const t = { now, newId };
      const before = state.entries.length;
      if (known.mode === "units") {
        const kind = pickOf(["adjust", "buy", "recount", "mark_ordered", "arrived", "cancel"] as const);
        const mine = [...myOrders].filter(([, o]) => o.item === item.id);
        if (kind === "mark_ordered") {
          const orderId = crypto.randomUUID();
          const quantity = pickOf([1, 3]);
          state = tap(state, kind, item.id, { order_id: orderId, quantity }, t);
          myOrders.set(orderId, { item: item.id, quantity, markId: state.entries.at(-1)!.op.client_op_id });
        } else if ((kind === "arrived" || kind === "cancel") && mine.length) {
          const [orderId, order] = pickOf(mine);
          state = tap(state, kind, item.id, { order_id: orderId }, t, { orderQuantity: order.quantity });
          // A received order leaves "On the way": no second arrival is offered (a double tap while the
          // first is queued is a unit test of view()).
          if (kind === "arrived") myOrders.delete(orderId);
        } else if (kind === "adjust") state = tap(state, kind, item.id, { delta: pickOf([-1, 1, 2]) }, t);
        else if (kind === "recount") state = tap(state, kind, item.id, { quantity: pickOf([0, 3, 5]) }, t);
        else state = tap(state, "buy", item.id, { quantity: pickOf([1, 2]) }, t, { tick: true });
      } else if (known.mode === "level") {
        state =
          r() < 0.5
            ? tap(state, "buy", item.id, {}, t, { tick: true })
            : tap(state, "set_level", item.id, { level: pickOf(["ok", "low", "out"]) }, t);
      } else {
        const kind = r();
        if (kind < 0.4) state = tap(state, "buy", item.id, {}, t, { tick: true });
        else if (kind < 0.8) state = tap(state, "set_needed", item.id, { needed: r() < 0.5 }, t);
        else state = tap(state, "pin", item.id, { pinned: r() < 0.5 }, t);
      }
      if (state.entries.length > before) tapped.add(state.entries.at(-1)!.op.client_op_id);
      if (r() < 0.06) {
        // Mode changes, and arguments the engine refuses (the preview must predict the refusal).
        const odd = pickOf([
          ["change_mode", { mode: "units", quantity: pickOf([0, 2]) }],
          ["change_mode", { mode: pickOf(["level", "on_demand", "pinned"]) }],
          ["change_mode", { mode: "units" }],
          ["adjust", { delta: pickOf([0, 1.5]) }],
          ["buy", { quantity: 0 }],
          ["set_needed", { needed: "yes" }],
          ["recount", { quantity: -0.5 }],
        ] as const);
        state = tap(state, odd[0], item.id, odd[1] as Record<string, unknown>, t);
      }
      if (state.entries.length > before) tapped.add(state.entries.at(-1)!.op.client_op_id);
    } else if (roll < 0.5) {
      const candidates = [...state.entries, ...state.recent];
      if (candidates.length) {
        const target = pickOf(candidates).op.client_op_id;
        const before = new Set(state.entries.map((e) => e.op.client_op_id));
        byHand(target, () => (state = undo(state, target, { now, newId })));
        for (const e of state.entries) if (!before.has(e.op.client_op_id)) tapped.add(e.op.client_op_id);
      }
    } else if (roll < 0.62) send(false);
    else if (roll < 0.68)
      send(true); // the server applied, the answer was lost
    else if (roll < 0.71) {
      const next = nextBatch(state, now, "me"); // the request never reached the server
      if (next) state = onFailed(next.state, "server", now);
    } else if (roll < 0.75) {
      const loaded = load(serialize(state)); // the app was killed and reopened
      expect(loaded.ok).toBe(true);
      if (loaded.ok) state = loaded.state;
    } else if (roll < 0.79) now += Math.floor(r() * HOLD_AFTER_MS * 1.6);
    else if (roll < 0.83) {
      const held = heldEntries(state, now);
      if (held.length) {
        if (r() < 0.6)
          state = approve(
            state,
            held.map((e) => e.op.client_op_id),
            now
          );
        else {
          const victim = held[0]!.op.client_op_id;
          byHand(victim, () => (state = discard(state, victim)));
        }
      }
    } else if (roll < 0.91) {
      // Someone else, on their own phone, with fresh data.
      const item = pickOf(server.snapshot());
      const op: Operation = {
        v: 1,
        client_op_id: crypto.randomUUID(),
        queue_id: bobQueue,
        target: item.id,
        op: "buy",
        args: {},
      };
      if (item.mode === "units" && r() < 0.5)
        Object.assign(op, { op: "recount", args: { quantity: pickOf([1, 4]) }, base_rev: item.rev });
      else if (item.mode === "level" && r() < 0.5)
        Object.assign(op, { op: "set_level", args: { level: "low" }, base_rev: item.rev });
      else if (item.mode === "on_demand" && r() < 0.5)
        Object.assign(op, { op: "set_needed", args: { needed: true }, base_rev: item.rev });
      if (r() < 0.15) {
        const mode = pickOf(["units", "level", "on_demand", "pinned"] as const);
        Object.assign(op, {
          op: "change_mode",
          args: mode === "units" ? { mode, quantity: 1 } : { mode },
          base_rev: item.rev,
        });
      }
      bobTouched.add(item.id);
      server.apply([op], "bob");
    } else if (roll < 0.95) {
      const notice = state.notices.find((n) => n.kind === "stale");
      if (notice) {
        const before = state.entries.length;
        state = r() < 0.5 ? applyAnyway(state, notice, { now, newId }) : dismiss(state, notice);
        if (state.entries.length > before) tapped.add(state.entries.at(-1)!.op.client_op_id);
      }
    } else if (state.failure && state.failure.attempts > 2 && state.entries.length) {
      const head = state.entries[0]!.op.client_op_id;
      byHand(head, () => (state = discardHead(state)));
    }
    now += 500;
    for (const [id, o] of myOrders) {
      const answer = server.ledger.get(o.markId);
      if (discardedByUser.has(o.markId) || (answer && answer.result.result !== "applied")) myOrders.delete(id);
    }
    checkPreview();
  }

  // Drain: the person approves whatever is held, the network comes back, nothing is lost any more.
  for (let i = 0; i < 50 && state.entries.length; i++) {
    state = approve(
      state,
      heldEntries(state, now).map((e) => e.op.client_op_id),
      now
    );
    now += 10 * 60 * 1000;
    send(false);
  }
  expect(state.entries).toEqual([]);
  const full = (i: ItemState | undefined) => i && { ...pick(i), rev: i.rev };
  for (const item of server.snapshot()) {
    if (bobTouched.has(item.id) || state.needsRefresh.includes(item.id)) continue;
    expect(full(view(state)[item.id]), `item ${item.id} seed ${seed}, before any refresh`).toEqual(full(item));
  }
  state = refreshed(state, server.snapshot());
  for (const item of server.snapshot())
    expect(full(view(state)[item.id]), `item ${item.id} seed ${seed}`).toEqual(full(item));
  for (const id of sentByMe) expect(tapped.has(id), `sent an id nobody tapped: ${id}`).toBe(true);
  for (const id of tapped) expect(server.ledger.has(id) || discardedByUser.has(id), id).toBe(true);
}

describe("the device queue against a model server", () => {
  const seeds = Number(process.env.INVENTORY_SEEDS ?? 200);
  for (let seed = 1; seed <= seeds; seed++) it(`seed ${seed}`, () => run(seed));
});
