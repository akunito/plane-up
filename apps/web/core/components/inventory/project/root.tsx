/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Project › Inventory (plan, phase 5): the desktop table with inline editing, list create/rename/delete,
// the item sheet, the aisle-order editor and the bulk rename of a category. Online only: state changes go
// to ops/ one at a time with a fresh queue id (online.ts); data changes go to the item endpoint.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { StateControl } from "../controls";
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

  const loadLists = useCallback(async () => {
    setLoadError(null);
    const [own, all, sugg] = await Promise.all([
      fetchProjectLists(opts, projectId),
      fetchLists(opts),
      fetchSuggestions(opts, ""),
    ]);
    if (own.kind !== "ok") {
      setLoadError(own.kind === "refused" && own.status === 403 ? t("no_access") : failureMessage(own, t));
      return;
    }
    setLists(own.body);
    if (all.kind === "ok") setVisible(all.body);
    if (sugg.kind === "ok") setCategories({ categories: sugg.body.categories, stores: sugg.body.stores });
    setSelected((s) => (s && own.body.some((l) => l.id === s) ? s : (own.body[0]?.id ?? null)));
  }, [opts, projectId, t]);

  const loadItems = useCallback(
    async (listId: string) => {
      const seq = ++loadSeq.current;
      setItems(null);
      const out = await fetchListItems(opts, projectId, listId);
      // A slower answer for a list no longer shown must not replace the shown one.
      if (seq !== loadSeq.current) return;
      if (out.kind !== "ok") {
        setMessage(failureMessage(out, t));
        setItems([]);
        return;
      }
      setItems(out.items as Item[]);
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

  const replace = (item: Item | null) => {
    if (!item) return;
    setItems((rows) => {
      if (!rows) return rows;
      // Moved to another list: it leaves this table.
      const listId = (item.list as { id: string } | undefined)?.id;
      if (listId && listId !== selected) return rows.filter((r) => r.id !== item.id);
      return rows.map((r) => (r.id === item.id ? item : r));
    });
  };

  const op = async (item: Item, name: Parameters<typeof sendNow>[1], args: Record<string, unknown>) => {
    setMessage(null);
    const out = await sendNow(opts, name, item, args, t);
    replace(out.item);
    if (!out.ok) setMessage(out.message);
  };

  const saveData = async (item: Item, data: Record<string, unknown>) => {
    setMessage(null);
    const out = await updateItem(opts, projectId, item.id, data);
    if (out.kind === "ok") {
      replace(out.body as Item);
      notifyInventoryChanged();
    } else setMessage(failureMessage(out, t));
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
    <div className="flex h-full w-full flex-col gap-3 overflow-auto p-4" data-testid="project-inventory">
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
          <table className="w-full min-w-[960px] border-collapse text-left text-13">
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
            <tbody>
              {items === null ? (
                <tr>
                  <td className={CELL} colSpan={9}>
                    <span className="text-tertiary">{t("loading")}</span>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td className={CELL} colSpan={9}>
                    <span className="text-tertiary">{t("list_empty")}</span>
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <ItemRow
                    key={`${item.id}:${item.rev}`}
                    item={item}
                    t={t}
                    onOp={(name, args) => void op(item, name, args)}
                    onData={(data) => void saveData(item, data)}
                    onUnits={() => setDialog({ kind: "units", item })}
                    onDetails={() => setDialog({ kind: "sheet", itemId: item.id })}
                    onDelete={() => setDialog({ kind: "delete_item", item })}
                  />
                ))
              )}
            </tbody>
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
          if (out.kind !== "ok") {
            setMessage(failureMessage(out, t));
            return;
          }
          setDialog(null);
          await loadLists();
          setSelected(out.body.id);
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
        onSaved={replace}
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

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? String(v) : "");

function ItemRow(props: {
  item: Item;
  t: InventoryT;
  onOp: (name: Parameters<typeof sendNow>[1], args: Record<string, unknown>) => void;
  onData: (data: Record<string, unknown>) => void;
  onUnits: () => void;
  onDetails: () => void;
  onDelete: () => void;
}) {
  const { item, t, onOp, onData, onUnits, onDetails, onDelete } = props;
  const blurText = (field: string) => (e: React.FocusEvent<HTMLInputElement>) => {
    const v = e.target.value.trim();
    if (field === "name" && !v) {
      e.target.value = item.name;
      return;
    }
    if (v !== str(item[field])) onData({ [field]: v });
  };
  const blurNumber = (field: "min_quantity" | "restock_to") => (e: React.FocusEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    if (raw === num(item[field])) return;
    if (raw !== "" && !/^\d{1,6}$/.test(raw)) {
      e.target.value = num(item[field]);
      return;
    }
    onData({ [field]: raw === "" ? null : Number(raw) });
  };
  const onOrder = typeof item.on_order === "number" ? item.on_order : 0;
  const toBuy = typeof item.to_buy === "number" ? item.to_buy : 0;

  return (
    <tr data-testid="inventory-row" data-item={item.name}>
      <td className={CELL}>
        <input className={INLINE} defaultValue={item.name} aria-label={t("field_name")} onBlur={blurText("name")} />
      </td>
      <td className={CELL}>
        <select
          className={INLINE}
          value={item.mode}
          aria-label={`${item.name}: ${t("col_tracking")}`}
          onChange={(e) => {
            if (e.target.value === "units") onUnits();
            else onOp("change_mode", { mode: e.target.value });
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
          {toBuy > 0 && item.mode !== "pinned" && (
            <span className="text-11 text-tertiary">{t("to_buy", { n: toBuy })}</span>
          )}
        </div>
      </td>
      <td className={CELL}>
        {item.mode === "units" ? (
          <input
            className={`${INLINE} w-16`}
            inputMode="numeric"
            defaultValue={num(item.min_quantity)}
            aria-label={`${item.name}: ${t("col_min")}`}
            onBlur={blurNumber("min_quantity")}
          />
        ) : null}
      </td>
      <td className={CELL}>
        {item.mode === "units" ? (
          <input
            className={`${INLINE} w-16`}
            inputMode="numeric"
            defaultValue={num(item.restock_to)}
            aria-label={`${item.name}: ${t("col_restock")}`}
            onBlur={blurNumber("restock_to")}
          />
        ) : null}
      </td>
      <td className={CELL}>
        <input
          className={INLINE}
          list="inventory-categories"
          defaultValue={str(item.category)}
          aria-label={`${item.name}: ${t("col_category")}`}
          onBlur={blurText("category")}
        />
      </td>
      <td className={CELL}>
        <input
          className={INLINE}
          list="inventory-stores"
          defaultValue={str(item.store)}
          aria-label={`${item.name}: ${t("col_store")}`}
          onBlur={blurText("store")}
        />
      </td>
      <td className={CELL}>
        <input
          type="checkbox"
          checked={item.buy_online === true}
          aria-label={`${item.name}: ${t("col_online")}`}
          onChange={(e) => onData({ buy_online: e.target.checked })}
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
