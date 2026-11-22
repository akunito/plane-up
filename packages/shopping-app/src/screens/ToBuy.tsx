// The to-buy list: grouped rows with ticks, "On the way", and "Done" kept on this device (mockup Main).

import { useMemo, useState } from "react";
import type { AppState } from "../controller";
import type { Grouping, Order, Row } from "../model";
import { board, group, personName } from "../model";
import { shortDate } from "../i18n";
import type { Key } from "../i18n";
import { prefs } from "../store";
import { Ago, Icon, Rich, StateBadge, useCtx, useTick } from "../ui";
import { ArrivalDialog, BottomBar, BoughtAgo, OrderDialog, QueueStatus, Tabs, WorkspacePicker } from "./common";

const GROUPINGS: readonly Grouping[] = ["category", "store", "list", "urgency"];

export function groupLabel(t: (k: Key) => string, grouping: Grouping, label: string): string {
  if (grouping === "urgency") return t(`urgency_${label}` as Key);
  if (!label) return t(grouping === "store" ? "no_store" : "no_category");
  return label;
}

/** The quantity a tick buys: what the list asks for; a pinned, needed or level item buys one. */
export function tickArgs(row: Row): Record<string, unknown> {
  return row.state.mode === "units" ? { quantity: row.quantity } : {};
}

export function ToBuy({ s }: { s: AppState }) {
  const { c, t, locale } = useCtx();
  useTick(60_000);
  const [listFilter, setListFilter] = useState(prefs.get("listFilter") ?? "");
  const [ordering, setOrdering] = useState<Row | null>(null);
  const [arriving, setArriving] = useState<{ itemId: string; name: string; orders: Order[] } | null>(null);
  const b = useMemo(() => board(s.known, s.queue, s.orders, s.covered), [s.known, s.queue, s.orders, s.covered]);
  const lists = s.lists?.lists ?? [];
  const filter = lists.some((l) => l.id === listFilter) ? listFilter : "";
  const rows = filter ? b.toBuy.filter((r) => r.data.list.id === filter) : b.toBuy;
  const grouping = s.preferences.default_grouping;
  const groups = group(rows, grouping, s.preferences.category_order);
  const done = filter ? b.done.filter((r) => r.data.list.id === filter) : b.done;
  const onTheWay = filter ? b.onTheWay.filter((o) => o.row?.data.list.id === filter) : b.onTheWay;

  return (
    <div className="screen">
      <Tabs active="shopping" summary={t("summary", { missing: b.count, pinned: b.pinned })} />
      <div className="toolbar">
        <label className="select">
          <span className="visually-hidden">{t("group_by", { grouping: "" })}</span>
          <select value={grouping} onChange={(e) => void c.setGrouping(e.target.value as Grouping)}>
            {GROUPINGS.map((g) => (
              <option key={g} value={g}>
                {t("group_by", { grouping: t(`grouping_${g}`) })}
              </option>
            ))}
          </select>
          {Icon.down()}
        </label>
        <label className="select">
          <span className="visually-hidden">{t("list")}</span>
          <select
            value={filter}
            onChange={(e) => {
              setListFilter(e.target.value);
              prefs.set("listFilter", e.target.value || null);
            }}
          >
            <option value="">{t("all_lists")}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {Icon.down()}
        </label>
      </div>
      <QueueStatus s={s} />
      <main className="scroll">
        {groups.length === 0 && done.length === 0 ? <p className="empty">{t("empty_list")}</p> : null}
        {groups.map((g) => (
          <section key={g.key} aria-label={groupLabel(t, grouping, g.label)}>
            <h2 className="group">{groupLabel(t, grouping, g.label)}</h2>
            {g.rows.map((row) =>
              row.data.buy_online ? (
                <div className="row" key={row.id} data-item={row.id}>
                  <span className="lead muted">{Icon.external()}</span>
                  <div className="grow">
                    <a href={`#/item/${row.id}`} className="name block">
                      {row.data.name}
                      {row.quantity > 1 ? <span className="muted"> ×{row.quantity}</span> : null}
                    </a>
                    <span className="sub block">
                      {row.data.list.name}
                      {row.state.mode === "units"
                        ? ` · ${t("badge_below", { have: Math.max(row.state.quantity ?? 0, 0), min: row.state.min_quantity ?? 0 })}`
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("mark_ordered_label", { item: row.data.name })}
                    onClick={() => setOrdering(row)}
                  >
                    {t("mark_ordered")}
                  </button>
                </div>
              ) : (
                <ToBuyRow key={row.id} row={row} />
              )
            )}
          </section>
        ))}
        {onTheWay.length > 0 ? (
          <section aria-label={t("on_the_way", { n: onTheWay.length })}>
            <h2 className="group divided">{t("on_the_way", { n: onTheWay.length })}</h2>
            {onTheWay.map(({ order, row }) => {
              const name = row?.data.name ?? order.item_name ?? t("unknown_item");
              const by = personName(s.lists, order.bought_since_by) ?? t("someone");
              return (
                <div className={`row${order.overdue ? " overdue" : ""}`} key={order.id} data-order={order.id}>
                  <span className="lead accent">{Icon.truck()}</span>
                  <div className="grow">
                    <span className="name block">
                      {name}
                      <span className="muted"> ×{order.quantity}</span>
                    </span>
                    <span className="sub block">
                      {[row?.data.list.name, order.reference].filter(Boolean).map((part) => `${part} · `)}
                      <Rich k="ordered_ago" vars={{ when: <Ago at={order.ordered_at} /> }} />
                      {order.expected_on ? ` · ${t("expected", { date: shortDate(locale, order.expected_on) })}` : ""}
                    </span>
                    {order.overdue ? <span className="badge danger">{t("overdue")}</span> : null}
                    {order.bought_since_at ? (
                      <span className="sub warn-text">
                        <Rich k="bought_since" vars={{ name: by, when: <Ago at={order.bought_since_at} /> }} />{" "}
                        <button
                          type="button"
                          className="link"
                          aria-label={t("cancel_order_label", { item: name })}
                          onClick={() =>
                            void c.act(
                              "cancel",
                              order.item,
                              { order_id: order.id },
                              { toast: t("toast_cancelled", { item: name }) }
                            )
                          }
                        >
                          {t("cancel_order")}
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {row ? (
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t("arrived_label", { item: name })}
                      onClick={() => setArriving({ itemId: order.item, name, orders: row.orders })}
                    >
                      {t("arrived")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <DoneSection rows={done} />
        <WorkspacePicker />
      </main>
      <BottomBar />
      {ordering ? <OrderDialog row={ordering} onClose={() => setOrdering(null)} /> : null}
      {arriving ? <ArrivalDialog {...arriving} onClose={() => setArriving(null)} /> : null}
    </div>
  );
}

function ToBuyRow({ row }: { row: Row }) {
  const { c, t } = useCtx();
  const item = row.data.name;
  const hint =
    row.state.mode === "pinned" ? (
      <>
        {t("badge_pinned")}
        {row.state.last_bought_at ? (
          <>
            {" · "}
            <BoughtAgo at={row.state.last_bought_at} by={row.state.last_bought_by} />
          </>
        ) : null}
      </>
    ) : null;
  return (
    <label className="row" data-item={row.id}>
      <input
        type="checkbox"
        className="tick"
        checked={false}
        aria-label={t("tick_label", { item })}
        onChange={() => void c.act("buy", row.id, tickArgs(row), { tick: true, toast: t("toast_bought", { item }) })}
      />
      <span className="name grow">
        {item}
        {row.quantity > 1 ? <span className="muted"> ×{row.quantity}</span> : null}
      </span>
      <span className="sub inline">
        {row.data.list.name}
        {hint ? (
          <>
            {" "}
            {Icon.pin(true, 13)} {hint}
          </>
        ) : null}
      </span>
      <StateBadge state={row.state} />
    </label>
  );
}

export function DoneSection({ rows, big }: { rows: Row[]; big?: boolean }) {
  const { c, t } = useCtx();
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("done_header", { n: rows.length })}>
      <h2 className="group divided">{t("done_header", { n: rows.length })}</h2>
      {rows.map((row) => (
        <label className={`row done${big ? " big" : ""}`} key={row.id} data-done={row.id}>
          <input
            type="checkbox"
            className="tick"
            checked
            aria-label={t("untick_label", { item: row.data.name })}
            onChange={async () => {
              const id = c.get().queue.done[row.id];
              const ok = id ? await c.undo(id) : false;
              c.showToast(t(ok ? "toast_undone" : "toast_cannot_undo"));
            }}
          />
          <span className="name grow">{row.data.name}</span>
        </label>
      ))}
    </section>
  );
}
