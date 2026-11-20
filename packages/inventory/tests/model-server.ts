// A small model of the server's two behaviours (apps/api/plane/app/inventory/engine.py), enough to drive
// the device queue against: ledger by client_op_id, same-queue exemption proven step by step, revert
// compared against the revision its operation produced, refusals that never advance the revision.

import { CAS } from "../src/types";
import type { ItemState, OpResult, Operation } from "../src/types";

interface Recorded {
  result: OpResult;
  actor: string;
  target: string;
  op: Operation;
  rev: number | null;
  before: ItemState;
  reverted: boolean;
}

export class ModelServer {
  items = new Map<string, ItemState>();
  ledger = new Map<string, Recorded>();
  effects = new Map<string, number>();

  constructor(items: ItemState[]) {
    for (const i of items) this.items.set(i.id, { ...i });
  }

  snapshot(): ItemState[] {
    return Array.from(this.items.values(), (i) => Object.assign({}, i));
  }

  apply(ops: Operation[], actor: string): OpResult[] {
    return ops.map((op) => this.one(op, actor));
  }

  private one(op: Operation, actor: string): OpResult {
    const item = this.items.get(op.target);
    if (!item) return { client_op_id: op.client_op_id, result: "rejected", reason: "gone" };
    const seen = this.ledger.get(op.client_op_id);
    if (seen) {
      if (seen.actor !== actor) return { client_op_id: op.client_op_id, result: "rejected", reason: "duplicate_id" };
      return { ...seen.result, duplicate: true, item: { ...item } };
    }
    const before = { ...item };
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
    }
    const result: OpResult = { client_op_id: op.client_op_id, result: outcome.result, item: { ...item } };
    if (outcome.reason) result.reason = outcome.reason;
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

  private handle(item: ItemState, op: Operation, actor: string): string | undefined {
    const a = op.args;
    switch (op.op) {
      case "adjust":
        if (item.mode !== "units") return "invalid_for_mode";
        item.quantity = (item.quantity ?? 0) + (a.delta as number);
        return undefined;
      case "buy":
        if (item.mode === "units") item.quantity = (item.quantity ?? 0) + ((a.quantity as number) ?? 1);
        if (item.mode === "on_demand") item.needed = false;
        if (item.mode === "level") item.level = "ok";
        return undefined;
      case "set_level":
        if (item.mode !== "level") return "invalid_for_mode";
        item.level = a.level as ItemState["level"];
        return undefined;
      case "set_needed":
        if (item.mode !== "on_demand") return "invalid_for_mode";
        item.needed = Boolean(a.needed);
        return undefined;
      case "recount":
        if (item.mode !== "units") return "invalid_for_mode";
        item.quantity = a.quantity as number;
        return undefined;
      case "revert": {
        const target = this.ledger.get(a.reverts as string);
        if (!target || target.target !== item.id) return "gone";
        if (target.actor !== actor) return "not_yours";
        if (target.result.result !== "applied" || target.op.op === "revert") return "not_revertible";
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
