// The to-buy rule. Same rule as apps/api/plane/app/inventory/derive.py, checked against the same
// fixture (apps/api/plane/tests/fixtures/inventory/derivation.json) on both sides.

import type { Level, Mode } from "./types";

export interface DeriveInput {
  mode: Mode;
  needed?: boolean;
  level?: Level | null;
  quantity?: number | null;
  min_quantity?: number | null;
  restock_to?: number | null;
  on_order: number;
  has_open_order: boolean;
}

/** The quantity to buy, or 0 when the item is not on the to-buy list. */
export function toBuy(i: DeriveInput): number {
  switch (i.mode) {
    case "pinned":
      return i.has_open_order ? 0 : 1;
    case "on_demand":
      return i.needed && !i.has_open_order ? 1 : 0;
    case "level":
      return (i.level === "low" || i.level === "out") && !i.has_open_order ? 1 : 0;
    case "units": {
      const have = Math.max(i.quantity ?? 0, 0);
      const minimum = i.min_quantity ?? 0;
      if (have + i.on_order >= minimum) return 0;
      const target = i.restock_to ?? minimum;
      return Math.max(1, target - have - i.on_order);
    }
  }
}

/** The sidebar counter counts what is really missing; pinned rows never do, or it never reaches 0. */
export function counts(mode: Mode): boolean {
  return mode !== "pinned";
}
