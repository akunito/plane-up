// The device queue as a pure reducer: every function takes a state and returns a new one; storage,
// network and timers live outside (brief: Operations and concurrency; plan: phase 3).
//
// Rules this must keep (each was wrong in an earlier design or found by review):
// - Strictly first-in, first-out. Nothing is reordered, dropped or set aside by itself.
// - A failed request (no network, 5xx, sign-in page, redirect) is retried later with the SAME ids, so an
//   operation the server applied is recognised and not applied twice.
// - "Not yet answered" is not "not sent": undo removes only a never-transmitted entry; anything
//   transmitted is undone by queueing a revert behind it.
// - Entries tapped more than two hours ago and never sent are held until the person approves them, and a
//   held entry blocks everything behind it. Older than 60 days: discard only (events are pruned at 90).
// - Only the user can unblock a failing queue, by discarding its first entry, and is told it may have
//   been applied. A discard takes the reverts that name it, and a discarded or refused tick leaves "Done".
// - The queue belongs to one user; another user signed in on the same phone never sends it.

import type { Entry } from "./ops";
import { applyLocal, buildOp } from "./ops";
import type { Tap } from "./ops";
import type { ItemState, OpResult, Operation } from "./types";

export const HOLD_AFTER_MS = 2 * 60 * 60 * 1000;
export const DISCARD_ONLY_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_BATCH = 100;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export type FailureKind = "offline" | "server" | "signed_out_app" | "signed_out_proxy";

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
  /** Last item states the SERVER sent (answers or refreshes). The base for base_rev and for the view. */
  known: Record<string, ItemState>;
  /** Item id -> client_op_id of the tick that put it under "Done" on this device. */
  done: Record<string, string>;
  notices: Notice[];
  sending: boolean;
  failure: { kind: FailureKind; attempts: number; nextTryAt: number } | null;
  /** Items whose server state this device cannot vouch for (a transmitted entry was discarded). */
  needsRefresh: string[];
  /** The last applied entries, so an undo toast can still revert one after its answer came back. */
  recent: Entry[];
}

const RECENT = 50;

export function createQueue(userId: string, queueId: string): QueueState {
  return {
    userId,
    queueId,
    entries: [],
    known: {},
    done: {},
    notices: [],
    sending: false,
    failure: null,
    needsRefresh: [],
    recent: [],
  };
}

const ageOf = (entry: Entry, now: number) => now - entry.tappedAt;

export function isDiscardOnly(entry: Entry, now: number): boolean {
  return entry.transmission === "never" && ageOf(entry, now) > DISCARD_ONLY_AFTER_MS;
}

export function isHeld(entry: Entry, now: number): boolean {
  if (entry.transmission !== "never") return false; // sent ones keep their ids and follow the normal rules
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
  options: { tick?: boolean } = {}
): QueueState {
  const known = state.known[itemId];
  if (!known) throw new Error(`unknown item ${itemId}`);
  const shown = view(state)[itemId] ?? known;
  return enqueue(state, buildOp(name, known, args, { ...t, queueId: state.queueId }, { ...options, shown }));
}

/** Undo: remove a never-transmitted entry; queue a revert for anything already transmitted. */
export function undo(state: QueueState, clientOpId: string, t: Omit<Tap, "queueId">): QueueState {
  const entry = state.entries.find((e) => e.op.client_op_id === clientOpId);
  const done = { ...state.done };
  for (const [item, id] of Object.entries(done)) if (id === clientOpId) delete done[item];
  if (entry && entry.transmission === "never") {
    return { ...state, done, entries: state.entries.filter((e) => e !== entry) };
  }
  // Transmitted (answered or not), or already answered and gone from the queue: revert it on the server.
  const target = entry?.op.target ?? findTarget(state, clientOpId);
  if (!target) return { ...state, done };
  const known = state.known[target];
  const revert = buildOp(
    "revert",
    known ?? ({ id: target } as ItemState),
    { reverts: clientOpId },
    { ...t, queueId: state.queueId },
    { shown: view(state)[target] ?? known }
  );
  return { ...state, done, entries: [...state.entries, revert] };
}

function findAnswered(state: QueueState, clientOpId: string): Entry | undefined {
  for (const e of state.recent) if (e.op.client_op_id === clientOpId) return e;
  for (const n of state.notices) if (n.clientOpId === clientOpId) return n.entry;
  return undefined;
}

function findTarget(state: QueueState, clientOpId: string): string | undefined {
  return findAnswered(state, clientOpId)?.op.target;
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

/** Discard an entry, the reverts that name it, and its tick; say so if it may have been applied. */
export function discard(state: QueueState, clientOpId: string): QueueState {
  const entry = state.entries.find((e) => e.op.client_op_id === clientOpId);
  if (!entry) return state;
  const entries = state.entries.filter(
    (e) => e !== entry && !(e.op.op === "revert" && e.op.args.reverts === clientOpId)
  );
  const done = { ...state.done };
  for (const [item, id] of Object.entries(done)) if (id === clientOpId) delete done[item];
  const transmitted = entry.transmission !== "never";
  const notice: Notice = { kind: "discarded", clientOpId, entry, mayHaveApplied: transmitted };
  return {
    ...state,
    entries,
    done,
    notices: [...state.notices, notice],
    needsRefresh: transmitted ? [...new Set([...state.needsRefresh, entry.op.target])] : state.needsRefresh,
  };
}

/** The way out of a blocked queue: discard its first entry. */
export function discardHead(state: QueueState): QueueState {
  const head = state.entries[0];
  return head ? discard(state, head.op.client_op_id) : state;
}

/** "Apply anyway": a NEW operation with a new id and the fresh revision. Exists only for stale. */
export function applyAnyway(state: QueueState, notice: Notice, t: Omit<Tap, "queueId">): QueueState {
  if (notice.kind !== "stale" || !notice.item) throw new Error("apply anyway exists only for stale results");
  const known = { ...state.known, [notice.item.id]: notice.item };
  const next = { ...state, known, notices: state.notices.filter((n) => n !== notice) };
  return tap(next, notice.entry.op.op, notice.item.id, notice.entry.op.args, t);
}

export function dismiss(state: QueueState, notice: Notice): QueueState {
  return { ...state, notices: state.notices.filter((n) => n !== notice) };
}

// ---------------------------------------------------------------- sending

/**
 * The next batch to send, or null. Strict FIFO from the head; stops at the first held entry, which
 * blocks everything behind it. Only the queue's owner sends it, one replay at a time, after backoff.
 */
export function nextBatch(
  state: QueueState,
  now: number,
  currentUserId: string
): { state: QueueState; batch: Operation[] } | null {
  if (state.userId !== currentUserId || state.sending) return null;
  if (state.failure && now < state.failure.nextTryAt) return null;
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

/** The server answered. Answered entries leave the queue; anything without an answer stays to be retried. */
export function onDelivered(state: QueueState, results: OpResult[]): QueueState {
  const byId = new Map(results.filter((r) => r.client_op_id).map((r) => [r.client_op_id as string, r]));
  const known = { ...state.known };
  const done = { ...state.done };
  const notices = [...state.notices];
  const entries: Entry[] = [];
  const recent = [...state.recent];
  for (const entry of state.entries) {
    const r = byId.get(entry.op.client_op_id);
    if (!r) {
      entries.push(entry);
      continue;
    }
    if (r.result === "applied") recent.push({ ...entry, transmission: "answered" });
    if (r.item) known[r.item.id] = r.item;
    if (r.reason === "gone") delete known[entry.op.target];
    if (r.result !== "applied") {
      const notice: Notice = {
        kind: r.result === "stale" ? "stale" : "rejected",
        clientOpId: entry.op.client_op_id,
        entry,
      };
      if (r.reason) notice.reason = r.reason;
      if (r.item) notice.item = r.item;
      if (r.changed !== undefined) notice.changed = r.changed;
      notices.push(notice);
      if (entry.tick && done[entry.op.target] === entry.op.client_op_id) delete done[entry.op.target];
    }
  }
  return { ...state, entries, known, done, notices, sending: false, failure: null, recent: recent.slice(-RECENT) };
}

/** The request failed as a whole: keep every entry, transmitted ones as transmitted, and back off. */
export function onFailed(state: QueueState, kind: FailureKind, now: number): QueueState {
  const attempts = (state.failure?.attempts ?? 0) + 1;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  return { ...state, sending: false, failure: { kind, attempts, nextTryAt: now + wait } };
}

/** After loading from storage: a replay that was running when the app died is not running any more. */
export function onRestart(state: QueueState): QueueState {
  return { ...state, sending: false };
}

/** A fresh snapshot from the server (polling, reopening): replaces what the device knew. */
export function refreshed(state: QueueState, items: ItemState[]): QueueState {
  const known = { ...state.known };
  for (const item of items) known[item.id] = item;
  const fresh = new Set(items.map((i) => i.id));
  return { ...state, known, needsRefresh: state.needsRefresh.filter((id) => !fresh.has(id)) };
}

// ---------------------------------------------------------------- what the device shows

/** Server state plus every entry still in the queue, applied in order. */
export function view(state: QueueState): Record<string, ItemState> {
  const out: Record<string, ItemState> = { ...state.known };
  const byId = new Map(state.entries.map((e) => [e.op.client_op_id, e]));
  for (const entry of state.entries) {
    const item = out[entry.op.target];
    if (!item) continue;
    const reverted = entry.op.op === "revert" ? byId.get(entry.op.args.reverts as string) : undefined;
    out[entry.op.target] = applyLocal(item, entry, reverted ?? revertSource(state, entry));
  }
  return out;
}

function revertSource(state: QueueState, entry: Entry): Entry | undefined {
  if (entry.op.op !== "revert") return undefined;
  return findAnswered(state, entry.op.args.reverts as string);
}

/** How many changes are waiting: the app shows this at all times (phase 6, M10). */
export function waiting(state: QueueState): number {
  return state.entries.length;
}
