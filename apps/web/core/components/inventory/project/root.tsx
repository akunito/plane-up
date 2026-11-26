/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Project › Inventory (plan, phase 5): the desktop table with inline editing, list create/rename/delete,
// the item sheet, the aisle-order editor and the bulk rename of a category. Online only: state changes go
// to ops/ one at a time with a fresh queue id (online.ts); data changes go to the item endpoint.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Lists, ProjectList } from "@plane/inventory";
import {
  audience,
  createItem,
  createList,
  deleteItem,
  deleteList,
  fetchListItems,
  fetchLists,
  fetchProjectLists,
  fetchSuggestions,
  updateItem,
  updateList,
} from "@plane/inventory";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import type { InventoryT } from "../i18n";
import type { Item } from "../online";
import { clientOptions, failureMessage, sendNow } from "../online";
import { AisleOrderDialog } from "./aisle-order";
import { FIELD, ListDialog, MODES, PromptDialog, modeKey } from "./dialogs";
import { ItemSheet } from "./item-sheet";
import { EditableField, StateControl, num, str } from "../controls";
import { notifyInventoryChanged } from "../visibility";

type Dialog =
  | { kind: "create_list" }
  | { kind: "rename_list"; list: ProjectList }
  | { kind: "delete_list"; list: ProjectList }
  | { kind: "delete_item"; item: Item }
  | { kind: "units"; item: Item }
  | { kind: "sheet"; itemId: string }
  | { kind: "aisles" }
  | null;

const CELL = "border-b border-subtle px-2 py-1.5 align-middle";
const INLINE =
  "w-full rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-13 text-primary outline-none hover:border-subtle focus:border-accent-strong focus:bg-layer-1";

function audienceText(lists: Lists | null, projectId: string, t: InventoryT): string | null {
  const project = lists?.projects.find((p) => p.id === projectId);
  if (!lists || !project) return null;
  const a = audience(project, lists.me.id);
  if (a.kind === "only_you") return t("aud_only_you");
  if (a.kind === "public") return t("aud_public");
  if (a.kind === "people") return t("aud_people", { names: a.names.join(", ") });
  return t("aud_admins", { who: [t("aud_you"), ...a.names].join(", "), n: a.admins });
}

export function ProjectInventoryRoot(props: { workspaceSlug: string; projectId: string; t: InventoryT }) {
  const { workspaceSlug, projectId, t } = props;
  const opts = useMemo(() => clientOptions(workspaceSlug), [workspaceSlug]);
  const [lists, setLists] = useState<ProjectList[] | null>(null);
  const [visible, setVisible] = useState<Lists | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [categories, setCategories] = useState<{ categories: string[]; stores: string[] }>({
    categories: [],
    stores: [],
  });
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newName, setNewName] = useState("");
  const loadSeq = useRef(0);
  // A pin (the Tracking select) adds or removes a row in the Pinned group ABOVE the list, moving every row below:
  // the row just changed is put back where it was on the screen (the scroller has overflow-anchor: none, so this is the
  // only correction), as far as the scroll allows (at the top a row
  // removed above still pulls it up) (audit 2026-11-26). Only within two seconds, and only if it has not scrolled since.
  const anchor = useRef<{ el: Element; top: number; at: number; box: Element | null; scroll: number } | null>(null);
  const pinnedKey =
    items
      ?.filter((i) => i.mode === "pinned")
      .map((i) => i.id)
      .join(",") ?? "";
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a || !a.el.isConnected || Date.now() - a.at > 2000) return;
    const box = a.box ?? document.scrollingElement;
    // A scroll since the change is the person's own: leave it (compared, not listened for).
    if (!box || box.scrollTop !== a.scroll) return;
    const moved = a.el.getBoundingClientRect().top - a.top;
    if (moved) box.scrollBy(0, moved);
  }, [pinnedKey]);
  const markRow = (e: { target: EventTarget }) => {
    const el = (e.target as Element).closest("tr");
    if (!el) {
      anchor.current = null;
      return;
    }
    let box: Element | null = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
      box = box.parentElement;
    const scroller = box ?? document.scrollingElement;
    anchor.current = { el, top: el.getBoundingClientRect().top, at: Date.now(), box, scroll: scroller?.scrollTop ?? 0 };
  };
  const listsSeq = useRef(0);

  const loadLists = useCallback(async () => {
    const seq = ++listsSeq.current;
    setLoadError(null);
    const [own, all, sugg] = await Promise.all([
      fetchProjectLists(opts, projectId),
      fetchLists(opts),
      fetchSuggestions(opts, ""),
    ]);
    // An older load answering last must not replace a newer one (phase 5 audit).
    if (seq !== listsSeq.current) return;
    if (own.kind !== "ok") {
      setLoadError(own.kind === "refused" && own.status === 403 ? t("no_access") : failureMessage(own, t));
      return;
    }
    setLists(own.body);
    if (all.kind === "ok") setVisible(all.body);
    if (sugg.kind === "ok") setCategories({ categories: sugg.body.categories, stores: sugg.body.stores });
    setSelected((s) => (s && own.body.some((l) => l.id === s) ? s : (own.body[0]?.id ?? null)));
  }, [opts, projectId, t]);

  /** `quiet`: keep the rows on screen while reloading (after a change), instead of showing "Loading". */
  const loadItems = useCallback(
    async (listId: string, quiet = false) => {
      const seq = ++loadSeq.current;
      if (!quiet) setItems(null);
      const out = await fetchListItems(opts, projectId, listId);
      // A slower answer for a list no longer shown must not replace the shown one.
      if (seq !== loadSeq.current) return;
      if (out.kind !== "ok") {
        setMessage(failureMessage(out, t));
        setItems([]);
        return;
      }
      // Alphabetical when the list is opened; a quiet reload (after every edit) keeps the order on screen and adds
      // new rows at the end, so a rename never moves the row and its focus under the cursor (audit 2026-11-26).
      // es2022 lib: no toSorted.
      const fresh = out.items as Item[];
      if (!quiet) {
        // oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array it owns
        setItems(fresh.sort((a, b) => a.name.localeCompare(b.name)));
        return;
      }
      setItems((rows) => {
        const at = new Map((rows ?? []).map((r, i) => [r.id, i]));
        // oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array it owns
        return fresh.sort(
          (a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || a.name.localeCompare(b.name)
        );
      });
    },
    [opts, projectId, t]
  );

  useEffect(() => {
    void loadLists();
  }, [loadLists]);
  useEffect(() => {
    if (selected) void loadItems(selected);
    else setItems([]);
  }, [selected, loadItems]);

  const current = lists?.find((l) => l.id === selected) ?? null;
  const project = visible?.projects.find((p) => p.id === projectId);
  // The first list of a public project with one member: anyone in the workspace could join and see it (S21).
  const warnPublic = !!project && project.network !== 0 && project.members.length <= 1 && (lists?.length ?? 0) === 0;

  /**
   * Puts an answer into its row. An operation answers with the item's STATE only (engine item_state: no
   * name, list, category, to_buy…), so it is merged, never swapped in (phase 5 re-review: a swap blanked
   * the row). A state older than the row's is dropped. The quiet reload that follows every change is the
   * authority for the derived fields and for data answers arriving out of order (same revision).
   */
  const replace = (item: Partial<Item> & { id: string; rev: number }) => {
    setItems((rows) => {
      if (!rows) return rows;
      // Moved to another list: it leaves this table.
      const listId = (item.list as { id: string } | undefined)?.id;
      if (listId && listId !== selected) return rows.filter((r) => r.id !== item.id);
      return rows.map((r) => (r.id === item.id && item.rev >= r.rev ? ({ ...r, ...item } as Item) : r));
    });
  };

  const refreshQuietly = () => {
    if (selected) void loadItems(selected, true);
  };

  /** Resolves to the item as the server now holds it (also after a stale refusal), or null. */
  const op = async (
    item: Item,
    name: Parameters<typeof sendNow>[1],
    args: Record<string, unknown>
  ): Promise<Item | null> => {
    setMessage(null);
    const out = await sendNow(opts, name, item, args, t);
    if (out.item) replace(out.item);
    if (!out.ok) setMessage(out.message);
    refreshQuietly();
    return out.item ? ({ ...item, ...out.item } as Item) : null;
  };

  /** Resolves to the saved item, or null when nothing was saved (the field then shows the saved value). */
  const saveData = async (item: Item, data: Record<string, unknown>): Promise<Item | null> => {
    setMessage(null);
    const out = await updateItem(opts, projectId, item.id, data);
    if (out.kind !== "ok") {
      setMessage(
        out.kind === "conflict" ? t("exists", { name: String(data.name ?? item.name) }) : failureMessage(out, t)
      );
      return null;
    }
    replace(out.body as Item);
    notifyInventoryChanged();
    refreshQuietly();
    return out.body as Item;
  };

  const add = async () => {
    const name = newName.trim();
    if (!name || !current) return;
    setMessage(null);
    const out = await createItem(opts, projectId, current.id, { name });
    if (out.kind === "ok") {
      setNewName("");
      setItems((rows) => [...(rows ?? []), out.body as Item]);
      notifyInventoryChanged();
    } else if (out.kind === "conflict") setMessage(t("exists", { name }));
    else setMessage(failureMessage(out, t));
  };

  if (loadError)
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-13 text-secondary">
        <p role="alert">{loadError}</p>
        <Button variant="secondary" size="lg" onClick={() => void loadLists()}>
          {t("try_again")}
        </Button>
      </div>
    );
  if (!lists) return <p className="p-6 text-13 text-tertiary">{t("loading")}</p>;

  const sheetItem = dialog?.kind === "sheet" ? (items?.find((i) => i.id === dialog.itemId) ?? null) : null;
  const who = audienceText(visible, projectId, t);

  return (
    <div
      className="flex h-full w-full flex-col gap-3 overflow-auto p-4 [overflow-anchor:none]"
      data-testid="project-inventory"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex flex-wrap gap-1">
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={l.id === selected}
              className={`rounded-md px-3 py-1 text-13 ${
                l.id === selected ? "bg-layer-3 text-primary" : "text-secondary hover:bg-layer-1"
              }`}
              onClick={() => setSelected(l.id)}
            >
              {l.name}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="lg" onClick={() => setDialog({ kind: "create_list" })}>
          {t("new_list")}
        </Button>
        {current && (
          <>
            <Button variant="ghost" size="lg" onClick={() => setDialog({ kind: "rename_list", list: current })}>
              {t("rename_list")}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setDialog({ kind: "delete_list", list: current })}>
              {t("delete_list")}
            </Button>
          </>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="lg" onClick={() => setDialog({ kind: "aisles" })}>
          {t("aisle_order")}
        </Button>
      </div>
      {who && <p className="text-13 text-tertiary">{who}</p>}
      {message && (
        <p role="alert" className="flex items-center justify-between rounded-md bg-layer-1 px-3 py-2 text-13">
          <span className="text-secondary">{message}</span>
          <button type="button" className="text-tertiary" aria-label={t("close")} onClick={() => setMessage(null)}>
            ×
          </button>
        </p>
      )}

      {lists.length === 0 ? (
        <p className="p-6 text-13 text-tertiary">{t("no_lists")}</p>
      ) : (
        <>
          <datalist id="inventory-categories">
            {categories.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <datalist id="inventory-stores">
            {categories.stores.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <table
            className="w-full min-w-[960px] border-collapse text-left text-13"
            onClickCapture={markRow}
            onChangeCapture={markRow}
          >
            <thead className="text-11 text-tertiary uppercase">
              <tr>
                <th className={`${CELL} w-[22%]`}>{t("col_item")}</th>
                <th className={CELL}>{t("col_tracking")}</th>
                <th className={`${CELL} w-[20%]`}>{t("col_state")}</th>
                <th className={CELL}>{t("col_min")}</th>
                <th className={CELL}>{t("col_restock")}</th>
                <th className={CELL}>{t("col_category")}</th>
                <th className={CELL}>{t("col_store")}</th>
                <th className={CELL}>{t("col_online")}</th>
                <th className={CELL} />
              </tr>
            </thead>
            {items === null || items.length === 0 ? (
              <tbody>
                <tr>
                  <td className={CELL} colSpan={9}>
                    <span className="text-tertiary">{t(items === null ? "loading" : "list_empty")}</span>
                  </td>
                </tr>
              </tbody>
            ) : (
              (() => {
                const row = (item: Item, key: string) => (
                  <ItemRow
                    key={key}
                    item={item}
                    t={t}
                    onOp={(name, args) => op(item, name, args)}
                    onData={(data) => saveData(item, data)}
                    onUnits={() => setDialog({ kind: "units", item })}
                    onDetails={() => setDialog({ kind: "sheet", itemId: item.id })}
                    onDelete={() => setDialog({ kind: "delete_item", item })}
                  />
                );
                // Pinned rows gathered at the top AND kept in the alphabetical list below (owner, 2026-11-26,
                // APLANE-77); the order is the load's (see the fetch), so neither a pin nor a rename reorders rows.
                // Two row groups, each with its own header (a rowgroup header covers only its <tbody>).
                const pinned = items.filter((i) => i.mode === "pinned");
                const head = (label: string) => (
                  <tr>
                    <th scope="rowgroup" colSpan={9} className={`${CELL} text-11 text-tertiary uppercase`}>
                      {label}
                    </th>
                  </tr>
                );
                return (
                  <>
                    {pinned.length > 0 && (
                      <tbody data-testid="inventory-pinned">
                        {head(t("section_pinned"))}
                        {pinned.map((item) => row(item, `pinned-${item.id}`))}
                      </tbody>
                    )}
                    <tbody>
                      {pinned.length > 0 && head(t("section_all"))}
                      {items.map((item) => row(item, item.id))}
                    </tbody>
                  </>
                );
              })()
            )}
          </table>
          {current && (
            <form
              className="flex max-w-xl gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <input
                className={FIELD}
                value={newName}
                maxLength={255}
                placeholder={t("add_placeholder", { list: current.name })}
                aria-label={t("add_placeholder", { list: current.name })}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button variant="primary" size="xl" type="submit" disabled={!newName.trim()}>
                {t("add")}
              </Button>
            </form>
          )}
        </>
      )}

      <ListDialog
        open={dialog?.kind === "create_list" || dialog?.kind === "rename_list"}
        t={t}
        title={dialog?.kind === "rename_list" ? t("rename_list") : t("new_list")}
        initial={
          dialog?.kind === "rename_list"
            ? { name: dialog.list.name, default_mode: dialog.list.default_mode }
            : { name: "", default_mode: "on_demand" }
        }
        warnPublic={dialog?.kind === "create_list" && warnPublic}
        onClose={() => setDialog(null)}
        onSubmit={async (data) => {
          const out =
            dialog?.kind === "rename_list"
              ? await updateList(opts, projectId, dialog.list.id, data)
              : await createList(opts, projectId, data);
          if (out.kind !== "ok") return failureMessage(out, t);
          setDialog(null);
          await loadLists();
          setSelected(out.body.id);
          return null;
        }}
      />
      <AlertModalCore
        isOpen={dialog?.kind === "delete_list" || dialog?.kind === "delete_item"}
        variant="danger"
        isSubmitting={false}
        title={
          dialog?.kind === "delete_list"
            ? t("delete_list_title", { name: dialog.list.name })
            : dialog?.kind === "delete_item"
              ? t("delete_item_title", { name: dialog.item.name })
              : ""
        }
        content={
          dialog?.kind === "delete_list" ? t("delete_list_body", { n: items?.length ?? 0 }) : t("delete_item_body")
        }
        primaryButtonText={{ loading: t("delete"), default: t("delete") }}
        secondaryButtonText={t("cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => {
          const d = dialog;
          setDialog(null);
          if (d?.kind === "delete_list")
            void deleteList(opts, projectId, d.list.id).then(async (out) => {
              if (out.kind !== "ok") setMessage(failureMessage(out, t));
              else notifyInventoryChanged();
              await loadLists();
              return undefined;
            });
          else if (d?.kind === "delete_item")
            void deleteItem(opts, projectId, d.item.id).then((out) => {
              if (out.kind === "ok") {
                setItems((rows) => rows?.filter((r) => r.id !== d.item.id) ?? rows);
                notifyInventoryChanged();
              } else setMessage(failureMessage(out, t));
              return undefined;
            });
        }}
      />
      <PromptDialog
        open={dialog?.kind === "units"}
        t={t}
        title={dialog?.kind === "units" ? `${dialog.item.name}: ${t("mode_units")}` : ""}
        label={t("units_quantity")}
        initial=""
        numeric
        onClose={() => setDialog(null)}
        onSubmit={async (value) => {
          if (dialog?.kind !== "units") return;
          const item = dialog.item;
          setDialog(null);
          await op(item, "change_mode", { mode: "units", quantity: Number(value) });
        }}
      />
      <ItemSheet
        key={sheetItem?.id ?? "none"}
        open={dialog?.kind === "sheet" && !!sheetItem}
        t={t}
        opts={opts}
        projectId={projectId}
        item={sheetItem}
        lists={lists}
        onClose={() => setDialog(null)}
        onSaved={(saved) => {
          replace(saved);
          refreshQuietly();
        }}
      />
      <AisleOrderDialog
        open={dialog?.kind === "aisles"}
        t={t}
        opts={opts}
        onClose={() => setDialog(null)}
        onRenamed={() => {
          if (selected) void loadItems(selected);
          void loadLists();
        }}
      />
    </div>
  );
}

function ItemRow(props: {
  item: Item;
  t: InventoryT;
  onOp: (name: Parameters<typeof sendNow>[1], args: Record<string, unknown>) => Promise<Item | null>;
  onData: (data: Record<string, unknown>) => Promise<Item | null>;
  onUnits: () => void;
  onDetails: () => void;
  onDelete: () => void;
}) {
  const { item, t, onOp, onData, onUnits, onDetails, onDelete } = props;
  const text = (field: string) => async (draft: string) => {
    const v = draft.trim();
    if (field === "name" && !v) return null;
    const saved = await onData({ [field]: v });
    return saved ? str(saved[field]) : null;
  };
  const number = (field: "min_quantity" | "restock_to") => async (draft: string) => {
    const raw = draft.trim();
    if (raw !== "" && !/^\d{1,6}$/.test(raw)) return null;
    const saved = await onData({ [field]: raw === "" ? null : Number(raw) });
    return saved ? num(saved[field]) : null;
  };
  const onOrder = typeof item.on_order === "number" ? item.on_order : 0;
  const toBuy = typeof item.to_buy === "number" ? item.to_buy : 0;

  return (
    <tr data-testid="inventory-row" data-item={item.name}>
      <td className={CELL}>
        <EditableField className={INLINE} value={item.name} aria-label={t("field_name")} onCommit={text("name")} />
      </td>
      <td className={CELL}>
        <select
          className={INLINE}
          value={item.mode}
          aria-label={`${item.name}: ${t("col_tracking")}`}
          onChange={(e) => {
            if (e.target.value === "units") onUnits();
            else void onOp("change_mode", { mode: e.target.value });
          }}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(modeKey(m))}
            </option>
          ))}
        </select>
      </td>
      <td className={CELL}>
        <div className="flex flex-wrap items-center gap-1">
          <StateControl item={item} t={t} onOp={onOp} recount />
          {onOrder > 0 && <span className="text-11 text-accent-primary">{t("on_order", { n: onOrder })}</span>}
          {toBuy > 0 && <span className="text-11 text-tertiary">{t("to_buy", { n: toBuy })}</span>}
        </div>
      </td>
      <td className={CELL}>
        {item.mode === "units" ? (
          <EditableField
            className={`${INLINE} w-16`}
            inputMode="numeric"
            value={num(item.min_quantity)}
            aria-label={`${item.name}: ${t("col_min")}`}
            onCommit={number("min_quantity")}
          />
        ) : null}
      </td>
      <td className={CELL}>
        {item.mode === "units" ? (
          <EditableField
            className={`${INLINE} w-16`}
            inputMode="numeric"
            value={num(item.restock_to)}
            aria-label={`${item.name}: ${t("col_restock")}`}
            onCommit={number("restock_to")}
          />
        ) : null}
      </td>
      <td className={CELL}>
        <EditableField
          className={INLINE}
          list="inventory-categories"
          value={str(item.category)}
          aria-label={`${item.name}: ${t("col_category")}`}
          onCommit={text("category")}
        />
      </td>
      <td className={CELL}>
        <EditableField
          className={INLINE}
          list="inventory-stores"
          value={str(item.store)}
          aria-label={`${item.name}: ${t("col_store")}`}
          onCommit={text("store")}
        />
      </td>
      <td className={CELL}>
        <input
          type="checkbox"
          checked={item.buy_online === true}
          aria-label={`${item.name}: ${t("col_online")}`}
          onChange={(e) => void onData({ buy_online: e.target.checked })}
        />
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        <Button variant="ghost" size="base" onClick={onDetails}>
          {t("details")}
        </Button>
        <Button variant="ghost" size="base" aria-label={`${t("delete_item")}: ${item.name}`} onClick={onDelete}>
          {t("delete")}
        </Button>
      </td>
    </tr>
  );
}
