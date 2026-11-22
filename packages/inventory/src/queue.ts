// The device queue as a pure reducer: every function takes a state and returns a new one; storage,
// network and timers live outside (brief: Operations and concurrency; plan: phase 3).
//
// Rules this must keep (each was wrong in an earlier design or found by review):
// - Strictly first-in, first-out. Nothing is reordered, dropped or set aside by itself.
// - A failed request (no network, 5xx, sign-in page, redirect, a refusal of the whole request) is retried
//   later with the SAME ids, so an operation the server applied is recognised and not applied twice.
// - "Not yet answered" is not "not sent": undo removes only a never-transmitted entry; anything
//   transmitted is undone by queueing a revert behind it.
// - Entries tapped more than two hours ago and not yet answered are held until the person approves them,
//   whether or not an attempt already went out (decision 3, owner 2026-11-22: a failed attempt offline marks
//   an entry transmitted, and exempting those let a tap from days ago go out by itself); a held entry blocks
//   everything behind it. Resending keeps the id, so a lost-answer one is not applied twice. Older than 60
//   days, sent or not: discard only (the server prunes its ledger at 90, after which a retry would apply twice).
// - Only the user can unblock a failing queue, by discarding its first entry, and is told it may have
//   been applied. A discard takes what depends on it, and a discarded, undone or refused tick leaves
//   "Done"; a tick comes back only when its undo is refused or removed, and never from before the last
//   "Finish shopping".
// - The queue belongs to one user (stored under that user's key, see storage.ts); another user signed in
//   on the same phone never sends it.
// - What the device knows of an item only moves forward in revision: an older snapshot never replaces
//   a newer answer (phase 3 audit).
//
// Accepted, not fixed (phase 3 audit): an entry whose answer was lost and whose effect a later refresh
// already shows is previewed twice until its retry is answered (seconds when online) — or, once it is held
// by the two-hour rule, until the person answers the hold (decision 3, 2026-11-22; the app lists held
// entries as soon as it opens). The device
// cannot tell its own applied-but-unanswered step from someone else's. And an undo (other than of a ±n)
// is previewed only when the device held the item's state right before that step (serverBefore), which
// is what the server restores: not after someone else changed the item in between, nor after a
// lost-then-duplicate answer. It shows once the undo is answered. Arrivals and cancels of an order the
// device has seen no action on are previewed as applied.

import type { Entry } from "./ops";
import { OP_VERSION } from "./ops";
import { applyLocal, buildOp, NOT_REVERTIBLE, predictRefused } from "./ops";
import type { Tap } from "./ops";
import type { ItemState, OpResult, Operation } from "./types";

export const HOLD_AFTER_MS = 2 * 60 * 60 * 1000;
export const DISCARD_ONLY_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_BATCH = 100;
const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
const RECENT = 50;

/**
 * offline: no answer. server: 5xx, non-JSON, or an answer that matched none of the batch.
 * signed_out_app / signed_out_proxy: M4. refused: the whole request was refused (403 when the person
 * lost access to inventory, 400 for a malformed body) — retried like the others, but the screen must
 * say so: discarding the head does not help. outdated: the server refused an operation's format version;
 * the queue keeps it and sends nothing until this app is a newer build (S25, brief "Queue ownership").
 */
export type FailureKind = "offline" | "server" | "signed_out_app" | "signed_out_proxy" | "refused" | "outdated";

export interface Failure {
  kind: FailureKind;
  attempts: number;
  nextTryAt: number;
  status?: number;
  error?: string;
  /** outdated only: the OP_VERSION of the build that was refused; a newer build sends again. */
  opVersion?: number;
}

export interface Notice {
  kind: "stale" | "rejected" | "discarded";
  clientOpId: string;
  entry: Entry;
  reason?: string;
  item?: ItemState;
  changed?: OpResult["changed"];
  /** A discarded entry that had been transmitted: the server may have applied it. */
  mayHaveApplied?: boolean;
}

export interface QueueState {
  userId: string;
  queueId: string;
  entries: Entry[];
  /** Last item states the SERVER sent (answers or refreshes), never older than one already held. */
  known: Record<string, ItemState>;
  /** Item id -> client_op_id of the tick that put it under "Done" on this device. */
  done: Record<string, string>;
  /** When "Done" was last emptied ("Finish shopping", or six hours without a tick): no tick from
   * before it comes back. */
  doneSince: number;
  notices: Notice[];
  sending: boolean;
  failure: Failure | null;
  /** Items whose server state this device cannot vouch for (a transmitted entry was discarded). */
  needsRefresh: string[];
  /** The last applied entries, so an undo can still revert one after its answer came back. */
  recent: Entry[];
}

export function createQueue(userId: string, queueId: string): QueueState {
  return {
    userId,
    queueId,
    entries: [],
    known: {},
    done: {},
    doneSince: 0,
    notices: [],
    sending: false,
    failure: null,
    needsRefresh: [],
    recent: [],
  };
}

const ageOf = (entry: Entry, now: number) => now - entry.tappedAt;

function keepNewer(known: Record<string, ItemState>, item: ItemState): void {
  const current = known[item.id];
  if (!current || item.rev >= current.rev) known[item.id] = item;
}

export function isDiscardOnly(entry: Entry, now: number): boolean {
  return ageOf(entry, now) > DISCARD_ONLY_AFTER_MS;
}

export function isHeld(entry: Entry, now: number): boolean {
  if (isDiscardOnly(entry, now)) return true;
  return !entry.approved && ageOf(entry, now) > HOLD_AFTER_MS;
}

/** Held entries, for the screen that asks: send or discard, one by one or all. */
export function heldEntries(state: QueueState, now: number): Entry[] {
  return state.entries.filter((e) => isHeld(e, now));
}

// ---------------------------------------------------------------- taps

export function enqueue(state: QueueState, entry: Entry): QueueState {
  const done = entry.tick ? { ...state.done, [entry.op.target]: entry.op.client_op_id } : state.done;
  return { ...state, entries: [...state.entries, entry], done };
}

/** Build and enqueue in one step, with base_rev from what the server last sent for the item. */
export function tap(
  state: QueueState,
  name: Entry["op"]["op"],
  itemId: string,
  args: Record<string, unknown>,
  t: Omit<Tap, "queueId">,
  options: { tick?: boolean; orderQuantity?: number } = {}
): QueueState {
  const known = state.known[itemId];
  if (!known) throw new Error(`unknown item ${itemId}`);
  const shown = view(state)[itemId] ?? known;
  return enqueue(state, buildOp(name, known, args, { ...t, queueId: state.queueId }, { ...options, shown }));
}

/** "Finish shopping" (and the six-hour reset): empties "Done" on this device; nothing is sent. */
export function finishShopping(state: QueueState, now: number): QueueState {
  return { ...state, done: {}, doneSince: now };
}

/** A tick whose undo did not happen goes back under "Done", unless "Done" was emptied since. */
function restoreTick(done: Record<string, string>, original: Entry | undefined, doneSince: number) {
  if (!original?.tick || original.tappedAt < doneSince) return done;
  return { ...done, [original.op.target]: original.op.client_op_id };
}

function withoutDone(done: Record<string, string>, ids: Set<string>): Record<string, string> {
  const out = { ...done };
  for (const [item, id] of Object.entries(out)) if (ids.has(id)) delete out[item];
  return out;
}

/**
 * An entry and what cannot stand without it: the undos that name it and, for an order that was never
 * sent (so never exists on the server), the arrivals and cancels queued for that order.
 */
function withDependents(entries: Entry[], entry: Entry): Set<string> {
  const ids = new Set([entry.op.client_op_id]);
  const orderId = entry.op.op === "mark_ordered" && entry.transmission === "never" ? entry.op.args.order_id : undefined;
  for (const e of entries) {
    if (e.op.op === "revert" && e.op.args.reverts === entry.op.client_op_id) ids.add(e.op.client_op_id);
    if (orderId !== undefined && (e.op.op === "arrived" || e.op.op === "cancel") && e.op.args.order_id === orderId)
      ids.add(e.op.client_op_id);
  }
  return ids;
}

/**
 * Remove entries by the person's choice. An undo removed this way did not happen: its original (if it
 * stays) is undoable again and its tick goes back under "Done".
 */
function removeEntries(state: QueueState, ids: Set<string>): Pick<QueueState, "entries" | "recent" | "done"> {
  const removedUndos = state.entries.filter((e) => ids.has(e.op.client_op_id) && e.op.op === "revert");
  const targets = new Set(removedUndos.map((e) => e.op.args.reverts as string));
  for (const id of ids) targets.delete(id);
  const unmark = (e: Entry) => (targets.has(e.op.client_op_id) ? { ...e, undone: false } : e);
  const entries = state.entries.filter((e) => !ids.has(e.op.client_op_id)).map(unmark);
  const recent = state.recent.map(unmark);
  let done = withoutDone(state.done, ids);
  for (const id of targets) {
    const original = entries.find((e) => e.op.client_op_id === id) ?? recent.find((e) => e.op.client_op_id === id);
    done = restoreTick(done, original, state.doneSince);
  }
  return { entries, recent, done };
}

/**
 * Undo: remove a never-transmitted entry (with what depends on it); queue a revert for anything
 * transmitted or applied. Returns the SAME state when there is nothing to undo (a sent order action or
 * revert, a refused or unknown operation, one already undone, or one older than the last 50 applied):
 * the screen must not say "undone" then.
 */
export function undo(state: QueueState, clientOpId: string, t: Omit<Tap, "queueId">): QueueState {
  const queued = state.entries.find((e) => e.op.client_op_id === clientOpId);
  if (queued && queued.transmission === "never") {
    return { ...state, ...removeEntries(state, withDependents(state.entries, queued)) };
  }
  const applied = queued ? undefined : state.recent.find((e) => e.op.client_op_id === clientOpId);
  const entry = queued ?? applied;
  if (!entry || entry.undone || NOT_REVERTIBLE.has(entry.op.op)) return state;
  const done = withoutDone(state.done, new Set([clientOpId]));
  const target = entry.op.target;
  const known = state.known[target];
  if (!known) return state;
  const revert = buildOp(
    "revert",
    known,
    { reverts: clientOpId },
    { ...t, queueId: state.queueId },
    { shown: view(state)[target] ?? known }
  );
  const mark = (e: Entry) => (e.op.client_op_id === clientOpId ? { ...e, undone: true } : e);
  return {
    ...state,
    done,
    entries: [...state.entries.map(mark), revert],
    recent: queued ? state.recent : state.recent.map(mark),
  };
}

/** Approve held entries (never one older than 60 days, which can only be discarded). */
export function approve(state: QueueState, clientOpIds: string[], now: number): QueueState {
  const ids = new Set(clientOpIds);
  return {
    ...state,
    entries: state.entries.map((e) =>
      ids.has(e.op.client_op_id) && !isDiscardOnly(e, now) ? { ...e, approved: true } : e
    ),
  };
}

/**
 * Discard an entry with what depends on it (its undos; for a never-sent order, its arrivals and
 * cancels) and their ticks; say so if it may have been applied.
 */
export function discard(state: QueueState, clientOpId: string): QueueState {
  const entry = state.entries.find((e) => e.op.client_op_id === clientOpId);
  if (!entry) return state;
  const removed = removeEntries(state, withDependents(state.entries, entry));
  const transmitted = entry.transmission !== "never";
  const notice: Notice = { kind: "discarded", clientOpId, entry, mayHaveApplied: transmitted };
  return {
    ...state,
    ...removed,
    notices: [...state.notices, notice],
    needsRefresh: transmitted ? [...new Set([...state.needsRefresh, entry.op.target])] : state.needsRefresh,
  };
}

/** The way out of a blocked queue: discard its first entry. */
export function discardHead(state: QueueState): QueueState {
  const head = state.entries[0];
  return head ? discard(state, head.op.client_op_id) : state;
}

/** "Apply anyway": a NEW operation with a new id and the freshest revision known. Only for stale. */
export function applyAnyway(state: QueueState, notice: Notice, t: Omit<Tap, "queueId">): QueueState {
  if (notice.kind !== "stale" || !notice.item) throw new Error("apply anyway exists only for stale results");
  const known = { ...state.known };
  keepNewer(known, notice.item);
  const next = { ...state, known, notices: state.notices.filter((n) => n !== notice) };
  const options: { orderQuantity?: number } = {};
  if (notice.entry.orderQuantity !== undefined) options.orderQuantity = notice.entry.orderQuantity;
  return tap(next, notice.entry.op.op, notice.item.id, notice.entry.op.args, t, options);
}

export function dismiss(state: QueueState, notice: Notice): QueueState {
  return { ...state, notices: state.notices.filter((n) => n !== notice) };
}

// ---------------------------------------------------------------- sending

/**
 * The next batch to send, or null. Strict FIFO from the head; stops at the first held entry, which
 * blocks everything behind it. Only the queue's owner sends it, one replay at a time, after backoff.
 * A backoff longer than its maximum means the clock moved back: it is over.
 */
export function nextBatch(
  state: QueueState,
  now: number,
  currentUserId: string
): { state: QueueState; batch: Operation[] } | null {
  if (state.userId !== currentUserId || state.sending) return null;
  const f = state.failure;
  if (f?.kind === "outdated" && f.opVersion === OP_VERSION) return null;
  if (f && now < f.nextTryAt && f.nextTryAt - now <= BACKOFF_MAX_MS) return null;
  const batch: Operation[] = [];
  const entries = [...state.entries];
  for (let i = 0; i < entries.length && batch.length < MAX_BATCH; i++) {
    const e = entries[i]!;
    if (isHeld(e, now)) break;
    entries[i] = {
      ...e,
      transmission: e.transmission === "never" ? "transmitted" : e.transmission,
      attempts: e.attempts + 1,
    };
    batch.push({ ...e.op, age_ms: Math.max(0, now - e.tappedAt) });
  }
  if (batch.length === 0) return null;
  return { state: { ...state, entries, sending: true }, batch };
}

/** How many operations of the batch a result list answers (0 = no progress: treat as a failed request). */
export function answeredCount(batch: Operation[], results: OpResult[]): number {
  const ids = new Set(results.map((r) => (r.client_op_id ?? "").toLowerCase()));
  let n = 0;
  for (const o of batch) if (ids.has(o.client_op_id.toLowerCase())) n++;
  return n;
}

/** The server answered. Answered entries leave the queue; anything without an answer stays to be retried. */
export function onDelivered(state: QueueState, results: OpResult[]): QueueState {
  const byId = new Map<string, OpResult>();
  for (const r of results) if (r.client_op_id) byId.set(r.client_op_id.toLowerCase(), r);
  const known = { ...state.known };
  let done = { ...state.done };
  const notices = [...state.notices];
  const entries: Entry[] = [];
  let recent = [...state.recent];
  let outdated = false;
  for (const entry of state.entries) {
    const r = byId.get(entry.op.client_op_id.toLowerCase());
    if (!r) {
      entries.push(entry);
      continue;
    }
    // Not a refusal of the change itself: kept, and nothing more is sent until the app is updated. The
    // server answers this before its ledger, so the same client_op_id is accepted after the update.
    if (r.result === "rejected" && r.reason === "unsupported_version") {
      outdated = true;
      entries.push(entry);
      continue;
    }
    const prior = known[entry.op.target];
    if (r.item) keepNewer(known, r.item);
    // "gone" with an item is a missing order or reverted event; only "gone" without one is the item.
    else if (r.reason === "gone") delete known[entry.op.target];
    if (r.result === "applied") {
      const answered: Entry = { ...entry, transmission: "answered" };
      const rev = r.rev ?? (r.duplicate ? undefined : r.item?.rev);
      if (rev !== undefined) answered.resultRev = rev;
      if (rev !== undefined && prior && prior.rev === rev - 1) answered.serverBefore = prior;
      recent.push(answered);
      continue;
    }
    const notice: Notice = {
      kind: r.result === "stale" ? "stale" : "rejected",
      clientOpId: entry.op.client_op_id,
      entry,
    };
    if (r.reason) notice.reason = r.reason;
    if (r.item) notice.item = r.item;
    if (r.changed !== undefined) notice.changed = r.changed;
    notices.push(notice);
    if (entry.tick) done = withoutDone(done, new Set([entry.op.client_op_id]));
    // The undo did not happen, so the original stands: undoable again, and its tick back under Done.
    // Not for already_done (an earlier copy of the undo DID happen), and only for an original that
    // still stands here: applied (recent) or still waiting (entries) — not one refused in this batch.
    if (entry.op.op === "revert" && r.reason !== "already_done") {
      const target = entry.op.args.reverts as string;
      const original =
        recent.find((e) => e.op.client_op_id === target) ?? entries.find((e) => e.op.client_op_id === target);
      if (original) {
        const unmark = (e: Entry) => (e.op.client_op_id === target ? { ...e, undone: false } : e);
        recent = recent.map(unmark);
        entries.splice(0, entries.length, ...entries.map(unmark));
        done = restoreTick(done, original, state.doneSince);
      }
    }
  }
  const failure: Failure | null = outdated
    ? { kind: "outdated", attempts: (state.failure?.attempts ?? 0) + 1, nextTryAt: 0, opVersion: OP_VERSION }
    : null;
  return { ...state, entries, known, done, notices, sending: false, failure, recent: recent.slice(-RECENT) };
}

/** The request failed as a whole: keep every entry, transmitted ones as transmitted, and back off. */
export function onFailed(
  state: QueueState,
  kind: FailureKind,
  now: number,
  detail: { status?: number; error?: string } = {}
): QueueState {
  const attempts = (state.failure?.attempts ?? 0) + 1;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  return { ...state, sending: false, failure: { kind, attempts, nextTryAt: now + wait, ...detail } };
}

/** The app opened, came online or the person tapped "retry": try now, whatever the backoff said. */
export function retryNow(state: QueueState): QueueState {
  return state.failure ? { ...state, failure: { ...state.failure, nextTryAt: 0 } } : state;
}

/** After loading from storage: a replay that was running when the app died is not running any more. */
export function onRestart(state: QueueState): QueueState {
  return retryNow({ ...state, sending: false });
}

/** A fresh snapshot from the server (polling, reopening, a list's items): newer states replace older. */
export function refreshed(state: QueueState, items: ItemState[]): QueueState {
  const known = { ...state.known };
  for (const item of items) keepNewer(known, item);
  const fresh = new Set(items.map((i) => i.id));
  return { ...state, known, needsRefresh: state.needsRefresh.filter((id) => !fresh.has(id)) };
}

// ---------------------------------------------------------------- what the device shows

/**
 * Server state plus every entry still in the queue, applied in order. A revert is previewed only while
 * the server would apply it: when the entry it names is the last step on the item (the last applied
 * answer, at the item's known revision, or the last queued entry that changes something).
 */
export function view(state: QueueState): Record<string, ItemState> {
  const out: Record<string, ItemState> = { ...state.known };
  const last: Record<string, Entry | undefined> = {};
  const beforeOf = new Map<string, ItemState | undefined>();
  // Orders this device has seen acted on: a second arrival or a cancel of a closed order is refused
  // (already_done) and must preview as no change. Older than the last 50 applied entries: unknown.
  const orders = new Map<string, "open" | "received" | "cancelled">();
  const track = (e: Entry) => {
    const id = e.op.args.order_id as string;
    if (e.op.op === "mark_ordered") orders.set(id, "open");
    else if (e.op.op === "arrived") orders.set(id, "received");
    else if (e.op.op === "cancel") orders.set(id, "cancelled");
  };
  for (const e of state.recent) {
    track(e);
    const known = state.known[e.op.target];
    // An applied revert moved the revision past resultRev, so an undone entry drops out by itself.
    if (known && e.resultRev === known.rev) {
      last[e.op.target] = e;
      beforeOf.set(e.op.client_op_id, e.serverBefore);
    }
  }
  for (const entry of state.entries) {
    const target = entry.op.target;
    const item = out[target];
    if (!item) continue;
    if (entry.op.op === "revert") {
      const reverted = last[target];
      const before = reverted ? beforeOf.get(reverted.op.client_op_id) : undefined;
      // Refused by the server (changed_since) unless it names the last step; a refused revert changes
      // nothing, so the last step stays what it was.
      if (reverted === undefined || reverted.op.client_op_id !== entry.op.args.reverts) continue;
      // Without the server's prior state (other than for a ±n) applyLocal shows no change: the undo
      // applies, and shows when answered.
      out[target] = applyLocal(item, entry, reverted, before);
      last[target] = undefined;
      continue;
    }
    // Refused (already_done, gone, invalid, wrong mode): nothing changes and the revision stays, so the
    // last step stays what it was. Everything else the server applies advances the revision, even when
    // it changes no state (an order, a cancel, a buy of a pinned item).
    const status = orders.get(entry.op.args.order_id as string);
    if (
      predictRefused(item, entry) ||
      (entry.op.op === "mark_ordered" && status !== undefined) ||
      (entry.op.op === "arrived" && status === "received") ||
      (entry.op.op === "cancel" && status !== undefined && status !== "open")
    )
      continue;
    track(entry);
    out[target] = applyLocal(item, entry);
    last[target] = entry;
    beforeOf.set(entry.op.client_op_id, item);
  }
  return out;
}

/** How many changes are waiting: the app shows this at all times (phase 6, M10). */
export function waiting(state: QueueState): number {
  return state.entries.length;
}
