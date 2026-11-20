// The item sheet: tracking mode, thresholds, organisation, purchase data, barcode, expiry, history
// (mockup Articulo). Data fields save on their own when the field is left (online only, never queued);
// state changes are operations.

import { useEffect, useMemo, useState } from "react";
import type { HistoryEntry, Mode } from "@plane/inventory";
import { fetchHistory, view } from "@plane/inventory";
import type { AppState } from "../controller";
import { MODES, board, personName, shownQuantity } from "../model";
import type { Key } from "../i18n";
import {
  Ago,
  Dialog,
  Icon,
  LevelSwitch,
  NeededButton,
  NumberField,
  Rich,
  Stepper,
  parseIntStrict,
  useCtx,
} from "../ui";
import { AudienceText, OrderDialog } from "./common";
import { RecountDialog } from "./Inventory";

type Field =
  | "name"
  | "category"
  | "store"
  | "purchase_url"
  | "variant"
  | "last_price"
  | "currency"
  | "expires_on"
  | "barcode"
  | "min_quantity"
  | "restock_to";

export function ItemSheet({ s, id }: { s: AppState; id: string }) {
  const { c, t } = useCtx();
  const k = s.known[id];
  const shown = useMemo(() => view(s.queue), [s.queue]);
  const state = shown[id];
  const row = useMemo(() => board(s.known, s.queue, s.orders), [s.known, s.queue, s.orders]);
  const toBuyRow = row.toBuy.find((r) => r.id === id) ?? null;
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [modeDialog, setModeDialog] = useState<Mode | null>(null);
  const [recount, setRecount] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [missing, setMissing] = useState(false);
  const projectId = k?.data.project.id;
  const listId = k?.data.list.id;
  const rev = state?.rev;
  const known = k !== undefined;

  // Opened from a link, or for an item not on the to-buy list: the device may not know it yet. The lists
  // are few, so it loads them until it finds it; then its list is watched so polling keeps it fresh.
  useEffect(() => {
    if (known) return;
    let live = true;
    const lists = c.get().lists?.lists ?? [];
    void Promise.all(lists.map((l) => c.loadList(l.id))).then(() => {
      if (live && !c.get().known[id]) setMissing(true);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [c, id, known]);
  useEffect(() => {
    if (!listId) return;
    c.watch(listId, true);
    return () => c.watch(listId, false);
  }, [c, listId]);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void fetchHistory(c.client(), projectId, id).then((out) => {
      if (live && out.kind === "ok") setHistory(out.body);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [c, id, projectId, rev]);

  if (!k || !state) {
    return (
      <div className="screen">
        <header className="topbar back">
          <a href="#/inventory" className="icon-button" aria-label={t("back")}>
            {Icon.back()}
          </a>
        </header>
        <p className="empty" role={missing ? "alert" : "status"}>
          {t(missing ? "item_missing" : "loading")}
        </p>
      </div>
    );
  }
  const data = k.data;
  const item = data.name;

  async function save(field: Field, raw: string) {
    let value: unknown = raw.trim();
    if (field === "min_quantity" || field === "restock_to") {
      if (raw.trim() === "") value = null;
      else {
        const n = parseIntStrict(raw);
        if (n === null || n < 0) return setMessage(t("save_failed", { error: t("reason_invalid") }));
        value = n;
      }
    }
    if ((field === "last_price" || field === "expires_on") && raw.trim() === "") value = null;
    const current =
      (data as unknown as Record<string, unknown>)[field] ??
      (field === "min_quantity" || field === "restock_to" || field === "last_price" || field === "expires_on"
        ? null
        : "");
    if (String(current ?? "") === String(value ?? "")) return;
    const out = await c.updateItem(id, { [field]: value });
    setMessage(out.ok ? t("saved") : t("save_failed", { error: out.error }));
  }

  function changeMode(mode: Mode) {
    if (mode === state!.mode) return;
    if (mode === "units") return setModeDialog("units");
    void c.act("change_mode", id, { mode }, { toast: t("toast_mode", { item }) });
  }

  const text = (field: Field, label: Key, type = "text", extra: Record<string, unknown> = {}) => (
    <label className="field inline">
      <span>{t(label)}</span>
      <input
        key={`${field}:${String((data as unknown as Record<string, unknown>)[field] ?? "")}`}
        type={type}
        defaultValue={String((data as unknown as Record<string, unknown>)[field] ?? "")}
        onBlur={(e) => void save(field, e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        {...extra}
      />
    </label>
  );

  return (
    <div className="screen">
      <header className="topbar back">
        <a href={`#/inventory/${data.list.id}`} className="icon-button" aria-label={t("back")}>
          {Icon.back()}
        </a>
        <h1 className="title grow">{item}</h1>
      </header>
      <p className="sub pad-left">
        {data.list.name} · <AudienceText s={s} projectId={data.project.id} />
      </p>
      <main className="scroll sheet">
        <h2 className="group">{t("tracking")}</h2>
        <div className="segmented four" role="group" aria-label={t("tracking")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="seg"
              aria-pressed={state.mode === m}
              aria-label={t("mode_label", { item, mode: t(`mode_${m}`) })}
              onClick={() => changeMode(m)}
            >
              {t(`mode_${m}`)}
            </button>
          ))}
        </div>
        {state.mode === "units" ? (
          <>
            <div className="row">
              <span className="muted grow">{t("at_home")}</span>
              <Stepper
                item={item}
                value={shownQuantity(state)}
                warn={(state.quantity ?? 0) < (state.min_quantity ?? 0)}
                onLess={() =>
                  void c.act(
                    "adjust",
                    id,
                    { delta: -1 },
                    { toast: t("toast_quantity", { item, n: Math.max((state.quantity ?? 0) - 1, 0) }) }
                  )
                }
                onMore={() =>
                  void c.act(
                    "adjust",
                    id,
                    { delta: 1 },
                    { toast: t("toast_quantity", { item, n: Math.max((state.quantity ?? 0) + 1, 0) }) }
                  )
                }
                onValue={() => setRecount(true)}
              />
            </div>
            {(state.quantity ?? 0) < 0 ? (
              <p className="notice danger" data-badge="recount">
                {t("badge_recount")}
              </p>
            ) : null}
            {text("min_quantity", "min_at_home", "number", { inputMode: "numeric", min: 0 })}
            {text("restock_to", "restock_to", "number", { inputMode: "numeric", min: 0 })}
          </>
        ) : null}
        {state.mode === "level" ? (
          <div className="row">
            <LevelSwitch
              item={item}
              level={state.level}
              onLevel={(level) =>
                void c.act(
                  "set_level",
                  id,
                  { level },
                  { toast: t("toast_level", { item, level: t(`level_${level}`) }) }
                )
              }
            />
          </div>
        ) : null}
        {state.mode === "on_demand" ? (
          <div className="row">
            <NeededButton
              item={item}
              needed={state.needed}
              onToggle={() =>
                void c.act(
                  "set_needed",
                  id,
                  { needed: !state.needed },
                  { toast: t(state.needed ? "toast_not_needed" : "toast_needed", { item }) }
                )
              }
            />
          </div>
        ) : null}
        {state.mode === "pinned" && state.last_bought_at ? (
          <p className="sub pad">
            <Rich k="bought_ago" vars={{ when: <Ago at={state.last_bought_at} /> }} />
          </p>
        ) : null}
        {toBuyRow ? <p className="notice warn">{t("on_list_with", { n: toBuyRow.quantity })}</p> : null}

        <h2 className="group">{t("organisation")}</h2>
        {text("name", "name")}
        <label className="field inline">
          <span>{t("list")}</span>
          <select
            value={data.list.id}
            onChange={async (e) => {
              const out = await c.updateItem(id, { inventory_list: e.target.value });
              setMessage(out.ok ? t("saved") : t("save_failed", { error: out.error }));
            }}
          >
            {(s.lists?.lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {text("category", "category")}

        <h2 className="group">{t("purchase")}</h2>
        {text("store", "store")}
        <label className="field check inline">
          <input
            type="checkbox"
            checked={data.buy_online}
            onChange={async (e) => {
              const out = await c.updateItem(id, { buy_online: e.target.checked });
              setMessage(out.ok ? t("saved") : t("save_failed", { error: out.error }));
            }}
          />
          <span>{t("buy_online")}</span>
        </label>
        {text("purchase_url", "link", "url")}
        {text("variant", "variant")}
        {text("last_price", "last_price", "text", { inputMode: "decimal" })}
        {text("currency", "currency", "text", { maxLength: 3 })}

        <h2 className="group">{t("optional")}</h2>
        {text("expires_on", "expiry", "date")}
        {text("barcode", "barcode", "text", { inputMode: "numeric", maxLength: 64 })}

        {message ? (
          <p className="notice" role="status">
            {message}
          </p>
        ) : null}

        <h2 className="group">{t("history")}</h2>
        {history === null ? <p className="muted small pad">{t("loading")}</p> : null}
        {history?.length === 0 ? <p className="muted small pad">{t("history_empty")}</p> : null}
        <ul className="history">
          {history?.map((e) => (
            <li key={e.id}>
              <span className="when">
                <Ago at={e.occurred_at} />
              </span>
              <span className="grow">
                {describe(e, t, personName(s.lists, e.actor?.id) ?? e.actor?.display_name ?? t("someone"))}
                {e.reverted ? ` ${t("h_undone")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </main>
      <footer className="bottombar">
        {data.purchase_url ? (
          <a href={data.purchase_url} target="_blank" rel="noopener noreferrer" className="secondary wide">
            {Icon.external()}
            {t("open_link")}
          </a>
        ) : null}
        <button type="button" className="primary wide" onClick={() => setOrdering(true)}>
          {Icon.truck()}
          {t("mark_ordered")}
        </button>
      </footer>
      {modeDialog === "units" ? <UnitsDialog id={id} name={item} onClose={() => setModeDialog(null)} /> : null}
      {recount ? (
        <RecountDialog id={id} name={item} value={String(shownQuantity(state))} onClose={() => setRecount(false)} />
      ) : null}
      {ordering ? (
        <OrderDialog
          row={
            toBuyRow ?? {
              id,
              data,
              state,
              quantity: 1,
              onOrder: 0,
              orders: row.onTheWay.filter((o) => o.order.item === id).map((o) => o.order),
              done: false,
              waiting: false,
            }
          }
          onClose={() => setOrdering(false)}
        />
      ) : null}
    </div>
  );
}

/** Changing to units carries the quantity typed now: a recount, never a leftover (brief: Item state). */
function UnitsDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { c, t } = useCtx();
  const [text, setText] = useState("");
  const n = parseIntStrict(text);
  return (
    <Dialog title={t("mode_label", { item: name, mode: t("mode_units") })} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (n === null || n < 0) return;
          void c.act("change_mode", id, { mode: "units", quantity: n }, { toast: t("toast_mode", { item: name }) });
          onClose();
        }}
      >
        <NumberField label={t("quantity_now")} value={text} onChange={setText} min={0} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={n === null || n < 0}>
            {t("save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function describe(e: HistoryEntry, t: (k: Key, v?: Record<string, string | number>) => string, name: string): string {
  const who = e.source === "api" ? t("via_api", { who: name }) : name;
  const a = e.args;
  const n = typeof a.quantity === "number" ? a.quantity : 1;
  switch (e.op) {
    case "adjust":
      return t("h_adjust", {
        who,
        delta: typeof a.delta === "number" && a.delta > 0 ? `+${a.delta}` : String(a.delta),
      });
    case "buy":
      return t("h_buy", { who, n });
    case "mark_ordered":
      return t("h_mark_ordered", { who, n });
    case "arrived":
      return t("h_arrived", { who, n });
    case "cancel":
      return t("h_cancel", { who });
    case "set_level":
      return t("h_set_level", { who, level: t(`level_${String(a.level)}` as Key) });
    case "set_needed":
      return t(a.needed ? "h_needed_on" : "h_needed_off", { who });
    case "pin":
      return t(a.pinned ? "h_pin_on" : "h_pin_off", { who });
    case "change_mode":
      return t("h_change_mode", { who, mode: t(`mode_${String(a.mode)}` as Key) });
    case "recount":
      return t("h_recount", { who, n });
    default:
      return t("h_revert", { who });
  }
}
