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
  isHeld,
  MAX_BATCH,
  nextBatch,
  onDelivered,
  onFailed,
  onRestart,
  refreshed,
  retryNow,
  retryOutdated,
  tap,
  undo,
  view,
  waiting,
} from "../src/queue";
import type { QueueState } from "../src/queue";
import { OP_VERSION } from "../src/ops";
import { load, serialize } from "../src/storage";
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

describe("phase 9 scenario matrix (APLANE-67)", () => {
  it("S09: a mixed answer applies the good ones, empties the queue and shows each refusal", () => {
    const items = ["a", "b", "c", "d"].map((id) => item({ id, mode: "on_demand", quantity: null, min_quantity: null }));
    let s = start(items);
    for (const id of ["a", "b", "c", "d"]) s = tap(s, "buy", id, {}, t());
    const sent = nextBatch(s, 1_000_000, "ana")!;
    const [a, b, c, d] = sent.batch;
    s = onDelivered(sent.state, [
      { client_op_id: a!.client_op_id, result: "applied", item: items[0]! },
      { client_op_id: b!.client_op_id, result: "rejected", reason: "gone" },
      { client_op_id: c!.client_op_id, result: "rejected", reason: "forbidden" },
      { client_op_id: d!.client_op_id, result: "rejected", reason: "invalid_for_mode" },
    ]);
    expect(s.entries).toHaveLength(0);
    expect(s.notices.map((x) => [x.kind, x.reason])).toEqual([
      ["rejected", "gone"],
      ["rejected", "forbidden"],
      ["rejected", "invalid_for_mode"],
    ]);
    expect(s.failure).toBeNull();
  });

  it("S38: two offline taps both refused as stale are both shown", () => {
    const lvl = item({ mode: "level", level: "ok", quantity: null, min_quantity: null });
    let s = tap(start([lvl]), "set_level", "milk", { level: "low" }, t());
    s = tap(s, "set_level", "milk", { level: "out" }, t());
    const sent = nextBatch(s, 1_000_000, "ana")!;
    const fresh = { ...lvl, rev: 9, level: "ok" as const };
    s = onDelivered(
      sent.state,
      sent.batch.map((o) => ({ client_op_id: o.client_op_id, result: "stale" as const, item: fresh }))
    );
    expect(s.entries).toHaveLength(0);
    expect(s.notices.map((x) => x.kind)).toEqual(["stale", "stale"]);
    expect(view(s).milk!.level).toBe("ok");
  });

  it("S59: a queue of 250 is delivered in order, in three requests", () => {
    let s = start();
    for (let i = 0; i < 250; i++) s = tap(s, "adjust", "milk", { delta: 1 }, t());
    const order = ids(s);
    const delivered: string[] = [];
    let requests = 0;
    for (;;) {
      const sent = nextBatch(s, 1_000_000, "ana");
      if (!sent) break;
      requests++;
      delivered.push(...sent.batch.map((o) => o.client_op_id));
      s = onDelivered(
        sent.state,
        sent.batch.map((o) => ({ client_op_id: o.client_op_id, result: "applied" as const }))
      );
    }
    expect(requests).toBe(3);
    expect(delivered).toEqual(order);
    expect(waiting(s)).toBe(0);
  });

  it("S27: a phone clock wrong by days changes only the shown age and whether it asks first", () => {
    const day = 24 * 60 * 60 * 1000;
    // Tapped with the clock 3 days AHEAD, delivered after it was corrected: the age is never negative and
    // nothing is held.
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t(1_000_000 + 3 * day));
    expect(isHeld(s.entries[0]!, 1_000_000)).toBe(false);
    expect(nextBatch(s, 1_000_000, "ana")!.batch[0]!.age_ms).toBe(0);
    // Tapped with the clock 3 days BEHIND: after the correction it looks old, so the phone asks first.
    s = tap(start(), "adjust", "milk", { delta: 1 }, t(1_000_000 - 3 * day));
    expect(isHeld(s.entries[0]!, 1_000_000)).toBe(true);
    expect(nextBatch(s, 1_000_000, "ana")).toBeNull();
  });
});

describe("a server that no longer accepts this build's format (S25)", () => {
  it("keeps the refused entries, sends nothing more until the app is a newer build, and the rest still applies", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
    s = tap(s, "adjust", "milk", { delta: -1 }, t());
    const sent = nextBatch(s, 2_000_000, "ana")!;
    const [first, second] = sent.batch;
    s = onDelivered(sent.state, [
      { client_op_id: first!.client_op_id, result: "rejected", reason: "unsupported_version" },
      { client_op_id: second!.client_op_id, result: "applied", item: item({ rev: 4 }) },
    ]);
    expect(ids(s)).toEqual([first!.client_op_id]);
    expect(s.notices).toHaveLength(0);
    expect(s.failure).toMatchObject({ kind: "outdated", opVersion: OP_VERSION });
    // Not by backoff, retry or a store open (the worker opens the store on every sync: phase 9 re-review); the
    // page tries once more per load (retryOutdated), so a server fixed after refusing this format does not leave
    // the queue blocked for good.
    expect(nextBatch(s, 3_000_000, "ana")).toBeNull();
    expect(nextBatch(retryNow(s), 3_000_000, "ana")).toBeNull();
    expect(nextBatch(onRestart(s), 3_000_000, "ana")).toBeNull();
    const reloaded = load(serialize(s));
    expect(reloaded.ok && nextBatch(reloaded.state, 3_000_000, "ana")).toBeNull();
    expect(nextBatch(retryOutdated(s), 3_000_000, "ana")!.batch.map((o) => o.client_op_id)).toEqual([
      first!.client_op_id,
    ]);
    const updated = { ...s, failure: { ...s.failure!, opVersion: OP_VERSION - 1 } };
    expect(nextBatch(updated, 3_000_000, "ana")!.batch.map((o) => o.client_op_id)).toEqual([first!.client_op_id]);
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

  it("an entry whose attempt failed offline is held too after two hours, and once approved goes with its id", () => {
    // Decision 3 (owner 2026-11-22): the failed attempt marked it transmitted; it must still ask.
    let s = tap(start(), "buy", "milk", {}, t(0));
    const first = nextBatch(s, 0, "ana")!;
    s = onFailed(first.state, "offline", 0);
    expect(heldEntries(s, HOLD_AFTER_MS * 2).map((e) => e.op.client_op_id)).toEqual(ids(s));
    expect(nextBatch(onRestart(s), HOLD_AFTER_MS * 2, "ana")).toBeNull();
    s = approve(s, ids(s), HOLD_AFTER_MS * 2);
    expect(nextBatch(onRestart(s), HOLD_AFTER_MS * 2, "ana")!.batch[0]!.client_op_id).toBe(
      first.batch[0]!.client_op_id
    );
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
