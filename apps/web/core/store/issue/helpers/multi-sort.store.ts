/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable } from "mobx";
import type { TIssueOrderByOptions } from "@plane/types";

/**
 * Frontend-only multi-sort: holds up to 2 SECONDARY sort keys applied client-side
 * (in base-issues.store `issuesSortWithMultipleOrderBy`) AFTER the persisted
 * single-key primary `order_by`. Persisted to localStorage so it survives reloads
 * (frontend-only — never touches the backend / the single-string order_by type).
 * A single active multi-sort shared across views.
 */
const STORAGE_KEY = "plane_multi_sort_secondary_order_by";

const loadFromStorage = (): TIssueOrderByOptions[] => {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.slice(0, 2) as TIssueOrderByOptions[]) : [];
  } catch {
    return [];
  }
};

class MultiSortStore {
  secondaryOrderBy: TIssueOrderByOptions[] = loadFromStorage();

  constructor() {
    makeObservable(this, {
      secondaryOrderBy: observable.ref,
      setSecondaryOrderBy: action,
    });
  }

  setSecondaryOrderBy = (keys: TIssueOrderByOptions[]) => {
    this.secondaryOrderBy = keys.slice(0, 2);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.secondaryOrderBy));
      }
    } catch {
      /* ignore quota / serialization errors */
    }
  };
}

export const multiSortStore = new MultiSortStore();
