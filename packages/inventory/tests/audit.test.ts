// One test per phase 3 audit finding on the queue's rules.

import { describe, expect, it } from "vitest";

import {
  answeredCount,
  applyAnyway,
  BACKOFF_MAX_MS,
  createQueue,
  discard,
  DISCARD_ONLY_AFTER_MS,
  finishShopping,
  heldEntries,
  nextBatch,
  onDelivered,
  onFailed,
  refreshed,
  retryNow,
  tap,
  undo,
  view,
} from "../src/queue";
import type { QueueState } from "../src/queue";
import { load, newQueue, serialize, storageKey } from "../src/storage";
import type { ItemState, OpResult } from "../src/types";

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
const t = (now = 1_000_000) => ({ now, newId: () => crypto.randomUUID() });
const start = (items: ItemState[] = [item()]): QueueState => refreshed(createQueue("ana", crypto.randomUUID()), items);

function deliver(s: QueueState, answer: (id: string, i: number) => Partial<OpResult>, now = 1_000_000) {
  const sent = nextBatch(s, now, "ana")!;
  return onDelivered(
    sent.state,
    sent.batch.map(
      (o, i) =>
        Object.assign({ client_op_id: o.client_op_id, result: "applied" }, answer(o.client_op_id, i)) as OpResult
    )
  );
}

describe("what the device knows only moves forward", () => {
  it("a slower, older snapshot does not undo a newer answer", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
    s = deliver(s, () => ({ item: item({ rev: 4, quantity: 3 }), rev: 4 }));
    s = refreshed(s, [item({ rev: 3, quantity: 2 })]);
    expect(view(s).milk).toMatchObject({ rev: 4, quantity: 3 });
  });

  it("apply anyway uses the freshest revision, not an older stale answer", () => {
    let s = start([item({ mode: "level", level: "ok", quantity: null })]);
    s = tap(s, "set_level", "milk", { level: "out" }, t());
    s = deliver(s, () => ({ result: "stale", item: item({ mode: "level", level: "low", quantity: null, rev: 5 }) }));
    s = refreshed(s, [item({ mode: "level", level: "low", quantity: null, rev: 7 })]);
    s = applyAnyway(s, s.notices[0]!, t());
    expect(s.entries[0]!.op.base_rev).toBe(7);
  });
});

describe("gone", () => {
  it("with an item (a missing order or undone event) keeps the item", () => {
    let s = tap(start(), "cancel", "milk", { order_id: crypto.randomUUID() }, t());
    s = deliver(s, () => ({ result: "rejected", reason: "gone", item: item({ rev: 3 }) }));
    expect(view(s).milk).toBeDefined();
    expect(() => tap(s, "adjust", "milk", { delta: 1 }, t())).not.toThrow();
  });

  it("without an item (the item itself) drops it", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
    s = deliver(s, () => ({ result: "rejected", reason: "gone" }));
    expect(view(s).milk).toBeUndefined();
  });
});

it("answers match ids whatever their case (the server canonicalises UUIDs)", () => {
  let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
  const sent = nextBatch(s, 1_000_000, "ana")!;
  const results = [{ client_op_id: sent.batch[0]!.client_op_id.toUpperCase(), result: "applied" as const }];
  expect(answeredCount(sent.batch, results)).toBe(1);
  s = onDelivered(sent.state, results);
  expect(s.entries).toEqual([]);
});

describe("backoff", () => {
  it("a backoff longer than its maximum means the clock went back: it is over", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t(10 * 86_400_000));
    s = onFailed(nextBatch(s, 10 * 86_400_000, "ana")!.state, "offline", 10 * 86_400_000);
    expect(nextBatch(s, 10 * 86_400_000 + 10, "ana")).toBeNull();
    expect(nextBatch(s, 10 * 86_400_000 - 86_400_000, "ana")).not.toBeNull(); // clock moved back a day
    expect(BACKOFF_MAX_MS).toBeLessThan(86_400_000);
  });

  it("opening the app or coming online retries at once", () => {
    let s = tap(start(), "adjust", "milk", { delta: 1 }, t());
    s = onFailed(nextBatch(s, 1_000_000, "ana")!.state, "offline", 1_000_000);
    expect(nextBatch(s, 1_000_001, "ana")).toBeNull();
    expect(nextBatch(retryNow(s), 1_000_001, "ana")).not.toBeNull();
    const loaded = load(serialize(s));
    expect(loaded.ok && nextBatch(loaded.state, 1_000_001, "ana")).toBeTruthy();
  });
});

it("an entry older than 60 days is discard-only even if it was sent (the ledger is pruned at 90)", () => {
  let s = tap(start(), "buy", "milk", {}, t(0));
  s = onFailed(nextBatch(s, 0, "ana")!.state, "server", 0);
  const later = DISCARD_ONLY_AFTER_MS + 1;
  expect(heldEntries(s, later)).toHaveLength(1);
  expect(nextBatch(s, later, "ana")).toBeNull();
});

describe("undo", () => {
  const applied = () => {
    const s = tap(start(), "adjust", "milk", { delta: -1 }, t());
    return deliver(s, () => ({ item: item({ rev: 4, quantity: 1 }), rev: 4 }));
  };

  it("twice queues one revert", () => {
    let s = applied();
    const id = s.recent[0]!.op.client_op_id;
    s = undo(s, id, t());
    expect(undo(s, id, t())).toBe(s);
    expect(view(s).milk!.quantity).toBe(2);
  });

  it("of nothing it can revert returns the same state: unknown, refused, sent order actions", () => {
    let s = applied();
    expect(undo(s, crypto.randomUUID(), t())).toBe(s);
    s = tap(s, "mark_ordered", "milk", { order_id: crypto.randomUUID() }, t());
    s = deliver(s, () => ({ item: item({ rev: 5, quantity: 1 }), rev: 5 }));
    expect(undo(s, s.recent.at(-1)!.op.client_op_id, t())).toBe(s);
    s = tap(s, "recount", "milk", { quantity: 9 }, t());
    s = deliver(s, () => ({ result: "stale", item: item({ rev: 6 }) }));
    expect(undo(s, s.notices.at(-1)!.clientOpId, t())).toBe(s);
  });

  it("is previewed only while the server would apply it", () => {
    let s = applied();
    const first = s.recent[0]!.op.client_op_id;
    s = tap(s, "adjust", "milk", { delta: 5 }, t());
    s = undo(s, first, t()); // the adjust queued after it changes the item first: changed_since
    expect(view(s).milk!.quantity).toBe(6);
  });

  it("a refused undo puts the tick back under Done and allows another undo", () => {
    let s = tap(start(), "buy", "milk", { quantity: 1 }, t(), { tick: true });
    s = deliver(s, () => ({ item: item({ rev: 4, quantity: 3 }), rev: 4 }));
    const buy = s.recent[0]!.op.client_op_id;
    s = undo(s, buy, t());
    expect(s.done.milk).toBeUndefined();
    s = deliver(s, () => ({ result: "rejected", reason: "changed_since", item: item({ rev: 5, quantity: 4 }) }));
    expect(s.done.milk).toBe(buy);
    expect(s.recent[0]!.undone).toBe(false);
  });

  it("of a never-sent order takes its queued arrival with it", () => {
    let s = start();
    const order = crypto.randomUUID();
    s = tap(s, "mark_ordered", "milk", { order_id: order, quantity: 3 }, t());
    s = tap(s, "arrived", "milk", { order_id: order }, t(), { orderQuantity: 3 });
    expect(view(s).milk!.quantity).toBe(5);
    s = undo(s, s.entries[0]!.op.client_op_id, t());
    expect(s.entries).toEqual([]);
    expect(view(s).milk!.quantity).toBe(2);
  });
});

it("a duplicate answer's item is the current state: an undo is previewed from the revision the step produced", () => {
  let s = tap(start(), "adjust", "milk", { delta: -1 }, t());
  // The first answer was lost; someone changed the item; the retry is answered as a duplicate.
  s = deliver(s, () => ({ duplicate: true, rev: 4, item: item({ rev: 5, quantity: 7 }) }));
  s = undo(s, s.recent[0]!.op.client_op_id, t());
  expect(view(s).milk!.quantity).toBe(7); // the server will answer changed_since: no preview
});

describe("preview", () => {
  it("an arrival adds the order's quantity, and a second arrival of the same order adds nothing", () => {
    let s = start();
    const order = crypto.randomUUID();
    s = tap(s, "arrived", "milk", { order_id: order }, t(), { orderQuantity: 6 });
    s = tap(s, "arrived", "milk", { order_id: order }, t(), { orderQuantity: 6 });
    expect(view(s).milk!.quantity).toBe(8);
  });

  it("a change to the same mode, or a non-boolean flag, previews as no change", () => {
    let s = tap(start(), "change_mode", "milk", { mode: "units" }, t());
    expect(view(s).milk!.quantity).toBe(2);
    s = start([item({ mode: "on_demand", needed: true, quantity: null })]);
    s = tap(s, "set_needed", "milk", { needed: "no" }, t());
    expect(view(s).milk!.needed).toBe(true);
  });
});

it("a discard of an undo makes the original undoable again", () => {
  let s = tap(start(), "adjust", "milk", { delta: -1 }, t());
  s = deliver(s, () => ({ item: item({ rev: 4, quantity: 1 }), rev: 4 }));
  const id = s.recent[0]!.op.client_op_id;
  s = undo(s, id, t());
  s = discard(s, s.entries[0]!.op.client_op_id);
  expect(undo(s, id, t())).not.toBe(s);
});

it("a queue per user on this install, with a UUID queue id", () => {
  const q = newQueue("ana");
  expect(q.queueId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(newQueue("ana").queueId).not.toBe(q.queueId);
  expect(storageKey("ana")).not.toBe(storageKey("bob"));
});

describe("phase 3 re-review", () => {
  const tick = () => tap(start(), "buy", "milk", { quantity: 1 }, t(), { tick: true });

  it("a tick refused together with its undo stays out of Done", () => {
    let s = tick();
    s = undo(onFailed(nextBatch(s, 1_000_000, "ana")!.state, "offline", 1_000_000), s.entries[0]!.op.client_op_id, t());
    s = retryNow(s);
    s = deliver(s, (_id, i) =>
      i === 0 ? { result: "rejected", reason: "forbidden" } : { result: "rejected", reason: "gone", item: item() }
    );
    expect(s.done.milk).toBeUndefined();
  });

  it("an undo refused as already_done did happen: no tick back, still undone", () => {
    let s = deliver(tick(), () => ({ item: item({ rev: 4, quantity: 3 }), rev: 4 }));
    const buy = s.recent[0]!.op.client_op_id;
    s = undo(s, buy, t());
    s = deliver(s, () => ({ result: "rejected", reason: "already_done", item: item({ rev: 5 }) }));
    expect(s.done.milk).toBeUndefined();
    expect(s.recent[0]!.undone).toBe(true);
  });

  it("a refused undo brings back no tick from before the last Finish shopping", () => {
    let s = deliver(tick(), () => ({ item: item({ rev: 4, quantity: 3 }), rev: 4 }));
    s = undo(s, s.recent[0]!.op.client_op_id, t());
    s = finishShopping(s, 2_000_000);
    s = deliver(s, () => ({ result: "rejected", reason: "changed_since", item: item({ rev: 5 }) }));
    expect(s.done).toEqual({});
  });

  it("removing a never-sent undo brings its tick back under Done", () => {
    let s = deliver(tick(), () => ({ item: item({ rev: 4, quantity: 3 }), rev: 4 }));
    const buy = s.recent[0]!.op.client_op_id;
    s = undo(s, buy, t());
    expect(s.done.milk).toBeUndefined();
    s = undo(s, s.entries[0]!.op.client_op_id, t());
    expect(s.done.milk).toBe(buy);
  });

  it("an undo is not previewed when someone else changed the item just before the step", () => {
    let s = start([item({ mode: "level", level: "out", quantity: null })]);
    s = tap(s, "buy", "milk", {}, t()); // the screen showed "out" before the tap
    // Someone set it to low (rev 4) before the buy applied (rev 5): the device never held rev 4.
    s = deliver(s, () => ({ item: item({ mode: "level", level: "ok", quantity: null, rev: 5 }), rev: 5 }));
    s = undo(s, s.recent[0]!.op.client_op_id, t());
    // The server will restore "low", not the "out" the screen showed: no preview until answered.
    expect(view(s).milk!.level).toBe("ok");
  });

  it("a refusal the device can predict changes nothing and does not hide an undo behind it", () => {
    let s = deliver(tap(start(), "adjust", "milk", { delta: -1 }, t()), () => ({
      item: item({ rev: 4, quantity: 1 }),
      rev: 4,
    }));
    const first = s.recent[0]!.op.client_op_id;
    s = tap(s, "adjust", "milk", { delta: 0 }, t());
    s = tap(s, "buy", "milk", { quantity: 1.5 }, t());
    s = undo(s, first, t());
    expect(view(s).milk!.quantity).toBe(2);
  });
});
