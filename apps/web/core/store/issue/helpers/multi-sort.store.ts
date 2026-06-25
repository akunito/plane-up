/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable } from "mobx";
import type { TIssueOrderByOptions } from "@plane/types";

/**
 * Frontend-only multi-sort: holds up to 2 SECONDARY sort keys that are applied
 * client-side (in base-issues.store `issuesSortWithMultipleOrderBy`) AFTER the
 * persisted single-key primary `order_by`. In-memory only (resets on reload), a
 * single active multi-sort for the session — keeps the change frontend-only and
 * avoids touching the persisted single-string order_by type / the backend.
 */
class MultiSortStore {
  secondaryOrderBy: TIssueOrderByOptions[] = [];

  constructor() {
    makeObservable(this, {
      secondaryOrderBy: observable.ref,
      setSecondaryOrderBy: action,
    });
  }

  setSecondaryOrderBy = (keys: TIssueOrderByOptions[]) => {
    this.secondaryOrderBy = keys.slice(0, 2);
  };
}

export const multiSortStore = new MultiSortStore();
