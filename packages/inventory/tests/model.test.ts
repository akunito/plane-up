// Randomized: the device queue against a model of the server (plan, phase 3). Lost answers, failed
// requests, restarts from storage, two-hour holds, approvals, discards and undos happen at every point
// of an entry's life. Once the queue is empty (and the items a discard made doubtful are refreshed, as
// the app's polling does), what the device shows must equal what the server holds; nothing is applied
// twice; and nothing the person tapped disappears without the person discarding it.

import { describe, expect, it } from "vitest";

import {
  approve,
  createQueue,
  discard,
  discardHead,
  heldEntries,
  nextBatch,
  onDelivered,
  onFailed,
  refreshed,
  tap,
  undo,
  view,
  HOLD_AFTER_MS,
} from "../src/queue";
import { load, serialize } from "../src/storage";
import type { QueueState } from "../src/queue";
import type { ItemState } from "../src/types";
import { ModelServer } from "./model-server";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ITEMS: ItemState[] = [
  {
    id: "u1",
    rev: 0,
    mode: "units",
    needed: false,
    level: null,
    quantity: 2,
    min_quantity: 1,
    restock_to: null,
    last_bought_at: null,
    last_bought_by: null,
  },
  {
    id: "u2",
    rev: 0,
    mode: "units",
    needed: false,
    level: null,
    quantity: 0,
    min_quantity: 2,
    restock_to: 4,
    last_bought_at: null,
    last_bought_by: null,
  },
  {
    id: "l1",
    rev: 0,
    mode: "level",
    needed: false,
    level: "ok",
    quantity: null,
    min_quantity: null,
    restock_to: null,
    last_bought_at: null,
    last_bought_by: null,
  },
  {
    id: "d1",
    rev: 0,
    mode: "on_demand",
    needed: true,
    level: null,
    quantity: null,
    min_quantity: null,
    restock_to: null,
    last_bought_at: null,
    last_bought_by: null,
  },
];

const STATE_KEYS = ["mode", "needed", "level", "quantity", "rev"] as const;
const pick = (i: ItemState) => Object.fromEntries(STATE_KEYS.map((k) => [k, i[k]]));

function run(seed: number) {
  const r = rng(seed);
  const pickOf = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const server = new ModelServer(ITEMS);
  let ids = 0;
  const newId = () => `op-${seed}-${++ids}`;
  let now = 1_000_000;
  let state: QueueState = refreshed(createQueue("me", "queue-1"), server.snapshot());
  const tapped = new Set<string>();
  const discardedByUser = new Set<string>();

  const send = (lose: boolean) => {
    const next = nextBatch(state, now, "me");
    if (!next) return;
    state = next.state;
    const results = server.apply(next.batch, "me");
    state = lose ? onFailed(state, "offline", now) : onDelivered(state, results);
  };

  for (let step = 0; step < 60; step++) {
    const roll = r();
    if (roll < 0.45) {
      const item = pickOf(Object.values(view(state)));
      const known = state.known[item.id]!;
      const t = { now, newId };
      const before = state.entries.length;
      if (known.mode === "units") {
        const kind = pickOf(["adjust", "buy", "recount"] as const);
        const args =
          kind === "adjust"
            ? { delta: pickOf([-1, 1, 2]) }
            : kind === "buy"
              ? { quantity: pickOf([1, 2]) }
              : { quantity: pickOf([0, 3, 5]) };
        state = tap(state, kind, item.id, args, t, { tick: kind === "buy" });
      } else if (known.mode === "level") {
        state =
          r() < 0.5
            ? tap(state, "buy", item.id, {}, t, { tick: true })
            : tap(state, "set_level", item.id, { level: pickOf(["ok", "low", "out"]) }, t);
      } else {
        state =
          r() < 0.5
            ? tap(state, "buy", item.id, {}, t, { tick: true })
            : tap(state, "set_needed", item.id, { needed: r() < 0.5 }, t);
      }
      if (state.entries.length > before) tapped.add(state.entries.at(-1)!.op.client_op_id);
    } else if (roll < 0.55) {
      const candidates = [
        ...state.entries.filter((e) => e.op.op !== "revert"),
        ...state.recent.filter((e) => e.op.op !== "revert"),
      ];
      if (candidates.length) {
        const target = pickOf(candidates).op.client_op_id;
        const before = new Set(state.entries.map((e) => e.op.client_op_id));
        const wasQueued = before.has(target);
        state = undo(state, target, { now, newId });
        for (const e of state.entries) if (!before.has(e.op.client_op_id)) tapped.add(e.op.client_op_id);
        if (wasQueued && !state.entries.some((e) => e.op.client_op_id === target)) discardedByUser.add(target); // removed by undo: the person's choice
      }
    } else if (roll < 0.7) send(false);
    else if (roll < 0.78)
      send(true); // the server applied, the answer was lost
    else if (roll < 0.82) {
      const next = nextBatch(state, now, "me"); // the request never reached the server
      if (next) state = onFailed(next.state, "server", now);
    } else if (roll < 0.87) {
      const loaded = load(serialize(state)); // the app was killed and reopened
      expect(loaded.ok).toBe(true);
      if (loaded.ok) state = loaded.state;
    } else if (roll < 0.92) now += Math.floor(r() * HOLD_AFTER_MS * 1.6);
    else if (roll < 0.96) {
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
          state = discard(state, victim);
          discardedByUser.add(victim);
        }
      }
    } else if (state.failure && state.failure.attempts > 2 && state.entries.length) {
      const head = state.entries[0]!.op.client_op_id;
      state = discardHead(state);
      discardedByUser.add(head);
    }
    now += 500;
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
  state = refreshed(
    state,
    server.snapshot().filter((i) => state.needsRefresh.includes(i.id))
  );

  const shown = view(state);
  for (const item of server.snapshot())
    expect(pick(shown[item.id]!), `item ${item.id} seed ${seed}`).toEqual(pick(item));
  for (const [id, n] of server.effects) expect(n, id).toBe(1);
  // Nothing vanished by itself: every tapped operation reached the server or was discarded by the person.
  for (const id of tapped) expect(server.ledger.has(id) || discardedByUser.has(id), id).toBe(true);
}

describe("the device queue against a model server", () => {
  for (let seed = 1; seed <= 40; seed++) it(`seed ${seed}`, () => run(seed));
});
