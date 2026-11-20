/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Small dialogs of Project › Inventory: list create/rename (with the public-project warning), a number
// prompt, a text prompt. No autoFocus: headless UI's Dialog focuses the first field when it opens.

import { useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import { EModalWidth, ModalCore } from "@plane/ui";
import type { InventoryKey, InventoryT } from "../i18n";

export const MODES = ["pinned", "on_demand", "level", "units"] as const;
export type ModeName = (typeof MODES)[number];
export const modeKey = (mode: string): InventoryKey => `mode_${mode}` as InventoryKey;

const FIELD =
  "w-full rounded-md border border-subtle bg-layer-1 px-2.5 py-1.5 text-13 text-primary outline-none focus:border-accent-strong";

export function ListDialog(props: {
  open: boolean;
  t: InventoryT;
  title: string;
  initial: { name: string; default_mode: string };
  /** The first list of a public project with one member: anyone in the workspace could join and see it. */
  warnPublic: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; default_mode: string }) => Promise<void>;
}) {
  const { open, t, title, initial, warnPublic, onClose, onSubmit } = props;
  const [name, setName] = useState(initial.name);
  const [mode, setMode] = useState(initial.default_mode);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial.name);
      setMode(initial.default_mode);
    }
  }, [open, initial.name, initial.default_mode]);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), default_mode: mode });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalCore isOpen={open} handleClose={onClose} width={EModalWidth.LG}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 className="text-16 font-medium text-primary">{title}</h3>
        <label className="flex flex-col gap-1 text-13 text-secondary">
          {t("list_name")}
          <input className={FIELD} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-13 text-secondary">
          {t("default_mode")}
          <select className={FIELD} value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(modeKey(m))}
              </option>
            ))}
          </select>
        </label>
        {warnPublic && (
          <p role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-13 text-warning-primary">
            {t("public_warning")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" type="button" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" size="lg" type="submit" loading={busy} disabled={!name.trim()}>
            {initial.name ? t("save") : t("create")}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
}

export function PromptDialog(props: {
  open: boolean;
  t: InventoryT;
  title: string;
  hint?: string;
  label: string;
  initial: string;
  numeric?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const { open, t, title, hint, label, initial, numeric, onClose, onSubmit } = props;
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const valid = numeric ? /^\d{1,6}$/.test(value.trim()) : value.trim().length > 0 && value.length <= 255;
  return (
    <ModalCore isOpen={open} handleClose={onClose} width={EModalWidth.MD}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          void onSubmit(value.trim()).finally(() => setBusy(false));
        }}
      >
        <h3 className="text-16 font-medium text-primary">{title}</h3>
        {hint && <p className="text-13 text-tertiary">{hint}</p>}
        <label className="flex flex-col gap-1 text-13 text-secondary">
          {label}
          <input
            className={FIELD}
            value={value}
            inputMode={numeric ? "numeric" : "text"}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" type="button" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" size="lg" type="submit" loading={busy} disabled={!valid}>
            {t("save")}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
}

export { FIELD };
