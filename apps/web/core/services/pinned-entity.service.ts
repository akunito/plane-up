/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";
import type { TIssue, TPage } from "@plane/types";

/**
 * Reads one pinned page / work item, **keeping the HTTP status**: the sidebar has to tell
 * "the thing was deleted" (drop the pin) apart from "this user lost access" (hide it).
 * The app's own services throw `error.response.data`, which loses the status.
 */
export type TPinnedFetch<T> = { status: number; data?: T };

export class PinnedEntityService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private async read<T>(url: string): Promise<TPinnedFetch<T>> {
    try {
      const response = await this.get(url);
      return { status: response?.status ?? 200, data: response?.data as T };
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      return { status: status ?? 0 };
    }
  }

  async fetchWorkItem(workspaceSlug: string, projectId: string, issueId: string): Promise<TPinnedFetch<TIssue>> {
    return this.read<TIssue>(`/api/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`);
  }

  async fetchPage(workspaceSlug: string, projectId: string, pageId: string): Promise<TPinnedFetch<TPage>> {
    return this.read<TPage>(`/api/workspaces/${workspaceSlug}/projects/${projectId}/pages/${pageId}/`);
  }
}
