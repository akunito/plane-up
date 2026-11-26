// Shopping mode: large rows, a quantity stepper on rows counted in units, "Done" on this device, finish
// (mockup ModoCompra). Items bought online are not shown here (brief: Designer defaults).

import { useMemo, useState } from "react";
import type { AppState } from "../controller";
import type { Row } from "../model";
import { board, group } from "../model";
import { Icon, Stepper, useCtx, useTick } from "../ui";
import { QueueStatus } from "./common";
import { DoneSection, groupLabel, tickArgs } from "./ToBuy";

export function Shop({ s }: { s: AppState }) {
  const { c, t } = useCtx();
  useTick(60_000);
  const b = useMemo(() => board(s.known, s.queue, s.orders, s.covered), [s.known, s.queue, s.orders, s.covered]);
  const inStore = b.toBuy.filter((r) => !r.data.buy_online);
  const online = b.toBuy.filter((r) => r.data.buy_online);
  const grouping = s.preferences.default_grouping;
  const groups = group(inStore, grouping, s.preferences.category_order);
  const total = inStore.length + b.done.length;
  return (
    <div className="screen">
      <header className="topbar back">
        <a href="#/" className="icon-button" aria-label={t("back")}>
          {Icon.back()}
        </a>
        <h1 className="title">{t("shopping_mode")}</h1>
        <span className="muted">{t("progress", { done: b.done.length, total })}</span>
      </header>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={b.done.length}
        aria-label={t("progress", { done: b.done.length, total })}
      >
        <div style={{ width: total ? `${(100 * b.done.length) / total}%` : "0%" }} />
      </div>
      <QueueStatus s={s} />
      <main className="scroll">
        {groups.length === 0 && b.done.length === 0 ? <p className="empty">{t("empty_list")}</p> : null}
        {groups.map((g) => (
          <section key={g.key} aria-label={groupLabel(t, grouping, g.label)}>
            <h2 className="group">{groupLabel(t, grouping, g.label)}</h2>
            {g.rows.map((row) => (
              <ShopRow key={row.id} row={row} />
            ))}
          </section>
        ))}
        <DoneSection rows={b.done} big />
        {online.length > 0 ? (
          <p className="muted small pad">{t("online_hidden", { items: online.map((r) => r.data.name).join(", ") })}</p>
        ) : null}
      </main>
      <footer className="bottombar column">
        <a
          href="#/"
          className="primary wide"
          onClick={() => {
            void c.finishShopping();
          }}
        >
          {t("finish")}
        </a>
        <span className="muted small center">{t("finish_hint")}</span>
      </footer>
    </div>
  );
}

function ShopRow({ row }: { row: Row }) {
  const { c, t } = useCtx();
  const item = row.data.name;
  const [quantity, setQuantity] = useState<number | null>(null);
  const qty = quantity ?? row.quantity;
  const sub =
    row.state.mode === "pinned" || row.state.mode === "on_demand"
      ? t("badge_needed")
      : row.state.mode === "level"
        ? t(row.state.level === "out" ? "badge_out" : "badge_low")
        : t("below_min", { min: row.state.min_quantity ?? 0 });
  const tone =
    row.state.mode === "level"
      ? row.state.level === "out"
        ? "danger-text"
        : "warn-text"
      : row.state.mode === "units"
        ? "warn-text"
        : "muted";
  return (
    <div className="row big" data-item={row.id}>
      <label className="tick-label grow">
        <input
          type="checkbox"
          className="tick big"
          checked={false}
          aria-label={t("tick_label", { item })}
          onChange={() =>
            void c.act("buy", row.id, row.state.mode === "units" ? { quantity: qty } : tickArgs(row), {
              tick: true,
              toast: t("toast_bought", { item }),
            })
          }
        />
        <span className="grow">
          <span className="name block">{item}</span>
          <span className={`sub block ${tone}`}>{sub}</span>
        </span>
      </label>
      {row.state.mode === "units" ? (
        <Stepper
          item={item}
          value={qty}
          onLess={() => setQuantity(Math.max(qty - 1, 1))}
          onMore={() => setQuantity(Math.min(qty + 1, 999))}
        />
      ) : null}
    </div>
  );
}
