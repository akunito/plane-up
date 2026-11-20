// Building operations at the tap, and their optimistic effect on what the device shows.
// The server decides; the local effect only previews it and is replaced by the server's item state as
// soon as an answer comes back (brief: Operations and concurrency).

import { CAS } from "./types";
import type { ItemState, OpName, Operation } from "./types";

export interface Tap {
  now: number;
  /** The install's queue id for this user, or null for a queueless surface (widget, project page). */
  queueId: string | null;
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
  /** What the device showed for the item right before the tap: the local preview of an undo. */
  before: ItemState | null;
  /** A tick in shopping mode: its row sits under "Done" until the server refuses it or it is discarded. */
  tick: boolean;
}

export function buildOp(
  name: OpName,
  item: ItemState,
  args: Record<string, unknown>,
  tap: Tap,
  options: { tick?: boolean; shown?: ItemState } = {}
): Entry {
  const op: Operation = {
    v: 1,
    client_op_id: tap.newId(),
    queue_id: tap.queueId,
    target: item.id,
    op: name,
    args,
  };
  // base_rev is the revision the device held when the user tapped: the last one the SERVER sent, never
  // an optimistic one. The server's same-queue exemption covers this device's own unanswered taps.
  if (CAS.has(name)) op.base_rev = item.rev;
  return {
    op,
    tappedAt: tap.now,
    transmission: "never",
    approved: false,
    attempts: 0,
    before: options.shown ?? item,
    tick: options.tick ?? false,
  };
}

function bought(item: ItemState, quantity: number, at: number): ItemState {
  const next = { ...item };
  if (item.mode === "on_demand") next.needed = false;
  else if (item.mode === "level") next.level = "ok";
  else if (item.mode === "units") next.quantity = (item.quantity ?? 0) + quantity;
  const iso = new Date(at).toISOString();
  if (item.last_bought_at === null || iso > item.last_bought_at) next.last_bought_at = iso;
  return next;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

/** The local preview of one operation. Anything the server would refuse is previewed as no change. */
export function applyLocal(item: ItemState, entry: Entry, reverted?: Entry): ItemState {
  const { op: name, args } = entry.op;
  switch (name) {
    case "adjust":
      return item.mode === "units" ? { ...item, quantity: (item.quantity ?? 0) + num(args.delta, 0) } : item;
    case "buy":
      return bought(item, num(args.quantity, 1), entry.tappedAt);
    case "arrived":
      return bought(item, num(args.quantity, 1), entry.tappedAt);
    case "mark_ordered":
    case "cancel":
      return item;
    case "set_level":
      return item.mode === "level" ? { ...item, level: args.level as ItemState["level"] } : item;
    case "set_needed":
      return item.mode === "on_demand" ? { ...item, needed: Boolean(args.needed) } : item;
    case "pin":
      if (item.mode !== "pinned" && item.mode !== "on_demand") return item;
      return { ...item, mode: args.pinned ? "pinned" : "on_demand", needed: false };
    case "recount":
      return item.mode === "units" ? { ...item, quantity: num(args.quantity, item.quantity ?? 0) } : item;
    case "change_mode": {
      const mode = args.mode as ItemState["mode"];
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
      if (r.op === "buy" && item.mode === "units")
        return {
          ...item,
          quantity: (item.quantity ?? 0) - num(r.args.quantity, 1),
          last_bought_at: reverted.before?.last_bought_at ?? item.last_bought_at,
        };
      const b = reverted.before;
      if (!b) return item;
      // State only; thresholds are data and are never restored (brief).
      return {
        ...item,
        mode: b.mode,
        needed: b.needed,
        level: b.level,
        quantity: b.quantity,
        last_bought_at: b.last_bought_at,
      };
    }
  }
}
