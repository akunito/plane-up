/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The one-tap state control of an item, by mode, shared by Project › Inventory and the Home widget:
// needed (occasional), the three levels, − and + with the count (units; the table also lets you type a
// recount), and the pinned hint.

import type { OpName } from "@plane/inventory";
import type { InventoryT } from "./i18n";
import type { Item } from "./online";

const PILL = "rounded-md border px-2 py-0.5 text-13";
const ON = "border-accent-strong bg-accent-subtle text-accent-primary";
const OFF = "border-subtle text-secondary hover:bg-layer-1";

const num = (v: unknown) => (typeof v === "number" ? String(v) : "");

export function StateControl(props: {
  item: Item;
  t: InventoryT;
  onOp: (name: OpName, args: Record<string, unknown>) => void;
  /** The table types a recount into the count; the widget only steps. */
  recount?: boolean;
}) {
  const { item, t, onOp, recount } = props;
  if (item.mode === "pinned") return <span className="text-13 text-tertiary">{t("pinned_hint")}</span>;
  if (item.mode === "on_demand")
    return (
      <button
        type="button"
        aria-pressed={item.needed}
        aria-label={`${item.name}: ${t("needed")}`}
        className={`${PILL} ${item.needed ? ON : OFF}`}
        onClick={() => onOp("set_needed", { needed: !item.needed })}
      >
        {t("needed")}
      </button>
    );
  if (item.mode === "level")
    return (
      <span className="inline-flex gap-1" role="group" aria-label={item.name}>
        {(["ok", "low", "out"] as const).map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={item.level === level}
            className={`${PILL} ${item.level === level ? ON : OFF}`}
            onClick={() => item.level !== level && onOp("set_level", { level })}
          >
            {t(`level_${level}`)}
          </button>
        ))}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className={`${PILL} ${OFF}`}
        aria-label={`${item.name}: −1`}
        onClick={() => onOp("adjust", { delta: -1 })}
      >
        −
      </button>
      {recount ? (
        <input
          className="w-14 rounded-sm border border-subtle bg-transparent px-1.5 py-0.5 text-center text-13 text-primary outline-none focus:border-accent-strong"
          inputMode="numeric"
          defaultValue={num(item.quantity)}
          aria-label={`${item.name}: ${t("col_state")}`}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw === num(item.quantity)) return;
            if (!/^-?\d{1,6}$/.test(raw)) {
              e.target.value = num(item.quantity);
              return;
            }
            onOp("recount", { quantity: Number(raw) });
          }}
        />
      ) : (
        <span className="min-w-6 text-center text-13 text-primary">{Math.max(item.quantity ?? 0, 0)}</span>
      )}
      <button
        type="button"
        className={`${PILL} ${OFF}`}
        aria-label={`${item.name}: +1`}
        onClick={() => onOp("adjust", { delta: 1 })}
      >
        +
      </button>
    </span>
  );
}
