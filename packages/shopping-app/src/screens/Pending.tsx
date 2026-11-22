// Waiting and unapplied changes: entries held by the two-hour rule (send or discard, one by one or all),
// results the server did not apply ("stale" with "apply anyway"), and a failing queue (brief: Surfaces).

import type { ReactNode } from "react";
import type { Entry, Notice } from "@plane/inventory";
import { heldEntries, isDiscardOnly, isHeld } from "@plane/inventory";
import type { AppState } from "../controller";
import type { Key, T } from "../i18n";
import { personName } from "../model";
import { Ago, Icon, Rich, useCtx } from "../ui";
import { updateApp } from "../update";

export function describeEntry(e: Entry, t: T): string {
  const a = e.op.args;
  switch (e.op.op) {
    case "adjust":
      return t("act_adjust", { delta: typeof a.delta === "number" && a.delta > 0 ? `+${a.delta}` : String(a.delta) });
    case "set_level":
      return t("act_set_level", { level: t(`level_${String(a.level)}` as Key) });
    case "set_needed":
      return t(a.needed ? "act_needed_on" : "act_needed_off");
    case "pin":
      return t(a.pinned ? "act_pin_on" : "act_pin_off");
    case "recount":
      return t("act_recount", { n: String(a.quantity) });
    default:
      return t(`act_${e.op.op}` as Key);
  }
}

export function Pending({ s }: { s: AppState }) {
  const { c, t, now } = useCtx();
  const held = heldEntries(s.queue, now());
  const failure = s.queue.failure;
  const name = (target: string) => s.known[target]?.data.name ?? s.queue.known[target]?.id ?? t("unknown_item");
  const line = (e: Entry) => (
    <Rich
      k="entry_line"
      vars={{ item: name(e.op.target), action: describeEntry(e, t), when: <Ago at={e.tappedAt} /> }}
    />
  );
  const held_ids = held.filter((e) => !isDiscardOnly(e, now())).map((e) => e.op.client_op_id);

  return (
    <div className="screen">
      <header className="topbar back">
        <a href="#/" className="icon-button" aria-label={t("back")}>
          {Icon.back()}
        </a>
        <h1 className="title">{t("pending_title")}</h1>
      </header>
      <main className="scroll">
        {/* Not while the head is held: the last failure is not why nothing goes (decision 3 audit). */}
        {failure && s.queue.entries.length > 0 && !(s.queue.entries[0] && isHeld(s.queue.entries[0], now())) ? (
          <section className="notice warn" aria-label={t("failure_title")}>
            <h2 className="group">{t("failure_title")}</h2>
            <p>{t(`failure_${failure.kind}`, { error: failure.error ?? String(failure.status ?? "") })}</p>
            <div className="actions">
              {failure.kind === "signed_out_app" || failure.kind === "signed_out_proxy" ? (
                // A full navigation: the proxy's sign-in cannot happen inside a fetch (M4).
                <a href="/" className="primary">
                  {t("sign_in")}
                </a>
              ) : null}
              {failure.kind === "outdated" ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    void updateApp({ container: navigator.serviceWorker, reload: () => window.location.reload() })
                  }
                >
                  {t("reload_app")}
                </button>
              ) : (
                <button type="button" className="secondary" onClick={() => void c.retry()}>
                  {t("retry_now")}
                </button>
              )}
              <button type="button" className="secondary" onClick={() => void c.discardHead()}>
                {t("discard_first")}
              </button>
            </div>
            {/* Also for "outdated": that refusal wrote nothing, but an attempt before the server's update may have
                applied with its answer lost (S25 re-review). */}
            <p className="muted small">{t("may_have_applied")}</p>
          </section>
        ) : null}

        {held.length > 0 ? (
          <section aria-label={t("held_title")}>
            <h2 className="group">{t("held_title")}</h2>
            <p className="muted small pad">{t("held_hint")}</p>
            {held.map((e) => (
              <div className="row tall" key={e.op.client_op_id} data-held={e.op.client_op_id}>
                <span className="grow">
                  {line(e)}
                  {isDiscardOnly(e, now()) ? <span className="sub block">{t("discard_only")}</span> : null}
                  {e.transmission !== "never" ? <span className="sub block">{t("held_maybe_sent")}</span> : null}
                </span>
                {!isDiscardOnly(e, now()) ? (
                  <button type="button" className="secondary" onClick={() => void c.approve([e.op.client_op_id])}>
                    {t("send")}
                  </button>
                ) : null}
                <button type="button" className="secondary" onClick={() => void c.discard(e.op.client_op_id)}>
                  {t("discard")}
                </button>
              </div>
            ))}
            {held.length > 1 ? (
              <div className="actions pad">
                {held_ids.length > 0 ? (
                  <button type="button" className="primary" onClick={() => void c.approve(held_ids)}>
                    {t("send_all")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void c.discardMany(held.map((e) => e.op.client_op_id))}
                >
                  {t("discard_all")}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {s.queue.notices.length > 0 ? (
          <section aria-label={t("notices_title")}>
            <h2 className="group">{t("notices_title")}</h2>
            {s.queue.notices.map((n) => (
              <NoticeRow key={`${n.kind}:${n.clientOpId}`} notice={n} s={s} />
            ))}
          </section>
        ) : null}

        {s.queue.entries.length > 0 ? (
          <section aria-label={t("waiting", { n: s.queue.entries.length })}>
            <h2 className="group">{t("waiting", { n: s.queue.entries.length })}</h2>
            <ul className="history">
              {s.queue.entries.map((e) => (
                <li key={e.op.client_op_id}>{line(e)}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {held.length === 0 && s.queue.notices.length === 0 && s.queue.entries.length === 0 ? (
          <p className="empty">{t("nothing_pending")}</p>
        ) : null}
      </main>
    </div>
  );
}

function NoticeRow({ notice, s }: { notice: Notice; s: AppState }) {
  const { c, t } = useCtx();
  const item = s.known[notice.entry.op.target]?.data.name ?? t("unknown_item");
  let text: ReactNode;
  if (notice.kind === "stale") {
    const who = notice.changed?.by_name ?? personName(s.lists, notice.changed?.by) ?? t("someone");
    const when = notice.changed?.at ? <Ago at={notice.changed.at} /> : "";
    text = <Rich k="notice_stale" vars={{ item, who, when }} />;
  } else if (notice.kind === "rejected") {
    const known = [
      "changed_since",
      "not_yours",
      "not_revertible",
      "already_done",
      "gone",
      "invalid_for_mode",
      "invalid",
    ];
    const reason =
      notice.reason && known.includes(notice.reason)
        ? t(`reason_${notice.reason}` as Key)
        : t("reason_other", { reason: notice.reason ?? "" });
    text = t("notice_rejected", { item, reason });
  } else text = t("notice_discarded", { item });
  return (
    <div className="row tall" data-notice={notice.kind}>
      <span className="grow">
        {text}
        {notice.mayHaveApplied ? <span className="sub block">{t("may_have_applied")}</span> : null}
        <span className="sub block">{describeEntry(notice.entry, t)}</span>
      </span>
      {notice.kind === "stale" ? (
        <button type="button" className="secondary" onClick={() => void c.applyAnyway(notice)}>
          {t("apply_anyway")}
        </button>
      ) : null}
      <button type="button" className="secondary" onClick={() => void c.dismiss(notice)}>
        {t("dismiss")}
      </button>
    </div>
  );
}
