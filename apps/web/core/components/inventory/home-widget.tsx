/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The Home widget (plan, phase 5): the viewer's to-buy list with ticks, and capture (search, one action per
// mode, create into a list). Online only: each action goes to ops/ at once with a fresh queue id; when it
// fails the widget says so and keeps nothing (S42). Links to the app are plain anchors (S51).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import type { THomeWidgetProps } from "@plane/types";
import type { Lists, OpName } from "@plane/inventory";
import { createItem, fetchLists, fetchShoppingList, fetchSuggestions } from "@plane/inventory";
import { useTranslation } from "@plane/i18n";
import { StateControl } from "./controls";
import { makeInventoryT } from "./i18n";
import type { Item } from "./online";
import { clientOptions, failureMessage, sendNow } from "./online";
import { INVENTORY_CHANGED, notifyInventoryChanged, useInventoryVisible } from "./visibility";

/** Rows shown before "N more in the shopping app". */
const MAX_ROWS = 12;
const norm = (s: unknown) => (typeof s === "string" ? s.split(/\s+/).filter(Boolean).join(" ").toLowerCase() : "");

export const ShoppingListWidget = observer(function ShoppingListWidget({ workspaceSlug }: THomeWidgetProps) {
  const visible = useInventoryVisible();
  if (!visible) return null;
  return <Widget workspaceSlug={workspaceSlug} />;
});

function Widget({ workspaceSlug }: THomeWidgetProps) {
  const { currentLocale } = useTranslation();
  const t = useMemo(() => makeInventoryT(currentLocale), [currentLocale]);
  const opts = useMemo(() => clientOptions(workspaceSlug), [workspaceSlug]);
  const [rows, setRows] = useState<Item[] | null>(null);
  const [count, setCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Item[] | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [listId, setListId] = useState("");
  const searchSeq = useRef(0);

  const load = useCallback(async () => {
    const out = await fetchShoppingList(opts);
    if (out.kind !== "ok") {
      setMessage(failureMessage(out, t));
      setRows((r) => r ?? []);
      return;
    }
    setRows(out.list.items as Item[]);
    setCount(out.list.count);
  }, [opts, t]);

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(INVENTORY_CHANGED, reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener(INVENTORY_CHANGED, reload);
      window.removeEventListener("focus", reload);
    };
  }, [load]);

  const search = useCallback(
    async (q: string) => {
      const seq = ++searchSeq.current;
      if (!q.trim()) {
        setFound(null);
        return;
      }
      const [s, l] = await Promise.all([fetchSuggestions(opts, q.trim()), lists ? null : fetchLists(opts)]);
      // A slower answer for an older query must not replace a newer one.
      if (seq !== searchSeq.current) return;
      if (l?.kind === "ok") {
        setLists(l.body);
        setListId((id) => id || l.body.lists[0]?.id || "");
      }
      if (s.kind !== "ok") {
        setMessage(failureMessage(s, t));
        return;
      }
      setFound(s.body.items as Item[]);
    },
    [opts, t, lists]
  );

  useEffect(() => {
    const timer = setTimeout(() => void search(query), 200);
    return () => clearTimeout(timer);
  }, [query, search]);

  const act = async (item: Item, name: OpName, args: Record<string, unknown>, done: string) => {
    setMessage(null);
    const out = await sendNow(opts, name, item, args, t);
    setMessage(out.ok ? done : out.message);
    if (out.item) setFound((f) => f?.map((i) => (i.id === out.item!.id ? out.item! : i)) ?? f);
    // sendNow told the counter; the list reloads through the same event.
  };

  const create = async () => {
    const name = query.trim();
    const list = lists?.lists.find((l) => l.id === listId);
    if (!name || !list) return;
    setMessage(null);
    const out = await createItem(opts, list.project, list.id, { name });
    if (out.kind === "ok") {
      setQuery("");
      setFound(null);
      setMessage(t("widget_created", { name }));
      notifyInventoryChanged();
    } else if (out.kind === "conflict") setMessage(t("exists", { name }));
    else setMessage(failureMessage(out, t));
  };

  const sorted = useMemo(
    () =>
      // oxlint-disable-next-line unicorn/no-array-sort -- a copy; the web lib is es2022 (no toSorted)
      [...(rows ?? [])].sort(
        (a, b) => norm(a.category).localeCompare(norm(b.category)) || norm(a.name).localeCompare(norm(b.name))
      ),
    [rows]
  );
  const exact = found?.some((i) => norm(i.name) === norm(query));

  return (
    <section className="flex flex-col gap-3" data-testid="shopping-widget" aria-label={t("widget_title")}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-14 font-semibold text-primary">
          {t("widget_title")}
          {rows !== null && (
            <span className="font-normal ml-2 text-13 text-tertiary" data-testid="shopping-widget-count">
              {t("widget_count", { n: count })}
            </span>
          )}
        </h3>
        <a href="/shopping/" className="text-13 text-accent-primary hover:underline">
          {t("open_app")}
        </a>
      </div>

      <input
        className="w-full rounded-md border border-subtle bg-layer-1 px-3 py-1.5 text-13 text-primary outline-none focus:border-accent-strong"
        value={query}
        maxLength={255}
        placeholder={t("widget_search")}
        aria-label={t("widget_search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      {message && (
        <p role="status" className="text-13 text-secondary">
          {message}
        </p>
      )}

      {found !== null ? (
        <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle">
          {found.length === 0 && <li className="px-3 py-2 text-13 text-tertiary">{t("widget_no_match")}</li>}
          {found.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="truncate text-13 text-primary">
                {item.name}
                <span className="ml-2 text-11 text-tertiary">{(item.list as { name?: string } | undefined)?.name}</span>
              </span>
              <StateControl
                item={item}
                t={t}
                onOp={(name, args) => void act(item, name, args, t("widget_added", { name: item.name }))}
              />
            </li>
          ))}
          {query.trim() && !exact && lists && lists.lists.length > 0 && (
            <li className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button
                type="button"
                className="rounded-md border border-dashed border-subtle px-2 py-1 text-13 text-secondary hover:bg-layer-1"
                onClick={() => void create()}
              >
                {t("widget_create", {
                  name: query.trim(),
                  list: lists.lists.find((l) => l.id === listId)?.name ?? "",
                })}
              </button>
              <select
                className="rounded-md border border-subtle bg-layer-1 px-2 py-1 text-13 text-secondary"
                value={listId}
                aria-label={t("field_list")}
                onChange={(e) => setListId(e.target.value)}
              >
                {lists.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </li>
          )}
        </ul>
      ) : rows === null ? (
        <p className="text-13 text-tertiary">{t("loading")}</p>
      ) : sorted.length === 0 ? (
        <p className="text-13 text-tertiary">{t("widget_empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle">
          {sorted.slice(0, MAX_ROWS).map((item) => {
            const toBuy = typeof item.to_buy === "number" ? item.to_buy : 1;
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-1.5" data-testid="shopping-widget-row">
                {item.buy_online === true ? (
                  // Bought online: ordered from the app, not ticked (brief).
                  <a
                    href={`/shopping/#/item/${item.id}`}
                    className="text-13 text-accent-primary"
                    aria-label={item.name}
                  >
                    ↗
                  </a>
                ) : (
                  <input
                    type="checkbox"
                    aria-label={t("tick_label", { name: item.name })}
                    onChange={(e) => {
                      e.target.checked = false;
                      void act(
                        item,
                        "buy",
                        item.mode === "units" ? { quantity: toBuy } : {},
                        t("widget_bought", { name: item.name })
                      );
                    }}
                  />
                )}
                <span className="flex-1 truncate text-13 text-primary">
                  {item.name}
                  {item.mode === "units" && toBuy > 1 && <span className="ml-1 text-tertiary">×{toBuy}</span>}
                </span>
                <span className="text-11 text-tertiary">{typeof item.category === "string" ? item.category : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
      {found === null && sorted.length > MAX_ROWS && (
        <a href="/shopping/" className="text-13 text-tertiary hover:underline">
          {t("widget_more", { n: sorted.length - MAX_ROWS })}
        </a>
      )}
    </section>
  );
}
