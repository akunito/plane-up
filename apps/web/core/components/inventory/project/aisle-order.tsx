/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The aisle-order editor: the viewer's own order of categories (per user, brief) and the bulk rename of a
// category, which reaches every item the viewer may edit in the workspace (S30).

import { useCallback, useEffect, useState } from "react";
import type { ClientOptions, Preferences } from "@plane/inventory";
import { fetchPreferences, fetchSuggestions, renameCategory, savePreferences } from "@plane/inventory";
import { Button } from "@plane/propel/button";
import { EModalWidth, ModalCore } from "@plane/ui";
import type { InventoryT } from "../i18n";
import { failureMessage } from "../online";
import { PromptDialog } from "./dialogs";

const norm = (s: string) => s.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** The person's order first, then the categories it does not mention, by name; one entry per category
 * whatever its case or spacing (S30: " lácteos " and "Lácteos" are one group). */
export function orderedCategories(order: readonly string[], categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const known = new Map<string, string>();
  for (const c of categories) if (c.trim() && !known.has(norm(c))) known.set(norm(c), c.trim());
  for (const c of order) {
    const k = norm(c);
    if (!k || seen.has(k) || !known.has(k)) continue;
    seen.add(k);
    out.push(known.get(k)!);
  }
  const rest = [...known.entries()].filter(([k]) => !seen.has(k)).map(([, c]) => c);
  rest.sort((a, b) => a.localeCompare(b));
  return [...out, ...rest];
}

export function AisleOrderDialog(props: {
  open: boolean;
  t: InventoryT;
  opts: ClientOptions;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { open, t, opts, onClose, onRenamed } = props;
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setOrder(null);
    const [p, s] = await Promise.all([fetchPreferences(opts), fetchSuggestions(opts, "")]);
    if (p.kind !== "ok" || s.kind !== "ok") {
      setMessage(failureMessage(p.kind !== "ok" ? p : s, t));
      setOrder([]);
      return;
    }
    setPrefs(p.body);
    setOrder(orderedCategories(p.body.category_order, s.body.categories));
  }, [opts, t]);

  useEffect(() => {
    if (open) {
      setMessage(null);
      void load();
    }
  }, [open, load]);

  const move = (index: number, by: -1 | 1) =>
    setOrder((o) => {
      if (!o) return o;
      const next = [...o];
      const [c] = next.splice(index, 1);
      next.splice(index + by, 0, c!);
      return next;
    });

  const save = async () => {
    if (!order || !prefs) return;
    setBusy(true);
    const out = await savePreferences(opts, { ...prefs, category_order: order });
    setBusy(false);
    if (out.kind === "ok") onClose();
    else setMessage(failureMessage(out, t));
  };

  return (
    <>
      <ModalCore isOpen={open && renaming === null} handleClose={onClose} width={EModalWidth.LG}>
        <div className="flex max-h-[80dvh] flex-col gap-3 overflow-y-auto p-5">
          <h3 className="text-16 font-medium text-primary">{t("aisle_order")}</h3>
          <p className="text-13 text-tertiary">{t("aisle_hint")}</p>
          {order === null ? (
            <p className="text-13 text-tertiary">{t("loading")}</p>
          ) : order.length === 0 ? (
            <p className="text-13 text-tertiary">{t("no_categories")}</p>
          ) : (
            <ol className="flex flex-col divide-y divide-subtle rounded-md border border-subtle">
              {order.map((c, i) => (
                <li key={norm(c)} className="flex items-center gap-2 px-3 py-1.5 text-13 text-primary">
                  <span className="w-6 text-tertiary">{i + 1}</span>
                  <span className="flex-1 truncate">{c}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("move_up", { name: c })}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("move_down", { name: c })}
                    disabled={i === order.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(c)}>
                    {t("rename_category")}
                  </Button>
                </li>
              ))}
            </ol>
          )}
          {message && (
            <p role="status" className="text-13 text-secondary">
              {message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="lg" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" size="lg" loading={busy} disabled={!order || !prefs} onClick={() => void save()}>
              {t("save")}
            </Button>
          </div>
        </div>
      </ModalCore>
      <PromptDialog
        open={renaming !== null}
        t={t}
        title={t("rename_category_title", { name: renaming ?? "" })}
        hint={t("rename_category_hint")}
        label={t("col_category")}
        initial={renaming ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={async (to) => {
          const out = await renameCategory(opts, renaming ?? "", to);
          setRenaming(null);
          setMessage(out.kind === "ok" ? t("renamed", { n: out.body.renamed }) : failureMessage(out, t));
          if (out.kind === "ok") onRenamed();
          await load();
        }}
      />
    </>
  );
}
