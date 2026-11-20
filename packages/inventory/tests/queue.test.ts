// The queue's rules, one by one, and the client-side scenarios of the plan's catalogue.

import { describe, expect, it } from "vitest";

import {
  applyAnyway,
  approve,
  createQueue,
  discard,
  discardHead,
  DISCARD_ONLY_AFTER_MS,
  heldEntries,
  HOLD_AFTER_MS,
  MAX_BATCH,
  nextBatch,
  onDelivered,
  onFailed,
  onRestart,
  refreshed,
  tap,
  undo,
  view,
  waiting,
} from "../src/queue";
import type { QueueState } from "../src/queue";
import type { ItemState } from "../src/types";

const item = (over: Partial<ItemState> = {}): ItemState => ({
  id: "milk",
  rev: 3,
  mode: "units",
  needed: false,
  level: null,
  quantity: 2,
  min_quantity: 1,
  restock_to: null,
  last_bought_at: null,
  last_bought_by: null,
  ...over,
});

let n = 0;
const t = (now = 1_000_000) => ({ now, newId: () => `op-${++n}` });
const start = (items: ItemState[] = [item()], user = "ana"): QueueState => refreshed(createQueue(user, "q-ana"), items);
const ids = (s: QueueState) => s.entries.map((e) => e.op.client_op_id);

describe("building operations", () => {
  it("statements carry the revision the SERVER last sent, never an optimistic one", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
    s = tap(s, "recount", "milk", { quantity: 9 }, t());
    expect(view(s).milk!.quantity).toBe(9);
    expect(s.entries[1]!.op.base_rev).toBe(3);
    expect(s.entries[0]!.op.base_rev).toBeUndefined();
    expect(s.entries.every((e) => e.op.queue_id === "q-ana" && e.op.v === 1)).toBe(true);
  });

  it("age is computed when sending, from the tap time", () => {
    const s = tap(start(), "buy", "milk", {}, t(1000));
    expect(nextBatch(s, 61_000, "ana")!.batch[0]!.age_ms).toBe(60_000);
  });
});

describe("sending", () => {
  it("is strictly first-in, first-out, at most 100 per request, one replay at a time", () => {
    let s = start();
    for (let i = 0; i < 150; i++) s = tap(s, "adjust", "milk", { delta: 1 }, t());
    const first = nextBatch(s, 1_000_000, "ana")!;
    expect(first.batch.map((o) => o.client_op_id)).toEqual(ids(s).slice(0, MAX_BATCH));
    expect(nextBatch(first.state, 1_000_000, "ana")).toBeNull(); // a replay is running
  });

  it("another user's queue is never sent (S24)", () => {
    const s = tap(start(), "buy", "milk", {}, t());
    expect(nextBatch(s, 1_000_000, "bob")).toBeNull();
    expect(nextBatch(s, 1_000_000, "ana")).not.toBeNull();
  });

  it("a failed request keeps every entry with the same ids and backs off (S40)", () => {
    let s = tap(start(), "buy", "milk", {}, t());
    const sent = nextBatch(s, 1_000_000, "ana")!;
    s = onFailed(sent.state, "offline", 1_000_000);
    expect(ids(s)).toEqual(sent.batch.map((o) => o.client_op_id));
    expect(s.entries[0]!.transmission).toBe("transmitted");
    expect(nextBatch(s, 1_000_100, "ana")).toBeNull(); // backing off
    const retry = nextBatch(s, 1_010_000, "ana")!;
    expect(retry.batch[0]!.client_op_id).toBe(sent.batch[0]!.client_op_id);
  });

  it("answered entries leave; unanswered ones stay for the retry", () => {
    let s = tap(tap(start(), "buy", "milk", {}, t()), "adjust", "milk", { delta: 1 }, t());
    const sent = nextBatch(s, 1_000_000, "ana")!;
    s = onDelivered(sent.state, [
      { client_op_id: sent.batch[0]!.client_op_id, result: "applied", item: item({ rev: 4, quantity: 3 }) },
    ]);
    expect(ids(s)).toEqual([sent.batch[1]!.client_op_id]);
    expect(s.known.milk!.rev).toBe(4);
  });

  it("a restart forgets the running replay but not the entries", () => {
    const sent = nextBatch(tap(start(), "buy", "milk", {}, t()), 1_000_000, "ana")!;
    const s = onRestart(sent.state);
    expect(s.sending).toBe(false);
    expect(s.entries[0]!.transmission).toBe("transmitted");
  });
});

describe("holds (S35, S66, S68)", () => {
  it("an entry older than two hours is held, blocks everything behind it, and is sent once approved", () => {
    let s = tap(start(), "set_level", "milk", { level: "out" }, t(0));
    s = tap(s, "adjust", "milk", { delta: 1 }, t(HOLD_AFTER_MS + 5));
    const now = HOLD_AFTER_MS + 10;
    expect(heldEntries(s, now).map((e) => e.op.client_op_id)).toEqual([ids(s)[0]]);
    expect(nextBatch(s, now, "ana")).toBeNull(); // the fresh one behind it is not sent either
    s = approve(s, [ids(s)[0]!], now);
    expect(nextBatch(s, now, "ana")!.batch).toHaveLength(2);
  });

  it("a transmitted entry is never held: it was already sent", () => {
    let s = tap(start(), "buy", "milk", {}, t(0));
    s = onFailed(nextBatch(s, 0, "ana")!.state, "offline", 0);
    expect(heldEntries(s, HOLD_AFTER_MS * 2)).toEqual([]);
  });

  it("an entry older than 60 days can only be discarded", () => {
    let s = tap(start(), "buy", "milk", {}, t(0));
    const now = DISCARD_ONLY_AFTER_MS + 1;
    s = approve(s, ids(s), now);
    expect(nextBatch(s, now, "ana")).toBeNull();
    s = discard(s, ids(s)[0]!);
    expect(s.entries).toEqual([]);
  });
});

describe("undo (S39, S65)", () => {
  it("a never-sent tap is simply removed", () => {
    let s = tap(start(), "adjust", "milk", { delta: -1 }, t());
    s = undo(s, ids(s)[0]!, t());
    expect(s.entries).toEqual([]);
    expect(view(s).milk!.quantity).toBe(2);
  });

  it("a sent tap with no answer yet is reverted on the server, not removed", () => {
    let s = tap(start(), "adjust", "milk", { delta: -1 }, t());
    const first = ids(s)[0]!;
    s = onFailed(nextBatch(s, 1_000_000, "ana")!.state, "offline", 1_000_000); // answer lost
    s = undo(s, first, t());
    expect(s.entries.map((e) => e.op.op)).toEqual(["adjust", "revert"]);
    expect(s.entries[1]!.op.args).toEqual({ reverts: first });
    expect(view(s).milk!.quantity).toBe(2);
  });

  it("an answered tap is reverted too, and the preview is right", () => {
    let s = tap(start(), "adjust", "milk", { delta: -1 }, t());
    const sent = nextBatch(s, 1_000_000, "ana")!;
    s = onDelivered(sent.state, [
      { client_op_id: sent.batch[0]!.client_op_id, result: "applied", item: item({ rev: 4, quantity: 1 }) },
    ]);
    s = undo(s, sent.batch[0]!.client_op_id, t());
    expect(s.entries.map((e) => e.op.op)).toEqual(["revert"]);
    expect(view(s).milk!.quantity).toBe(2);
  });
});

describe("refusals, discards and Done (S41, S70)", () => {
  it("a refused tick leaves Done and the person is told", () => {
    let s = tap(start([item({ mode: "pinned", quantity: null })]), "buy", "milk", {}, t(), { tick: true });
    expect(s.done.milk).toBe(ids(s)[0]);
    const sent = nextBatch(s, 1_000_000, "ana")!;
    s = onDelivered(sent.state, [
      { client_op_id: sent.batch[0]!.client_op_id, result: "rejected", reason: "forbidden" },
    ]);
    expect(s.done.milk).toBeUndefined();
    expect(s.notices.map((x) => [x.kind, x.reason])).toEqual([["rejected", "forbidden"]]);
  });

  it("discarding the head of a blocked queue takes its reverts and its tick, and says it may have applied", () => {
    let s = tap(start(), "buy", "milk", { quantity: 1 }, t(), { tick: true });
    const head = ids(s)[0]!;
    s = onFailed(nextBatch(s, 1_000_000, "ana")!.state, "server", 1_000_000);
    s = undo(s, head, t()); // queues a revert of the head
    s = tap(s, "adjust", "milk", { delta: 1 }, t());
    s = discardHead(s);
    expect(s.entries.map((e) => e.op.op)).toEqual(["adjust"]);
    expect(s.done.milk).toBeUndefined();
    expect(s.notices.at(-1)).toMatchObject({ kind: "discarded", mayHaveApplied: true });
    expect(s.needsRefresh).toEqual(["milk"]);
  });

  it("apply anyway exists only for stale, as a new operation with the fresh revision", () => {
    let s = tap(
      start([item({ mode: "level", level: "low", quantity: null })]),
      "set_level",
      "milk",
      { level: "out" },
      t()
    );
    const sent = nextBatch(s, 1_000_000, "ana")!;
    const fresh = item({ mode: "level", level: "ok", quantity: null, rev: 9 });
    s = onDelivered(sent.state, [{ client_op_id: sent.batch[0]!.client_op_id, result: "stale", item: fresh }]);
    const notice = s.notices[0]!;
    s = applyAnyway(s, notice, t());
    expect(s.entries[0]!.op.client_op_id).not.toBe(sent.batch[0]!.client_op_id);
    expect(s.entries[0]!.op.base_rev).toBe(9);
    expect(() => applyAnyway(s, { ...notice, kind: "rejected" }, t())).toThrow();
  });
});

it("says how many changes are waiting", () => {
  expect(waiting(tap(tap(start(), "buy", "milk", {}, t()), "buy", "milk", {}, t()))).toBe(2);
});
