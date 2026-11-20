// Operations from the main app's surfaces (project page, Home widget): online only, no queue (plan, phase 5).
// Each request gets a fresh queue_id, so the server's same-queue exemption never covers it: a statement
// (set_needed, set_level, pin, change_mode, recount: compared on base_rev) made from a view that is not
// refreshed is refused as `stale` (S67). Purchases and ± (buy, adjust) are things that happened and are
// always applied, by design (brief, behaviour 1): a tick from an old view still counts. Nothing is kept
// when a request fails.

import type { ClientOptions, ItemState, OpName, OpResult } from "@plane/inventory";
import { buildOp, newUuid, sendOps } from "@plane/inventory";
import type { InventoryT } from "./i18n";
import { notifyInventoryChanged } from "./visibility";

export type Item = ItemState & Record<string, unknown> & { name: string };

export type Outcome =
  | { ok: true; item: Item | null; result: OpResult }
  | { ok: false; message: string; item: Item | null };

export const clientOptions = (slug: string): ClientOptions => ({ base: "", slug });

/** One operation, sent now. `item` is the state the person saw; its revision is the CAS base. */
export async function sendNow(
  opts: ClientOptions,
  name: OpName,
  item: ItemState,
  args: Record<string, unknown>,
  t: InventoryT
): Promise<Outcome> {
  const entry = buildOp(name, item, args, { now: Date.now(), queueId: newUuid(), newId: newUuid });
  const delivery = await sendOps(opts, [{ ...entry.op, age_ms: 0 }]);
  if (delivery.kind === "failed") {
    const key =
      delivery.failure === "offline"
        ? "err_offline"
        : delivery.failure === "signed_out_app" || delivery.failure === "signed_out_proxy"
          ? "err_signed_out"
          : "err_server";
    return { ok: false, message: t(key), item: null };
  }
  if (delivery.kind === "refused")
    return { ok: false, message: t("err_refused", { error: delivery.error }), item: null };
  const result = delivery.results.find((r) => r.client_op_id === entry.op.client_op_id);
  if (!result) return { ok: false, message: t("err_server"), item: null };
  const fresh = (result.item as Item | undefined) ?? null;
  // Applied, or refused with the current state: either way the counter and the widget may be out of date.
  notifyInventoryChanged();
  if (result.result === "applied") return { ok: true, item: fresh, result };
  if (result.result === "stale")
    return {
      ok: false,
      message: t("err_stale", { who: result.changed?.by_name ?? t("someone") }),
      item: fresh,
    };
  return { ok: false, message: t("err_rejected", { reason: result.reason ?? "?" }), item: fresh };
}

/** A refused or failed request as a sentence; `null` when it succeeded. */
export function failureMessage(out: { kind: string; failure?: string; error?: string }, t: InventoryT): string | null {
  if (out.kind === "ok") return null;
  if (out.kind === "refused" || out.kind === "conflict") return t("err_refused", { error: out.error ?? "?" });
  if (out.failure === "offline") return t("err_offline");
  if (out.failure === "signed_out_app" || out.failure === "signed_out_proxy") return t("err_signed_out");
  return t("err_server");
}
