// A small model of the server's two behaviours (apps/api/plane/app/inventory/engine.py), enough to drive
// the device queue against. It follows the engine on: ledger by client_op_id (a duplicate by another
// person or for another item is duplicate_id), the same-queue exemption proven step by step, a revert
// compared against the revision its operation produced and refused as gone / not_yours /
// not_revertible / already_done / changed_since, order actions (mark_ordered, arrived with the order's
// quantity, cancel; an existing order id is already_done), pin and change_mode, the argument checks
// (integers within bounds, delta not 0, quantities ≥ 1, booleans, known levels and modes), refusals
// that never advance the revision, "gone" WITH the item for a missing order or event and WITHOUT it
// for a missing item, and "rev" (the produced revision) on applied answers.
// It does not model: parse errors (unrecorded, no item), forbidden, thresholds (min_quantity is never
// set by change_mode here), last_bought_*, or the age cut-off (the device's 60-day rule keeps
// operations far from it).

import type { ItemState, OpResult, Operation } from "../src/types";
import { CAS } from "../src/types";

interface Recorded {
  result: OpResult;
  actor: string;
  target: string;
  op: Operation;
  rev: number | null;
  before: ItemState;
  reverted: boolean;
}

interface Order {
  item: string;
  quantity: number;
  status: "open" | "received" | "cancelled";
}

const NOT_REVERTIBLE = new Set(["revert", "mark_ordered", "arrived", "cancel"]);
const LEVELS = new Set(["ok", "low", "out"]);
const MODES = new Set(["pinned", "on_demand", "level", "units"]);
const isInt = (v: unknown, min?: number) =>
  typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 1_000_000 && (min === undefined || v >= min);

export class ModelServer {
  items = new Map<string, ItemState>();
  ledger = new Map<string, Recorded>();
  effects = new Map<string, number>();
  orders = new Map<string, Order>();

  constructor(items: ItemState[]) {
    for (const i of items) this.items.set(i.id, { ...i });
  }

  clone(): ModelServer {
    const c = new ModelServer([]);
    c.items = structuredClone(this.items);
    c.ledger = structuredClone(this.ledger);
    c.effects = structuredClone(this.effects);
    c.orders = structuredClone(this.orders);
    return c;
  }

  snapshot(): ItemState[] {
    return Array.from(this.items.values(), (i) => Object.assign({}, i));
  }

  /** Display names by actor id, for stale answers (`changed.by_name`). */
  names = new Map<string, string>();

  apply(ops: Operation[], actor: string): OpResult[] {
    return ops.map((op) => this.one(op, actor));
  }

  private one(op: Operation, actor: string): OpResult {
    const item = this.items.get(op.target);
    if (!item) return { client_op_id: op.client_op_id, result: "rejected", reason: "gone" };
    const seen = this.ledger.get(op.client_op_id);
    if (seen) {
      if (seen.actor !== actor || seen.target !== op.target)
        return { client_op_id: op.client_op_id, result: "rejected", reason: "duplicate_id" };
      return { ...seen.result, duplicate: true, item: { ...item } };
    }
    const before = { ...item };
    const ordersBefore = structuredClone(this.orders);
    let outcome: { result: OpResult["result"]; reason?: string } = { result: "applied" };
    if (CAS.has(op.op) && this.changedBySomeoneElse(item, op, actor)) outcome = { result: "stale" };
    else {
      const reason = this.handle(item, op, actor);
      if (reason) outcome = { result: "rejected", reason };
    }
    if (outcome.result === "applied") {
      item.rev += 1;
      this.effects.set(op.client_op_id, (this.effects.get(op.client_op_id) ?? 0) + 1);
    } else {
      Object.assign(item, before);
      this.orders = ordersBefore;
    }
    const result: OpResult = { client_op_id: op.client_op_id, result: outcome.result, item: { ...item } };
    if (outcome.reason) result.reason = outcome.reason;
    // As the engine (_last_change): a stale answer says who made the item's last applied step, and when.
    if (outcome.result === "stale") {
      const last = [...this.ledger.values()].findLast((r) => r.target === item.id && r.rev !== null);
      result.changed = last
        ? { op: last.op.op, by: last.actor, by_name: this.names.get(last.actor) ?? null, at: new Date().toISOString() }
        : null;
    }
    if (outcome.result === "applied") result.rev = item.rev;
    this.ledger.set(op.client_op_id, {
      result,
      actor,
      target: op.target,
      op,
      rev: outcome.result === "applied" ? item.rev : null,
      before,
      reverted: false,
    });
    return { ...result };
  }

  private changedBySomeoneElse(item: ItemState, op: Operation, actor: string): boolean {
    const base = op.base_rev ?? -1;
    if (base === item.rev) return false;
    if (base > item.rev || op.queue_id === null) return true;
    const steps = [...this.ledger.values()].filter((r) => r.target === item.id && r.rev !== null && r.rev > base);
    if (steps.length !== item.rev - base) return true;
    return steps.some((s) => s.actor !== actor || s.op.queue_id !== op.queue_id);
  }

  private bought(item: ItemState, quantity: number): void {
    if (item.mode === "units") item.quantity = (item.quantity ?? 0) + quantity;
    if (item.mode === "on_demand" || item.mode === "pinned") item.needed = false;
    if (item.mode === "level") item.level = "ok";
  }

  private handle(item: ItemState, op: Operation, actor: string): string | undefined {
    const a = op.args;
    switch (op.op) {
      case "adjust":
        if (item.mode !== "units") return "invalid_for_mode";
        if (!isInt(a.delta) || a.delta === 0) return "invalid";
        item.quantity = (item.quantity ?? 0) + (a.delta as number);
        return undefined;
      case "buy":
        if (a.quantity !== undefined && !isInt(a.quantity, 1)) return "invalid";
        this.bought(item, (a.quantity as number) ?? 1);
        return undefined;
      case "mark_ordered":
        if (a.quantity !== undefined && !isInt(a.quantity, 1)) return "invalid";
        if (this.orders.has(a.order_id as string)) return "already_done";
        this.orders.set(a.order_id as string, { item: item.id, quantity: (a.quantity as number) ?? 1, status: "open" });
        return undefined;
      case "arrived":
      case "cancel": {
        const order = this.orders.get(a.order_id as string);
        if (!order || order.item !== item.id) return "gone";
        if (op.op === "cancel") {
          if (order.status !== "open") return "already_done";
          order.status = "cancelled";
          return undefined;
        }
        if (order.status === "received") return "already_done";
        if (a.quantity !== undefined && !isInt(a.quantity, 1)) return "invalid";
        order.status = "received";
        this.bought(item, (a.quantity as number) ?? order.quantity);
        return undefined;
      }
      case "set_level":
        if (item.mode !== "level") return "invalid_for_mode";
        if (!LEVELS.has(a.level as string)) return "invalid";
        item.level = a.level as ItemState["level"];
        return undefined;
      case "set_needed":
        if (item.mode !== "on_demand" && item.mode !== "pinned") return "invalid_for_mode";
        if (typeof a.needed !== "boolean") return "invalid";
        item.needed = a.needed;
        return undefined;
      case "recount":
        if (item.mode !== "units") return "invalid_for_mode";
        if (!isInt(a.quantity)) return "invalid";
        item.quantity = a.quantity as number;
        return undefined;
      case "pin":
        if (typeof a.pinned !== "boolean") return "invalid";
        if (item.mode !== "pinned" && item.mode !== "on_demand") return "invalid_for_mode";
        item.mode = a.pinned ? "pinned" : "on_demand";
        return undefined;
      case "change_mode": {
        if (!MODES.has(a.mode as string)) return "invalid";
        if (a.mode === item.mode) return "invalid_for_mode";
        const mode = a.mode as ItemState["mode"];
        if (mode === "level" && a.level !== undefined && !LEVELS.has(a.level as string)) return "invalid";
        if (mode === "units" && !isInt(a.quantity)) return "invalid";
        Object.assign(item, { mode, needed: false, level: null, quantity: null });
        if (mode === "level") item.level = (a.level as ItemState["level"]) ?? "ok";
        if (mode === "units") item.quantity = a.quantity as number;
        return undefined;
      }
      case "revert": {
        const target = this.ledger.get(a.reverts as string);
        if (!target || target.target !== item.id) return "gone";
        if (target.actor !== actor) return "not_yours";
        if (target.result.result !== "applied" || NOT_REVERTIBLE.has(target.op.op)) return "not_revertible";
        if (target.reverted) return "already_done";
        if (target.rev !== item.rev) return "changed_since";
        if (target.op.op === "adjust") item.quantity = (item.quantity ?? 0) - (target.op.args.delta as number);
        else if (target.op.op === "buy" && item.mode === "units")
          item.quantity = (item.quantity ?? 0) - ((target.op.args.quantity as number) ?? 1);
        else {
          item.needed = target.before.needed;
          item.level = target.before.level;
          item.quantity = target.before.quantity;
          item.mode = target.before.mode;
        }
        target.reverted = true;
        return undefined;
      }
      default:
        return "invalid";
    }
  }
}
