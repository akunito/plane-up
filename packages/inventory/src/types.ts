// Mirrors the API (apps/api/plane/app/inventory). Design: docs/INVENTORY_DESIGN.md.

export type Mode = "pinned" | "on_demand" | "level" | "units";
export type Level = "ok" | "low" | "out";

export type OpName =
  | "adjust"
  | "buy"
  | "mark_ordered"
  | "arrived"
  | "cancel"
  | "set_level"
  | "set_needed"
  | "pin"
  | "change_mode"
  | "recount"
  | "revert";

/** Things that happened: always applied, never compared against a revision. */
export const ALWAYS: ReadonlySet<OpName> = new Set<OpName>(["adjust", "buy", "mark_ordered", "arrived", "cancel"]);
/** Statements about the present: compared on base_rev, with the same-queue exemption. */
export const CAS: ReadonlySet<OpName> = new Set<OpName>(["set_level", "set_needed", "pin", "change_mode", "recount"]);

export interface ItemState {
  id: string;
  rev: number;
  mode: Mode;
  needed: boolean;
  level: Level | null;
  quantity: number | null;
  min_quantity: number | null;
  restock_to: number | null;
  last_bought_at: string | null;
  last_bought_by: string | null;
  /** In every item payload; lets the app refresh an item that is not on the to-buy list. */
  list?: { id: string };
  project?: { id: string };
}

export interface Operation {
  v: 1;
  client_op_id: string;
  queue_id: string | null;
  target: string;
  op: OpName;
  args: Record<string, unknown>;
  base_rev?: number;
  age_ms?: number;
}

export type ResultKind = "applied" | "stale" | "rejected";

export interface OpResult {
  client_op_id: string | null;
  result: ResultKind;
  reason?: string;
  duplicate?: boolean;
  order_id?: string;
  /** For an applied operation: the revision it produced (a duplicate's item is the current state). */
  rev?: number;
  item?: ItemState;
  changed?: { op: string; by: string | null; by_name: string | null; at: string | null } | null;
}
