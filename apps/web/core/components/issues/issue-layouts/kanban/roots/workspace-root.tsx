/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useRef } from "react";
import { observer } from "mobx-react";
// plane imports
import { ALL_ISSUES } from "@plane/constants";
import { EIssuesStoreType } from "@plane/types";
import { Loader } from "@plane/ui";
// components
import { getGroupByColumns } from "@/components/issues/issue-layouts/utils";
// hooks
import { useIssues } from "@/hooks/store/use-issues";
import { useProjectState } from "@/hooks/store/use-project-state";
import { useIssuesActions } from "@/hooks/use-issues-actions";
// local imports
import { KanbanIssueBlocksList } from "../blocks-list";

const NO_STATE_COLUMN_ID = "__no_state__";

/**
 * Cross-project read-only Board for the workspace-level / global ("All work items") views.
 *
 * The OSS build only ships Spreadsheet + List for global views — a real cross-project board is
 * Enterprise-stubbed, and the workspace-views issues endpoint returns a FLAT (ungrouped) list (it has
 * no server-side group_by). So this groups the already-loaded flat list CLIENT-SIDE by the 5 universal
 * state groups (the only grouping that is meaningful across projects), reusing the standard kanban card
 * (`KanbanIssueBlocksList`). It is intentionally read-only: no drag-drop, no quick-add — tap a card to
 * open the work item (the global layout already mounts <IssuePeekOverview/>).
 *
 * Must be rendered inside the GLOBAL IssuesStoreContext (WorkspaceActiveLayout provides it).
 */
export const WorkspaceKanbanBoard = observer(function WorkspaceKanbanBoard() {
  // store hooks
  const { issueMap, issuesFilter, issues } = useIssues(EIssuesStoreType.GLOBAL);
  const { fetchNextIssues } = useIssuesActions(EIssuesStoreType.GLOBAL);
  const { getStateById } = useProjectState();
  // refs
  const scrollableContainerRef = useRef<HTMLDivElement | null>(null);

  // derived values
  const displayProperties = issuesFilter?.issueFilters?.displayProperties;
  // The GLOBAL store fetches a flat list, so every loaded id lives under the ALL_ISSUES key.
  const issueIds = useMemo(() => (issues?.groupedIssueIds?.[ALL_ISSUES] as string[]) ?? [], [issues?.groupedIssueIds]);
  const loader = issues?.getIssueLoader();
  const totalCount = issues?.getGroupIssueCount(undefined, undefined, false) ?? 0;
  const hasNextPage = !!issues?.getPaginationData(undefined, undefined)?.nextPageResults;

  // The 5 universal status-group columns (Backlog / Unstarted / Started / Completed / Cancelled).
  const stateGroupColumns = useMemo(
    () => getGroupByColumns({ groupBy: "state_detail.group", includeNone: false, isWorkspaceLevel: true }) ?? [],
    []
  );

  // Bucket each loaded issue into its state group (client-side; order within a column is preserved
  // from the store's already-sorted flat list, so the active sort carries over).
  const idsByGroup = useMemo(() => {
    const buckets: Record<string, string[]> = { [NO_STATE_COLUMN_ID]: [] };
    for (const column of stateGroupColumns) buckets[column.id] = [];
    for (const id of issueIds) {
      const issue = issueMap?.[id];
      const group = issue?.state_id ? getStateById(issue.state_id)?.group : undefined;
      if (group && buckets[group]) buckets[group].push(id);
      else buckets[NO_STATE_COLUMN_ID].push(id);
    }
    return buckets;
  }, [stateGroupColumns, issueIds, issueMap, getStateById]);

  // Only show the "No status" column if it actually has issues (states not yet loaded, etc.).
  const columns = useMemo(() => {
    const cols = [...stateGroupColumns];
    if (idsByGroup[NO_STATE_COLUMN_ID]?.length) {
      cols.push({ id: NO_STATE_COLUMN_ID, name: "No status", icon: undefined, payload: {} });
    }
    return cols;
  }, [stateGroupColumns, idsByGroup]);

  // read-only: no quick-actions menu, no inline edit, no drag.
  const renderQuickActions = () => null;
  const canEditProperties = () => false;

  if (loader === "init-loader") {
    return (
      <div className="flex h-full w-full gap-3 overflow-hidden bg-surface-1 p-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Loader key={i} className="w-[280px] flex-shrink-0 space-y-2 sm:w-[320px]">
            <Loader.Item height="28px" />
            <Loader.Item height="88px" />
            <Loader.Item height="88px" />
          </Loader>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scrollableContainerRef}
      className="relative flex h-full w-full gap-3 overflow-x-auto overflow-y-hidden bg-surface-1 px-3 py-3"
    >
      {columns.map((column) => {
        const ids = idsByGroup[column.id] ?? [];
        return (
          <div key={column.id} className="flex h-full w-[280px] flex-shrink-0 flex-col sm:w-[320px]">
            {/* column header */}
            <div className="mb-2 flex items-center gap-2 px-1">
              {column.icon}
              <span className="text-sm font-semibold text-secondary">{column.name}</span>
              <span className="text-xs font-medium text-tertiary">{ids.length}</span>
            </div>
            {/* cards */}
            <div className="flex flex-col gap-2 overflow-y-auto pb-2 pr-1">
              {ids.length > 0 ? (
                <KanbanIssueBlocksList
                  sub_group_id=""
                  groupId={column.id}
                  issuesMap={issueMap}
                  issueIds={ids}
                  displayProperties={displayProperties}
                  updateIssue={undefined}
                  quickActions={renderQuickActions}
                  canEditProperties={canEditProperties}
                  canDropOverIssue={false}
                  canDragIssuesInCurrentGrouping={false}
                  scrollableContainerRef={scrollableContainerRef}
                />
              ) : (
                <span className="px-1 py-2 text-xs text-tertiary">No work items</span>
              )}
            </div>
          </div>
        );
      })}

      {/* Load more — the board only sees issues already fetched into the flat list. */}
      {hasNextPage && (
        <div className="flex h-full flex-shrink-0 items-start pt-9">
          <button
            type="button"
            disabled={loader === "pagination"}
            onClick={() => fetchNextIssues()}
            className="whitespace-nowrap rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-xs font-medium text-secondary hover:bg-surface-3 disabled:opacity-60"
          >
            {loader === "pagination" ? "Loading…" : `Load more (${issueIds.length}/${totalCount})`}
          </button>
        </div>
      )}
    </div>
  );
});
