// Inventory by list: every item, with its one-tap control, typing a recount, the "recount" mark, and
// orders on the way (mockup Inventario). Lists load when shown and reload with every refresh.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { view } from "@plane/inventory";
import type { AppState } from "../controller";
import type { ItemData, Order } from "../model";
import { badge, openOrders } from "../model";
import { Ago, Dialog, Icon, ItemControl, Rich, NumberField, parseIntStrict, useCtx, useTick } from "../ui";
import { ArrivalDialog, AudienceText, BottomBar, QueueStatus, Tabs } from "./common";

export function Inventory({ s, listId }: { s: AppState; listId?: string }) {
  const { c, t } = useCtx();
  useTick(60_000);
  const lists = s.lists?.lists ?? [];
  const showing = listId && lists.some((l) => l.id === listId) ? lists.filter((l) => l.id === listId) : lists;
  const key = showing.map((l) => l.id).join(",");
  useEffect(() => {
    for (const l of showing) {
      c.watch(l.id, true);
      void c.loadList(l.id);
    }
    return () => {
      for (const l of showing) c.watch(l.id, false);
    };
    // The key is the set of lists shown.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, c]);

  const shown = useMemo(() => view(s.queue), [s.queue]);
  const orders = useMemo(() => openOrders(s.orders, s.queue, s.covered), [s.orders, s.queue, s.covered]);
  const [recount, setRecount] = useState<{ id: string; name: string; value: string } | null>(null);
  const [arriving, setArriving] = useState<{ itemId: string; name: string; orders: Order[] } | null>(null);

  // One row, in the pinned section (with its list's name) or in its list.
  const row = (data: ItemData, pinnedRow: boolean) => {
    const state = shown[data.id]!;
    const mine = orders.filter((o) => o.item === data.id);
    const kind = badge(state);
    return (
      <div className="row tall" key={pinnedRow ? `pinned-${data.id}` : data.id} data-item={data.id}>
        <div className="grow">
          <a href={`#/item/${data.id}`} className="name block" aria-label={t("open_item", { item: data.name })}>
            {data.name}
          </a>
          {pinnedRow ? <span className="sub block">{data.list.name}</span> : null}
          {kind === "below" ? (
            <span className="sub warn-text block">{t("below_min", { min: state.min_quantity ?? 0 })}</span>
          ) : null}
          {kind === "recount" ? (
            <span className="sub danger-text block" data-badge="recount">
              {t("badge_recount")}
            </span>
          ) : null}
          {mine.map((o) => (
            <span key={o.id} className="sub accent block">
              {Icon.truck()} <Rich k="ordered_line" vars={{ n: o.quantity, when: <Ago at={o.ordered_at} /> }} />
            </span>
          ))}
        </div>
        {mine.length > 0 ? (
          <button
            type="button"
            className="secondary"
            aria-label={t("arrived_label", { item: data.name })}
            onClick={() => setArriving({ itemId: data.id, name: data.name, orders: mine })}
          >
            {t("arrived")}
          </button>
        ) : (
          <ItemControl
            data={data}
            state={state}
            onRecount={() =>
              setRecount({ id: data.id, name: data.name, value: String(Math.max(state.quantity ?? 0, 0)) })
            }
          />
        )}
      </div>
    );
  };

  // Alphabetical within a list (owner, 2026-11-26); pinned rows are also gathered at the top, across the lists shown.
  const listed = Object.values(s.known)
    .filter((k) => shown[k.data.id] && showing.some((l) => l.id === k.data.list.id))
    .toSorted((a, b) => a.data.name.localeCompare(b.data.name));
  const byList = new Map<string, typeof listed>();
  for (const k of listed) {
    const at = byList.get(k.data.list.id);
    if (at) at.push(k);
    else byList.set(k.data.list.id, [k]);
  }
  const pinned = listed.filter((k) => shown[k.data.id]!.mode === "pinned");

  // A pin adds or removes a row in the Pinned section ABOVE the lists, which moves every row below it by a row's
  // height: the row just tapped is put back where it was on the screen, as far as the scroll allows (at the top, a
  // row removed above still pulls it up) (audit 2026-11-26; browser scroll anchoring does not do it at the top of
  // the page, and iOS has none). Only within two seconds of the tap, and only if the list has not scrolled since: a
  // scroll in between is the person's own (compared, not listened for: a scroll event can arrive after the tap).
  const main = useRef<HTMLElement>(null);
  const anchor = useRef<{ el: Element; top: number; at: number; scroll: number } | null>(null);
  const pinnedKey = pinned.map((k) => k.data.id).join(",");
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a || !main.current || !a.el.isConnected || Date.now() - a.at > 2000) return;
    if (main.current.scrollTop !== a.scroll) return;
    // Measured inside the list's box: a status line appearing above the list moves the box, not the rows in it.
    const moved = a.el.getBoundingClientRect().top - main.current.getBoundingClientRect().top - a.top;
    if (moved) main.current.scrollTop += moved;
  }, [pinnedKey]);

  return (
    <div className="screen">
      <Tabs active="inventory" />
      <nav className="chips scroll-x" aria-label={t("list")}>
        <a href="#/inventory" className="chip" aria-current={!listId ? "page" : undefined}>
          {t("inventory_all")}
        </a>
        {lists.map((l) => (
          <a
            key={l.id}
            href={`#/inventory/${l.id}`}
            className="chip"
            aria-current={listId === l.id ? "page" : undefined}
          >
            {l.name}
          </a>
        ))}
      </nav>
      <QueueStatus s={s} />
      <main
        className="scroll"
        ref={main}
        // The manual anchor below is the only correction: Chrome's own scroll anchoring could add a second one when
        // the Pinned section is above the viewport (re-review 2026-11-26).
        style={{ overflowAnchor: "none" }}
        onClickCapture={(e) => {
          const el = (e.target as Element).closest(".row");
          anchor.current = el
            ? {
                el,
                top: el.getBoundingClientRect().top - e.currentTarget.getBoundingClientRect().top,
                at: Date.now(),
                scroll: e.currentTarget.scrollTop,
              }
            : null;
        }}
      >
        {pinned.length > 0 ? (
          // Pinned: what to check first when reviewing what is needed. Shown again in their list below, so pinning
          // never moves a row away from under the finger (owner, 2026-11-26, APLANE-77).
          <section aria-label={t("inventory_pinned")}>
            <h2 className="group list-head">
              <span>{t("inventory_pinned")}</span>
            </h2>
            {pinned.map(({ data }) => row(data, true))}
          </section>
        ) : null}
        {showing.map((l) => {
          const items = byList.get(l.id) ?? [];
          return (
            <section key={l.id} aria-label={l.name}>
              <h2 className="group list-head">
                <span>{l.name}</span>
                <span className="sub">
                  <AudienceText s={s} projectId={l.project} />
                </span>
              </h2>
              {items.length === 0 ? <p className="empty small">{t("list_empty")}</p> : null}
              {items.map(({ data }) => row(data, false))}
            </section>
          );
        })}
      </main>
      <BottomBar />
      {recount ? <RecountDialog {...recount} onClose={() => setRecount(null)} /> : null}
      {arriving ? <ArrivalDialog {...arriving} onClose={() => setArriving(null)} /> : null}
    </div>
  );
}

export function RecountDialog({
  id,
  name,
  value,
  onClose,
}: {
  id: string;
  name: string;
  value: string;
  onClose: () => void;
}) {
  const { c, t } = useCtx();
  const [text, setText] = useState(value);
  const n = parseIntStrict(text);
  return (
    <Dialog title={t("recount_input", { item: name })} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (n === null || n < 0) return;
          void c.act("recount", id, { quantity: n }, { toast: t("toast_quantity", { item: name, n }) });
          onClose();
        }}
      >
        <NumberField label={t("at_home")} value={text} onChange={setText} min={0} />
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
