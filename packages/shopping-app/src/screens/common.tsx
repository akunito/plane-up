// Pieces several screens share: the header tabs, the queue's status line, the bottom bar, the order and
// arrival dialogs.

import { useState } from "react";
import { newUuid, waiting, heldEntries } from "@plane/inventory";
import type { AppState } from "../controller";
import type { Order, Row } from "../model";
import { audience, projectOf } from "../model";
import { listNames } from "../i18n";
import { Ago, Dialog, Icon, NumberField, Rich, parseIntStrict, useCtx } from "../ui";

export function Tabs({ active, summary }: { active: "shopping" | "inventory"; summary?: string }) {
  const { t } = useCtx();
  return (
    <header className="topbar">
      <nav className="tabs" aria-label={t("tab_shopping") + " / " + t("tab_inventory")}>
        <a href="#/" className="tab" aria-current={active === "shopping" ? "page" : undefined}>
          {t("tab_shopping")}
        </a>
        <a href="#/inventory" className="tab" aria-current={active === "inventory" ? "page" : undefined}>
          {t("tab_inventory")}
        </a>
      </nav>
      <span className="spacer" />
      {summary ? <span className="muted small">{summary}</span> : null}
      {active === "inventory" ? (
        <a href="#/capture" className="icon-button" aria-label={t("new_item")}>
          {Icon.plus(20)}
        </a>
      ) : null}
    </header>
  );
}

/** How many changes wait, at all times, and why sending fails when it does (plan, phase 6 / M10). */
export function QueueStatus({ s }: { s: AppState }) {
  const { t, now } = useCtx();
  const n = waiting(s.queue);
  const held = heldEntries(s.queue, now()).length;
  const failure = s.queue.failure;
  const notices = s.queue.notices.length;
  if (n === 0 && notices === 0 && !failure && !s.connection) return null;
  let text: string | null = null;
  if (failure && n > 0) text = t(`failure_${failure.kind}`, { error: failure.error ?? String(failure.status ?? "") });
  else if (s.connection) text = t("refresh_failed");
  return (
    <div className={`status${failure || s.connection ? " warn" : ""}`} role="status">
      <span className="grow">
        {text ? <span className="block">{text}</span> : null}
        {n > 0 ? <span className="block">{t("waiting", { n })}</span> : null}
      </span>
      {n > 0 || notices > 0 || held > 0 ? (
        <a href="#/pending" className="chip">
          {t("review")}
          {notices > 0 ? ` · ${notices}` : ""}
        </a>
      ) : null}
    </div>
  );
}

export function BottomBar() {
  const { t } = useCtx();
  return (
    <footer className="bottombar">
      <a href="#/capture" className="search-link">
        {Icon.search()}
        {t("capture_or_search")}
      </a>
      <a href="#/shop" className="primary">
        {Icon.cart()}
        {t("shopping_mode")}
      </a>
    </footer>
  );
}

/** "with Aga", "only you", "public project…": who can see the list (brief: Privacy). */
export function AudienceText({ s, projectId }: { s: AppState; projectId: string }) {
  const { t, locale } = useCtx();
  const project = projectOf(s.lists, projectId);
  if (!project || !s.lists) return null;
  const a = audience(project, s.lists.me.id);
  const parts = [t("list_project", { project: project.name })];
  if (a.kind === "only_you") parts.push(t("aud_only_you"));
  else if (a.names.length > 0) parts.push(t("aud_people", { names: listNames(locale, a.names) }));
  if (a.kind === "public") parts.push(t("aud_public"));
  if (a.kind === "admins") parts.push(t("aud_admins", { n: a.admins }));
  return <>{parts.join(" · ")}</>;
}

export function OrderDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const { c, t } = useCtx();
  const item = row.data.name;
  const [quantity, setQuantity] = useState(String(Math.max(row.quantity, 1)));
  const [reference, setReference] = useState("");
  const [expected, setExpected] = useState("");
  const qty = parseIntStrict(quantity);
  const valid = qty !== null && qty >= 1;
  return (
    <Dialog title={t("order_title", { item })} onClose={onClose}>
      {row.orders.length > 0 ? (
        <p className="notice warn" role="alert">
          {t("open_order_warning", { item })}
        </p>
      ) : null}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const args: Record<string, unknown> = { order_id: newUuid(), quantity: qty };
          if (reference.trim()) args.reference = reference.trim();
          if (expected) args.expected_on = expected;
          void c.act("mark_ordered", row.id, args, { toast: t("toast_ordered", { item }) });
          onClose();
        }}
      >
        <NumberField label={t("quantity")} value={quantity} onChange={setQuantity} min={1} />
        <label className="field">
          <span>{t("reference")}</span>
          <input type="text" maxLength={255} value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("expected_on")}</span>
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {t("mark_ordered")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Which order arrived (asked only when there are several) and how much of it. */
export function ArrivalDialog({
  itemId,
  name,
  orders,
  onClose,
}: {
  itemId: string;
  name: string;
  orders: Order[];
  onClose: () => void;
}) {
  const { c, t } = useCtx();
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const order = orders.find((o) => o.id === orderId) ?? orders[0];
  const [quantity, setQuantity] = useState(String(order?.quantity ?? 1));
  if (!order) return null;
  const qty = parseIntStrict(quantity);
  const valid = qty !== null && qty >= 1;
  return (
    <Dialog title={t("arrival_title", { item: name })} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void c.act(
            "arrived",
            itemId,
            { order_id: order.id, quantity: qty },
            { orderQuantity: order.quantity, toast: t("toast_arrived", { item: name }) }
          );
          onClose();
        }}
      >
        {orders.length > 1 ? (
          <fieldset className="field">
            <legend>{t("which_order")}</legend>
            {orders.map((o) => (
              <label key={o.id} className="radio">
                <input
                  type="radio"
                  name="order"
                  checked={o.id === order.id}
                  onChange={() => {
                    setOrderId(o.id);
                    setQuantity(String(o.quantity));
                  }}
                />
                <Rich k="order_option" vars={{ n: o.quantity, when: <Ago at={o.ordered_at} /> }} />
                {o.reference ? ` · ${o.reference}` : ""}
              </label>
            ))}
          </fieldset>
        ) : null}
        <NumberField label={t("received_quantity")} value={quantity} onChange={setQuantity} min={1} />
        <p className="muted small">{t("partial_hint")}</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            aria-label={t("cancel_order_label", { item: name })}
            onClick={() => {
              void c.act("cancel", itemId, { order_id: order.id }, { toast: t("toast_cancelled", { item: name }) });
              onClose();
            }}
          >
            {t("cancel_order")}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {t("arrived")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
