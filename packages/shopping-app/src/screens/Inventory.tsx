// Inventory by list: every item, with its one-tap control, typing a recount, the "recount" mark, and
// orders on the way (mockup Inventario). Lists load when shown and reload with every refresh.

import { useEffect, useMemo, useState } from "react";
import { view } from "@plane/inventory";
import type { AppState } from "../controller";
import type { Order } from "../model";
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
      <main className="scroll">
        {showing.map((l) => {
          const items = Object.values(s.known)
            .filter((k) => k.data.list.id === l.id && shown[k.data.id])
            .toSorted((a, b) => a.data.sort_order - b.data.sort_order || a.data.name.localeCompare(b.data.name));
          return (
            <section key={l.id} aria-label={l.name}>
              <h2 className="group list-head">
                <span>{l.name}</span>
                <span className="sub">
                  <AudienceText s={s} projectId={l.project} />
                </span>
              </h2>
              {items.length === 0 ? <p className="empty small">{t("list_empty")}</p> : null}
              {items.map(({ data }) => {
                const state = shown[data.id]!;
                const mine = orders.filter((o) => o.item === data.id);
                const kind = badge(state);
                return (
                  <div className="row tall" key={data.id} data-item={data.id}>
                    <div className="grow">
                      <a
                        href={`#/item/${data.id}`}
                        className="name block"
                        aria-label={t("open_item", { item: data.name })}
                      >
                        {data.name}
                      </a>
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
                          {Icon.truck()}{" "}
                          <Rich k="ordered_line" vars={{ n: o.quantity, when: <Ago at={o.ordered_at} /> }} />
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
              })}
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
