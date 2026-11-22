/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The item sheet of Project › Inventory: the data fields the table does not show, the list it lives in,
// and its history. Data only, saved when a field is left; state changes stay in the table.

import { useEffect, useState } from "react";
import type { ClientOptions, HistoryEntry, ProjectList } from "@plane/inventory";
import {
  browserImageEnv,
  fetchHistory,
  photoUrl,
  removePhoto,
  shrinkPhoto,
  updateItem,
  uploadPhoto,
} from "@plane/inventory";
import { Button } from "@plane/propel/button";
import { EModalWidth, ModalCore } from "@plane/ui";
import type { InventoryKey, InventoryT } from "../i18n";
import type { Item } from "../online";
import { failureMessage } from "../online";
import { FIELD, modeKey } from "./dialogs";
import { notifyInventoryChanged } from "../visibility";
import { EditableField, str } from "../controls";

const TEXT_FIELDS = ["purchase_url", "variant", "currency", "barcode"] as const;

export function ItemSheet(props: {
  open: boolean;
  t: InventoryT;
  opts: ClientOptions;
  projectId: string;
  item: Item | null;
  lists: ProjectList[];
  onClose: () => void;
  onSaved: (item: Item) => void;
}) {
  const { open, t, opts, projectId, item, lists, onClose, onSaved } = props;
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoBroken, setPhotoBroken] = useState<string | null>(null);
  // A photo that failed to load (offline: photos are never cached) is tried again when the network returns.
  useEffect(() => {
    const retry = () => setPhotoBroken(null);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  const itemId = item?.id;

  useEffect(() => {
    if (!open || !itemId) return;
    let live = true;
    setHistory(null);
    setMessage(null);
    void fetchHistory(opts, projectId, itemId).then((out) => {
      if (live) setHistory(out.kind === "ok" ? out.body : []);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [open, itemId, opts, projectId]);

  if (!item) return null;

  /** Resolves to the saved item, or null when nothing was saved (the field then shows the saved value). */
  const save = async (data: Record<string, unknown>): Promise<Item | null> => {
    const out = await updateItem(opts, projectId, item.id, data);
    if (out.kind !== "ok") {
      setMessage(failureMessage(out as { kind: string; error?: string }, t));
      return null;
    }
    onSaved(out.body as Item);
    notifyInventoryChanged();
    setMessage(t("saved"));
    return out.body as Item;
  };
  /** The photo (APLANE-66): shrunk here (fits the server's limit, drops EXIF and GPS), online only. */
  const photoDone = (out: { kind: string; failure?: string; error?: string; body?: unknown }) => {
    setPhotoBusy(false);
    if (out.kind !== "ok") {
      if (out.error === "too_large") return setMessage(t("photo_too_large"));
      if (out.error === "pending") return setMessage(t("photo_pending"));
      return setMessage(failureMessage(out, t));
    }
    onSaved(out.body as Item);
    notifyInventoryChanged();
    setMessage(t("saved"));
  };
  const pickPhoto = async (file: File) => {
    setPhotoBusy(true);
    setMessage(t("photo_uploading"));
    let shrunk: Blob | null;
    try {
      shrunk = await shrinkPhoto(file, browserImageEnv);
    } catch {
      setPhotoBusy(false);
      return setMessage(t("photo_unreadable"));
    }
    if (!shrunk) return photoDone({ kind: "refused", error: "too_large" });
    photoDone(await uploadPhoto<Item>(opts, projectId, item.id, shrunk));
  };
  const photo = typeof item.photo === "string" ? item.photo : null;

  const commit = (field: string, value: (draft: string) => unknown) => async (draft: string) => {
    const saved = await save({ [field]: value(draft) });
    return saved ? str(saved[field]) : null;
  };

  return (
    <ModalCore isOpen={open} handleClose={onClose} width={EModalWidth.XXL}>
      <div className="flex max-h-[80dvh] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-16 font-medium text-primary">{item.name}</h3>
          <span className="text-13 text-tertiary">{t(modeKey(item.mode))}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-13 text-secondary">
            {t("field_list")}
            <select
              className={FIELD}
              value={(item.list as { id: string } | undefined)?.id ?? ""}
              onChange={(e) => void save({ inventory_list: e.target.value })}
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {TEXT_FIELDS.map((field) => (
            <label key={field} className="flex flex-col gap-1 text-13 text-secondary">
              {t(`field_${field}` as InventoryKey)}
              <EditableField
                className={FIELD}
                value={str(item[field])}
                maxLength={field === "currency" ? 3 : field === "barcode" ? 64 : 2048}
                onCommit={commit(field, (d) => d.trim())}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-13 text-secondary">
            {t("field_last_price")}
            <EditableField
              className={FIELD}
              inputMode="decimal"
              value={str(item.last_price)}
              onCommit={commit("last_price", (d) => {
                const v = d.trim().replace(",", ".");
                return v === "" ? null : v;
              })}
            />
          </label>
          <label className="flex flex-col gap-1 text-13 text-secondary">
            {t("field_expires_on")}
            <EditableField
              className={FIELD}
              type="date"
              value={str(item.expires_on)}
              onCommit={commit("expires_on", (d) => d || null)}
            />
          </label>
        </div>
        <section className="flex flex-col gap-2">
          <h4 className="text-13 font-medium text-secondary">{t("photo")}</h4>
          {photo && photoBroken === photo ? (
            <p className="text-13 text-tertiary">{t("photo_unavailable")}</p>
          ) : (
            photo && (
              <img
                src={photoUrl(opts, projectId, item.id, photo)}
                alt={t("photo_of", { item: item.name })}
                className="max-h-64 max-w-full self-start rounded-md border border-subtle object-contain"
                onError={() => setPhotoBroken(photo)}
              />
            )
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`inline-flex h-8 cursor-pointer items-center rounded-md border border-strong px-3 text-13 text-secondary ${photoBusy ? "pointer-events-none opacity-50" : ""}`}
            >
              {t(photo ? "photo_replace" : "photo_add")}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={photoBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void pickPhoto(file);
                }}
              />
            </label>
            {photo && (
              <Button
                variant="ghost"
                size="sm"
                disabled={photoBusy}
                onClick={async () => {
                  setPhotoBusy(true);
                  photoDone(await removePhoto<Item>(opts, projectId, item.id));
                }}
              >
                {t("photo_remove")}
              </Button>
            )}
          </div>
        </section>
        {message && (
          <p role="status" className="text-13 text-secondary">
            {message}
          </p>
        )}
        <section>
          <h4 className="mb-2 text-13 font-medium text-secondary">{t("history")}</h4>
          {history === null ? (
            <p className="text-13 text-tertiary">{t("loading")}</p>
          ) : history.length === 0 ? (
            <p className="text-13 text-tertiary">{t("history_empty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {history.map((h) => (
                <li key={h.id} className={`text-13 ${h.reverted ? "text-tertiary line-through" : "text-secondary"}`}>
                  <time dateTime={h.occurred_at} className="mr-2 text-tertiary">
                    {new Date(h.occurred_at).toLocaleString()}
                  </time>
                  {h.actor?.display_name ?? t("someone")} · {h.op}
                  {Object.keys(h.args).length > 0 && (
                    <span className="text-tertiary">
                      {" "}
                      {Object.entries(h.args)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex justify-end">
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
