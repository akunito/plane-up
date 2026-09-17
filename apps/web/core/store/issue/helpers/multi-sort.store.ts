/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable } from "mobx";
import type { TIssueOrderByOptions } from "@plane/types";

/**
 * Frontend-only multi-sort: up to 2 SECONDARY sort keys applied client-side (in
 * base-issues.store `issuesSortWithMultipleOrderBy`) AFTER the persisted single-key
 * primary `order_by`.
 *
 * Rules are kept **per view** (project, cycle, module, project view, global view,
 * profile) and persisted to localStorage, so sorting one board a certain way no longer
 * silently re-sorts every other one. Frontend-only — the backend's single-string
 * `order_by` is never touched.
 */
const STORAGE_KEY = "plane_multi_sort_secondary_order_by_v2";
/** v1 kept ONE list shared by every view; it becomes the fallback for views with no rules yet. */
const LEGACY_STORAGE_KEY = "plane_multi_sort_secondary_order_by";
export const LEGACY_SCOPE = "__legacy_default__";

const EMPTY: TIssueOrderByOptions[] = [];

export type TMultiSortScope = {
  workspaceSlug?: string | undefined;
  projectId?: string | undefined;
  cycleId?: string | undefined;
  moduleId?: string | undefined;
  viewId?: string | undefined;
  globalViewId?: string | undefined;
  userId?: string | undefined;
};

/** One key per view. Order matters: the most specific id wins. */
export const multiSortScopeKey = (scope: TMultiSortScope): string => {
  const workspace = scope.workspaceSlug ?? "-";
  if (scope.globalViewId) return `${workspace}|global:${scope.globalViewId}`;
  if (scope.cycleId) return `${workspace}|cycle:${scope.cycleId}`;
  if (scope.moduleId) return `${workspace}|module:${scope.moduleId}`;
  if (scope.viewId) return `${workspace}|view:${scope.viewId}`;
  if (scope.userId) return `${workspace}|profile:${scope.userId}`;
  if (scope.projectId) return `${workspace}|project:${scope.projectId}`;
  return `${workspace}|workspace`;
};

const sanitize = (value: unknown): TIssueOrderByOptions[] =>
  Array.isArray(value) ? (value.filter((k) => typeof k === "string").slice(0, 2) as TIssueOrderByOptions[]) : EMPTY;

const loadFromStorage = (): Record<string, TIssueOrderByOptions[]> => {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const byScope: Record<string, TIssueOrderByOptions[]> = {};
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [scope, keys] of Object.entries(parsed)) {
        const clean = sanitize(keys);
        if (clean.length) byScope[scope] = clean;
      }
    }
    // migrate v1: its single list keeps working everywhere until a view gets its own rules
    if (!raw) {
      const legacy = sanitize(JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null"));
      if (legacy.length) byScope[LEGACY_SCOPE] = legacy;
    }
    return byScope;
  } catch {
    return {};
  }
};

class MultiSortStore {
  byScope: Record<string, TIssueOrderByOptions[]> = loadFromStorage();

  constructor() {
    makeObservable(this, {
      byScope: observable.ref,
      setSecondaryOrderBy: action,
    });
  }

  /** Rules for one view: its own, else the migrated v1 list, else none. */
  secondaryOrderBy = (scope: string): TIssueOrderByOptions[] =>
    this.byScope[scope] ?? this.byScope[LEGACY_SCOPE] ?? EMPTY;

  setSecondaryOrderBy = (scope: string, keys: TIssueOrderByOptions[]) => {
    const next = { ...this.byScope, [scope]: keys.slice(0, 2) };
    if (!next[scope].length) delete next[scope];
    this.byScope = next;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byScope));
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      /* ignore quota / serialization errors */
    }
  };
}

export const multiSortStore = new MultiSortStore();
