/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The one-tap state control of an item, by mode, shared by Project › Inventory and the Home widget:
// needed (occasional), the three levels, − and + with the count (units; the table also lets you type a
// recount), and the pinned hint.

import type { InputHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import type { OpName } from "@plane/inventory";
import type { InventoryT } from "./i18n";
import type { Item } from "./online";

const PILL = "rounded-md border px-2 py-0.5 text-13";
const ON = "border-accent-strong bg-accent-subtle text-accent-primary";
const OFF = "border-subtle text-secondary hover:bg-layer-1";

export const num = (v: unknown) => (typeof v === "number" ? String(v) : "");
export const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * An inline field that shows what the server holds (phase 5 audit: uncontrolled inputs kept values that
 * were never saved). The draft follows `value` while the field is not being edited; on leaving it the
 * draft is committed, and the field then shows what the commit returns (the server's value, e.g. a name
 * with its spaces collapsed) or, when the commit fails or is refused, the saved value again.
 */
export function EditableField(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "onBlur"> & {
    value: string;
    /** Resolves to the value now saved, or null when nothing was saved. Not called when unchanged. */
    onCommit: (draft: string) => Promise<string | null>;
  }
) {
  const { value, onCommit, ...rest } = props;
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <input
      {...rest}
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(latest.current);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        editing.current = false;
        if (draft === latest.current) return;
        const sent = draft;
        void onCommit(sent).then((saved) => {
          // A newer edit started meanwhile: leave it alone.
          if (!editing.current) setDraft(saved ?? latest.current);
          return undefined;
        });
      }}
    />
  );
}

export function StateControl(props: {
  item: Item;
  t: InventoryT;
  /** Resolves to the item as the server answered (null when nothing came back). */
  onOp: (name: OpName, args: Record<string, unknown>) => Promise<Item | null>;
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
        onClick={() => void onOp("set_needed", { needed: !item.needed })}
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
            onClick={() => item.level !== level && void onOp("set_level", { level })}
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
        onClick={() => void onOp("adjust", { delta: -1 })}
      >
        −
      </button>
      {recount ? (
        <EditableField
          className="w-14 rounded-sm border border-subtle bg-transparent px-1.5 py-0.5 text-center text-13 text-primary outline-none focus:border-accent-strong"
          inputMode="numeric"
          value={num(item.quantity)}
          aria-label={`${item.name}: ${t("col_state")}`}
          onCommit={async (raw) => {
            if (!/^-?\d{1,6}$/.test(raw.trim())) return null;
            const fresh = await onOp("recount", { quantity: Number(raw.trim()) });
            return fresh ? num(fresh.quantity) : null;
          }}
        />
      ) : (
        <span className="min-w-6 text-center text-13 text-primary">{Math.max(item.quantity ?? 0, 0)}</span>
      )}
      <button
        type="button"
        className={`${PILL} ${OFF}`}
        aria-label={`${item.name}: +1`}
        onClick={() => void onOp("adjust", { delta: 1 })}
      >
        +
      </button>
    </span>
  );
}
