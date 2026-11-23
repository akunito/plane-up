// Small shared pieces. Real buttons and labels; every action's accessible name includes the item;
// touch targets at least 44 px (style.css); low and out told apart by text and icon, not colour alone.

import { Fragment, createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ItemState, Level } from "@plane/inventory";
import type { Controller } from "./controller";
import type { Key, Locale, T } from "./i18n";
import { ago } from "./i18n";
import type { Badge as BadgeKind, ItemData } from "./model";
import { badge, shownQuantity } from "./model";

export interface Ctx {
  c: Controller;
  t: T;
  locale: Locale;
  now: () => number;
}

export const AppCtx = createContext<Ctx | null>(null);

export function useCtx(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("no app context");
  return ctx;
}

// ---------------------------------------------------------------- icons (stroke, aria-hidden)

const svg = (size: number, children: ReactNode, fill = "none") => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

const PIN_PATH = (
  <>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </>
);

export const Icon = {
  pin: (on: boolean, size = 16) => svg(size, PIN_PATH, on ? "currentColor" : "none"),
  search: () =>
    svg(
      16,
      <>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </>
    ),
  cart: (size = 16) =>
    svg(
      size,
      <>
        <circle cx="8" cy="21" r="1" />
        <circle cx="19" cy="21" r="1" />
        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
      </>
    ),
  back: () => svg(20, <path d="m15 18-6-6 6-6" />),
  // lucide PanelLeft: the main app's sidebar toggle (AppSidebarToggleButton).
  panelLeft: () =>
    svg(
      20,
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18" />
      </>
    ),
  chevron: () => svg(14, <path d="m9 18 6-6-6-6" />),
  // lucide Package: the inventory entry of the main app's project navigation.
  package: () =>
    svg(
      16,
      <>
        <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
        <path d="M12 22V12" />
        <path d="m3.3 7 7.79 4.5a2 2 0 0 0 1.81 0l7.79-4.5" />
        <path d="m7.5 4.27 9 5.15" />
      </>
    ),
  down: () => svg(14, <path d="m6 9 6 6 6-6" />),
  plus: (size = 16) => svg(size, <path d="M5 12h14M12 5v14" />),
  minus: () => svg(16, <path d="M5 12h14" />),
  check: () => svg(14, <path d="M20 6 9 17l-5-5" />),
  truck: () =>
    svg(
      18,
      <>
        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
        <path d="M15 18H9" />
        <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
        <circle cx="17" cy="18" r="2" />
        <circle cx="7" cy="18" r="2" />
      </>
    ),
  external: () =>
    svg(
      18,
      <>
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </>
    ),
  // Out: an empty ring; low: a half-filled ring. Shape tells them apart without colour.
  out: () => (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  low: () => (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 0 0 9z" fill="currentColor" />
    </svg>
  ),
};

// ---------------------------------------------------------------- state badge

export function StateBadge({ state }: { state: ItemState }) {
  const { t } = useCtx();
  const kind: BadgeKind = badge(state);
  if (kind === null || kind === "ok" || kind === "pinned") return null;
  if (kind === "below")
    return (
      <span className="badge warn" data-badge="below">
        {Icon.low()}
        {t("badge_below", { have: shownQuantity(state), min: state.min_quantity ?? 0 })}
      </span>
    );
  const cls = kind === "out" ? "danger" : kind === "low" ? "warn" : kind === "recount" ? "danger" : "plain";
  const label: Key = `badge_${kind}`;
  return (
    <span className={`badge ${cls}`} data-badge={kind}>
      {kind === "out" ? Icon.out() : kind === "low" ? Icon.low() : null}
      {t(label)}
    </span>
  );
}

// ---------------------------------------------------------------- controls

export function Stepper({
  item,
  value,
  warn,
  onLess,
  onMore,
  onValue,
}: {
  item: string;
  value: number;
  warn?: boolean;
  onLess: () => void;
  onMore: () => void;
  /** Tapping the number opens a field to type it (a recount). */
  onValue?: () => void;
}) {
  const { t } = useCtx();
  return (
    <div className="stepper">
      <button type="button" className="icon" aria-label={t("less", { item })} onClick={onLess}>
        {Icon.minus()}
      </button>
      {onValue ? (
        <button
          type="button"
          className={`stepper-value${warn ? " warn-text" : ""}`}
          aria-label={t("recount_label", { item, n: value })}
          onClick={onValue}
        >
          {value}
        </button>
      ) : (
        <span className={`stepper-value${warn ? " warn-text" : ""}`}>{value}</span>
      )}
      <button type="button" className="icon" aria-label={t("more", { item })} onClick={onMore}>
        {Icon.plus()}
      </button>
    </div>
  );
}

const LEVELS: readonly Level[] = ["ok", "low", "out"];

export function LevelSwitch({
  item,
  level,
  onLevel,
}: {
  item: string;
  level: Level | null;
  onLevel: (l: Level) => void;
}) {
  const { t } = useCtx();
  return (
    <div className="segmented" role="group" aria-label={item}>
      {LEVELS.map((l) => {
        const text = t(`level_${l}`);
        return (
          <button
            key={l}
            type="button"
            className={`seg level-${l}`}
            aria-pressed={level === l}
            aria-label={t("level_label", { item, level: text })}
            onClick={() => level !== l && onLevel(l)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function PinButton({
  item,
  pinned,
  onToggle,
  withText,
}: {
  item: string;
  pinned: boolean;
  onToggle: () => void;
  withText?: boolean;
}) {
  const { t } = useCtx();
  return (
    <button
      type="button"
      className={`pin${pinned ? " on" : ""}${withText ? " with-text" : " icon"}`}
      aria-pressed={pinned}
      aria-label={t(pinned ? "unpin_label" : "pin_label", { item })}
      onClick={onToggle}
    >
      {Icon.pin(pinned)}
      {withText && pinned ? t("badge_pinned") : null}
    </button>
  );
}

export function NeededButton({ item, needed, onToggle }: { item: string; needed: boolean; onToggle: () => void }) {
  const { t } = useCtx();
  return (
    <button
      type="button"
      className={`chip${needed ? " pressed" : ""}`}
      aria-pressed={needed}
      aria-label={t("needed_label", { item })}
      onClick={onToggle}
    >
      {needed ? Icon.check() : null}
      {t("needed")}
    </button>
  );
}

/** The one-tap control for an item's mode, as in quick capture and the inventory (mockups). */
export function ItemControl({ data, state, onRecount }: { data: ItemData; state: ItemState; onRecount?: () => void }) {
  const { c, t } = useCtx();
  const item = data.name;
  switch (state.mode) {
    case "level":
      return (
        <LevelSwitch
          item={item}
          level={state.level}
          onLevel={(level) =>
            void c.act(
              "set_level",
              data.id,
              { level },
              { toast: t("toast_level", { item, level: t(`level_${level}`) }) }
            )
          }
        />
      );
    case "units":
      return (
        <Stepper
          item={item}
          value={shownQuantity(state)}
          warn={(state.quantity ?? 0) < (state.min_quantity ?? 0)}
          onLess={() =>
            void c.act(
              "adjust",
              data.id,
              { delta: -1 },
              { toast: t("toast_quantity", { item, n: Math.max((state.quantity ?? 0) - 1, 0) }) }
            )
          }
          onMore={() =>
            void c.act(
              "adjust",
              data.id,
              { delta: 1 },
              { toast: t("toast_quantity", { item, n: Math.max((state.quantity ?? 0) + 1, 0) }) }
            )
          }
          {...(onRecount ? { onValue: onRecount } : {})}
        />
      );
    case "pinned":
      return (
        <PinButton
          item={item}
          pinned
          withText
          onToggle={() => void c.act("pin", data.id, { pinned: false }, { toast: t("toast_unpinned", { item }) })}
        />
      );
    case "on_demand":
      return (
        <div className="row-actions">
          <PinButton
            item={item}
            pinned={false}
            onToggle={() => void c.act("pin", data.id, { pinned: true }, { toast: t("toast_pinned", { item }) })}
          />
          <NeededButton
            item={item}
            needed={state.needed}
            onToggle={() =>
              void c.act(
                "set_needed",
                data.id,
                { needed: !state.needed },
                { toast: t(state.needed ? "toast_not_needed" : "toast_needed", { item }) }
              )
            }
          />
        </div>
      );
  }
}

// ---------------------------------------------------------------- dialog

/** A modal sheet: focus moves in, Escape and the backdrop close it, focus returns to the opener. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, button");
    first?.focus();
    return () => opener?.focus?.();
  }, []);
  return (
    // The backdrop only adds a pointer way out; the keyboard has Escape on the dialog itself.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2 className="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A number typed by the person (recount, quantities). Integers only, as the server takes. */
export function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        step={1}
        {...(min !== undefined ? { min } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function parseIntStrict(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000 ? n : null;
}

/** Re-render every so often so relative times ("3 min ago") stay true. */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

/** A relative time ("4 days ago") as a <time> element: screen readers get the instant, and the visual
 * baselines mask every <time>, because the text changes from one run to the next. */
export function Ago({ at }: { at: string | number }) {
  const { locale, now } = useCtx();
  return <time dateTime={typeof at === "number" ? new Date(at).toISOString() : at}>{ago(locale, at, now())}</time>;
}

/** A translated sentence whose placeholders may be elements (an <Ago>, a name in bold). */
export function Rich({ k, vars }: { k: Key; vars: Record<string, ReactNode> }) {
  const { t } = useCtx();
  // Without vars, t returns the template untouched; odd parts of the split are placeholder names.
  const parts = t(k).split(/\{(\w+)\}/);
  // The template is fixed for a key, so the position IS a stable identity here.
  // oxlint-disable-next-line react/no-array-index-key
  return <>{parts.map((p, i) => (i % 2 === 1 ? <Fragment key={i}>{p in vars ? vars[p] : `{${p}}`}</Fragment> : p))}</>;
}
