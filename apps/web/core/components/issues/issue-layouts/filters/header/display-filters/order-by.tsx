/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { observer } from "mobx-react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { ISSUE_ORDER_BY_OPTIONS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TIssueOrderByOptions } from "@plane/types";

// components
import { FilterHeader, FilterOption } from "@/components/issues/issue-layouts/filters";
// store
import { multiSortStore } from "@/store/issue/helpers/multi-sort.store";

type Props = {
  selectedOrderBy: TIssueOrderByOptions | undefined;
  handleUpdate: (val: TIssueOrderByOptions) => void;
  orderByOptions: TIssueOrderByOptions[];
  // when true, render the secondary multi-sort rules editor (Display popover only)
  enableMultiSort?: boolean;
};

const baseOf = (k: string) => (k.startsWith("-") ? k.slice(1) : k);
const flip = (k: TIssueOrderByOptions): TIssueOrderByOptions =>
  (k.startsWith("-") ? k.slice(1) : `-${k}`) as TIssueOrderByOptions;

export const FilterOrderBy = observer(function FilterOrderBy(props: Props) {
  const { selectedOrderBy, handleUpdate, orderByOptions, enableMultiSort = false } = props;
  // hooks
  const { t } = useTranslation();

  const [previewEnabled, setPreviewEnabled] = useState(true);

  const activeOrderBy = selectedOrderBy ?? "-created_at";

  // multi-sort (secondary rules) — frontend-only, applied after the primary order_by
  const secondary = multiSortStore.secondaryOrderBy;
  const optionList = ISSUE_ORDER_BY_OPTIONS.filter((option) => orderByOptions.includes(option.key));
  const labelFor = (key: TIssueOrderByOptions) => {
    const opt = optionList.find((o) => baseOf(o.key) === baseOf(key));
    return opt ? t(opt.titleTranslationKey) : key;
  };
  const usedBases = new Set([baseOf(activeOrderBy), ...secondary.map((k) => baseOf(k))]);
  const addableOptions = optionList.filter((o) => baseOf(o.key) !== "sort_order" && !usedBases.has(baseOf(o.key)));

  const setSecondary = (keys: TIssueOrderByOptions[]) => multiSortStore.setSecondaryOrderBy(keys);
  const removeRule = (idx: number) => setSecondary(secondary.filter((_, i) => i !== idx));
  const toggleDir = (idx: number) => setSecondary(secondary.map((k, i) => (i === idx ? flip(k) : k)));
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...secondary];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setSecondary(next);
  };

  return (
    <>
      <FilterHeader
        title={t("common.order_by.label")}
        isPreviewEnabled={previewEnabled}
        handleIsPreviewEnabled={() => setPreviewEnabled(!previewEnabled)}
      />
      {previewEnabled && (
        <div>
          {optionList.map((orderBy) => (
            <FilterOption
              key={orderBy?.key}
              isChecked={activeOrderBy === orderBy?.key ? true : false}
              onClick={() => handleUpdate(orderBy.key)}
              title={t(orderBy.titleTranslationKey)}
              multiple={false}
            />
          ))}

          {enableMultiSort && (
            <div className="mt-2 border-t border-subtle pt-2">
              <div className="mb-1 px-1 text-11 font-medium text-tertiary">Then sort by</div>
              {/* rule 1 — the primary order_by (read-only here; changed via the radio above) */}
              <div className="flex items-center gap-2 rounded-sm px-2 py-1 text-12 text-secondary">
                <span className="w-3 flex-shrink-0 text-tertiary">1</span>
                <span className="flex-1 truncate">{labelFor(activeOrderBy)}</span>
                <span className="text-11 text-tertiary">{activeOrderBy.startsWith("-") ? "↓" : "↑"}</span>
              </div>
              {/* rules 2-3 — secondary keys */}
              {secondary.map((key, idx) => (
                <div key={`${key}-${idx}`} className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-12 text-primary">
                  <span className="w-3 flex-shrink-0 text-tertiary">{idx + 2}</span>
                  <span className="flex-1 truncate">{labelFor(key)}</span>
                  <button
                    type="button"
                    onClick={() => toggleDir(idx)}
                    className="rounded-sm border border-subtle px-1.5 py-0.5 text-10 font-medium text-secondary hover:bg-layer-1"
                    aria-label="Toggle sort direction"
                  >
                    {key.startsWith("-") ? "↓ Desc" : "↑ Asc"}
                  </button>
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => move(idx, -1)}
                    className="text-tertiary hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                    aria-label="Move up"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === secondary.length - 1}
                    onClick={() => move(idx, 1)}
                    className="text-tertiary hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                    aria-label="Move down"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRule(idx)}
                    className="text-tertiary hover:text-primary"
                    aria-label="Remove sort rule"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              {secondary.length < 2 && addableOptions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 px-1">
                  {addableOptions.map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setSecondary([...secondary, o.key])}
                      className="rounded-sm border border-dashed border-strong px-2 py-0.5 text-11 text-accent-primary hover:bg-layer-1"
                    >
                      + {t(o.titleTranslationKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
});
