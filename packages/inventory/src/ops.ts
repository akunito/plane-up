// Building operations at the tap, and their optimistic effect on what the device shows.
// The server decides; the local effect only previews it and is replaced by the server's item state as
// soon as an answer comes back (brief: Operations and concurrency).

import { CAS } from "./types";
import type { ItemState, OpName, Operation } from "./types";

export interface Tap {
  now: number;
  /** The install's queue id for this user, or null for a queueless surface (widget, project page). */
  queueId: string | null;
  /** Must return a UUID: the server refuses anything else as invalid (ids are UUIDs in the engine). */
  newId: () => string;
}

export type Transmission = "never" | "transmitted" | "answered";

export interface Entry {
  op: Operation;
  /** Device clock at the tap; age_ms is computed from it when sending. Display only on the server. */
  tappedAt: number;
  transmission: Transmission;
  /** Held entries (older than two hours) are sent only once the person approves them. */
  approved: boolean;
  attempts: number;
  /** What the device showed for the item right before the tap (display only; an undo's preview uses
   * serverBefore or the preview chain, which is what the server restores). */
  before: ItemState | null;
  /** A tick in shopping mode: its row sits under "Done" until it is refused, discarded or undone. */
  tick: boolean;
  /** An arrival without a quantity applies the order's; the screen knows it, the operation does not. */
  orderQuantity?: number;
  /** A revert of this entry is queued (or was applied): a second undo does nothing. */
  undone?: boolean;
  /** The item's revision right after the server applied this entry: a revert can only apply at it. */
  resultRev?: number;
  /** The SERVER's item state right before it applied this entry, when the device held exactly that
   * revision; what a revert restores. Unknown otherwise, and then an undo is not previewed. */
  serverBefore?: ItemState;
}

/** Order actions and reverts cannot be reverted (brief, S71). */
export const NOT_REVERTIBLE: ReadonlySet<OpName> = new Set<OpName>(["revert", "mark_ordered", "arrived", "cancel"]);

export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** The operation format this build writes; the server refuses one it does not know (`unsupported_version`).
 * Raising it needs a storage migration that rewrites queued operations: without one the new build sends the
 * old format again and blocks again (queue.ts, "outdated"). */
export const OP_VERSION = 1;

export function buildOp(
  name: OpName,
  item: ItemState,
  args: Record<string, unknown>,
  tap: Tap,
  options: { tick?: boolean; shown?: ItemState; orderQuantity?: number } = {}
): Entry {
  const op: Operation = {
    v: OP_VERSION,
    client_op_id: tap.newId(),
    queue_id: tap.queueId,
    target: item.id,
    op: name,
    args,
  };
  // base_rev is the revision the device held when the user tapped: the last one the SERVER sent, never
  // an optimistic one. The server's same-queue exemption covers this device's own unanswered taps.
  if (CAS.has(name)) op.base_rev = item.rev;
  const entry: Entry = {
    op,
    tappedAt: tap.now,
    transmission: "never",
    approved: false,
    attempts: 0,
    before: options.shown ?? item,
    tick: options.tick ?? false,
  };
  if (options.orderQuantity !== undefined) entry.orderQuantity = options.orderQuantity;
  return entry;
}

function bought(item: ItemState, quantity: number | null, at: number): ItemState {
  const next = { ...item };
  if (item.mode === "on_demand") next.needed = false;
  else if (item.mode === "level") next.level = "ok";
  else if (item.mode === "units" && quantity !== null) next.quantity = (item.quantity ?? 0) + quantity;
  const iso = new Date(at).toISOString();
  if (item.last_bought_at === null || iso > item.last_bought_at) next.last_bought_at = iso;
  return next;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

const MAX_QUANTITY = 1_000_000; // engine.MAX_QUANTITY
const LEVELS = new Set(["ok", "low", "out"]);
const MODES = new Set(["pinned", "on_demand", "level", "units"]);

/** engine._int: an integer (not a boolean) within the bounds. */
function isInt(value: unknown, minimum?: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value) <= MAX_QUANTITY &&
    (minimum === undefined || value >= minimum)
  );
}

/**
 * Whether the engine will refuse this operation on this item, as far as the device can tell from the
 * item and the arguments alone (mode, types, bounds). A refused operation changes nothing and does not
 * advance the revision. Order status and someone else's changes are not known here (see view()).
 */
export function predictRefused(item: ItemState, entry: Entry): boolean {
  const a = entry.op.args;
  switch (entry.op.op) {
    case "adjust":
      return item.mode !== "units" || !isInt(a.delta) || a.delta === 0;
    case "buy":
    case "mark_ordered":
      return (
        (a.quantity !== undefined && !isInt(a.quantity, 1)) ||
        (entry.op.op === "mark_ordered" && typeof a.order_id !== "string")
      );
    case "arrived":
      return (a.quantity !== undefined && !isInt(a.quantity, 1)) || typeof a.order_id !== "string";
    case "cancel":
      return typeof a.order_id !== "string";
    case "set_level":
      return item.mode !== "level" || !LEVELS.has(a.level as string);
    case "set_needed":
      return item.mode !== "on_demand" || typeof a.needed !== "boolean";
    case "pin":
      return typeof a.pinned !== "boolean" || (item.mode !== "pinned" && item.mode !== "on_demand");
    case "recount":
      return item.mode !== "units" || !isInt(a.quantity);
    case "change_mode":
      if (!MODES.has(a.mode as string) || a.mode === item.mode) return true;
      if (a.mode === "level") return a.level !== undefined && !LEVELS.has(a.level as string);
      if (a.mode === "units") return !isInt(a.quantity);
      return false;
    case "revert":
      return false; // decided in view(), which knows what it names
  }
}

/**
 * The local preview of one operation on the item as the device knows it. Refusals the device can
 * predict (predictRefused) preview as no change and return the SAME object. A revert is previewed only
 * when view() (queue.ts) passes the reverted entry and, except for a ±n, the server's state right
 * before that step; otherwise no change.
 */
export function applyLocal(item: ItemState, entry: Entry, reverted?: Entry, before?: ItemState): ItemState {
  const { op: name, args } = entry.op;
  if (predictRefused(item, entry)) return item;
  switch (name) {
    case "adjust":
      return item.mode === "units" ? { ...item, quantity: (item.quantity ?? 0) + num(args.delta, 0) } : item;
    case "buy":
      return bought(item, num(args.quantity, 1), entry.tappedAt);
    case "arrived": {
      const quantity = typeof args.quantity === "number" ? args.quantity : (entry.orderQuantity ?? null);
      return bought(item, quantity, entry.tappedAt);
    }
    case "mark_ordered":
    case "cancel":
      return item;
    case "set_level":
      return item.mode === "level" ? { ...item, level: args.level as ItemState["level"] } : item;
    case "set_needed":
      return item.mode === "on_demand" && typeof args.needed === "boolean" ? { ...item, needed: args.needed } : item;
    case "pin":
      if ((item.mode !== "pinned" && item.mode !== "on_demand") || typeof args.pinned !== "boolean") return item;
      return { ...item, mode: args.pinned ? "pinned" : "on_demand", needed: false };
    case "recount":
      return item.mode === "units" ? { ...item, quantity: num(args.quantity, item.quantity ?? 0) } : item;
    case "change_mode": {
      const mode = args.mode as ItemState["mode"];
      if (mode === item.mode) return item;
      const next: ItemState = { ...item, mode, needed: false, level: null, quantity: null };
      if (mode === "level") next.level = (args.level as ItemState["level"]) ?? "ok";
      if (mode === "units") {
        next.quantity = num(args.quantity, 0);
        if (next.min_quantity === null) next.min_quantity = 1;
      }
      return next;
    }
    case "revert": {
      if (!reverted) return item;
      const r = reverted.op;
      if (r.op === "adjust") return { ...item, quantity: (item.quantity ?? 0) - num(r.args.delta, 0) };
      const b = before;
      if (!b) return item;
      if (r.op === "buy") {
        const next = { ...item, last_bought_at: b.last_bought_at, last_bought_by: b.last_bought_by };
        if (item.mode === "units") next.quantity = (item.quantity ?? 0) - num(r.args.quantity, 1);
        else Object.assign(next, { needed: b.needed, level: b.level });
        return next;
      }
      // State only; thresholds are data and are never restored (brief).
      return { ...item, mode: b.mode, needed: b.needed, level: b.level, quantity: b.quantity };
    }
  }
}
