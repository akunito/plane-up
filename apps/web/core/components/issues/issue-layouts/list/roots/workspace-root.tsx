/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import type { TGroupedIssues, TIssueKanbanFilters } from "@plane/types";
import { EIssuesStoreType } from "@plane/types";
// hooks
import { useIssues } from "@/hooks/store/use-issues";
import { useIssuesActions } from "@/hooks/use-issues-actions";
// local imports
import { List } from "../default";

const EMPTY_COLLAPSED_GROUPS: TIssueKanbanFilters = { group_by: [], sub_group_by: [] };

/**
 * Cross-project read-only List for the workspace-level / global ("All work items") views.
 *
 * Renders the shared <List> directly off the GLOBAL store's already-loaded flat list (fetched by
 * all-issue-layout-root). It deliberately does NOT use BaseListRoot — that root fires its own
 * fetchIssues, which races the parent fetch for the GLOBAL store (both clear() + share one abort
 * controller) and left the list stuck on a loader. It also skips IssueLayoutHOC's count-based gating.
 * group_by is null → a single flat cross-project list. Read-only: tap a row to open the work item.
 *
 * Must be rendered inside the GLOBAL IssuesStoreContext (WorkspaceActiveLayout provides it).
 */
export const WorkspaceIssuesListLayout = observer(function WorkspaceIssuesListLayout() {
  // store hooks
  const { issues, issuesFilter, issueMap } = useIssues(EIssuesStoreType.GLOBAL);
  const { fetchNextIssues } = useIssuesActions(EIssuesStoreType.GLOBAL);

  // derived values
  const displayFilters = issuesFilter?.issueFilters?.displayFilters;
  const displayProperties = issuesFilter?.issueFilters?.displayProperties;
  const groupedIssueIds = (issues?.groupedIssueIds ?? {}) as TGroupedIssues;

  return (
    <div className="relative size-full bg-surface-2">
      <List
        issuesMap={issueMap}
        displayProperties={displayProperties}
        group_by={null}
        orderBy={displayFilters?.order_by || undefined}
        updateIssue={undefined}
        quickActions={() => null}
        groupedIssueIds={groupedIssueIds}
        loadMoreIssues={() => fetchNextIssues()}
        showEmptyGroup={false}
        enableIssueQuickAdd={false}
        canEditProperties={() => false}
        disableIssueCreation
        handleOnDrop={async () => {}}
        handleCollapsedGroups={() => {}}
        collapsedGroups={EMPTY_COLLAPSED_GROUPS}
      />
    </div>
  );
});
