/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { observer } from "mobx-react";
// plane imports
import { ALL_ISSUES } from "@plane/constants";
import type { TGroupedIssues } from "@plane/types";
import { EIssuesStoreType } from "@plane/types";
import { renderFormattedPayloadDate } from "@plane/utils";
// hooks
import { useCalendarView } from "@/hooks/store/use-calendar-view";
import { useIssues } from "@/hooks/store/use-issues";
import { useIssuesActions } from "@/hooks/use-issues-actions";
// local imports
import { CalendarChart } from "../calendar";

/**
 * Cross-project read-only Calendar for the workspace-level / global ("All work items") views.
 *
 * Like the global Board: the workspace-views endpoint returns a FLAT list (it can't group server-side
 * by target_date the way the project calendar does), so this groups the already-loaded flat list
 * CLIENT-SIDE by `target_date` and feeds the shared `CalendarChart`. It is read-only — no drag-drop,
 * no quick-add; tap a day's card to open the work item (the global layout mounts <IssuePeekOverview/>).
 *
 * Only issues already fetched into the flat list (and that have a target_date) appear on the calendar.
 * Must be rendered inside the GLOBAL IssuesStoreContext (WorkspaceActiveLayout provides it).
 */
export const WorkspaceCalendarLayout = observer(function WorkspaceCalendarLayout() {
  // store hooks
  const { issues, issuesFilter, issueMap } = useIssues(EIssuesStoreType.GLOBAL);
  const { updateFilters } = useIssuesActions(EIssuesStoreType.GLOBAL);
  const issueCalendarView = useCalendarView();

  // derived values
  const displayFilters = issuesFilter?.issueFilters?.displayFilters;
  const flatIds = useMemo(
    () => (issues?.groupedIssueIds?.[ALL_ISSUES] as string[]) ?? [],
    [issues?.groupedIssueIds]
  );

  // Bucket the loaded issues by their target_date (YYYY-MM-DD) — the keys the calendar day tiles use.
  const groupedIssueIds = useMemo(() => {
    const grouped: Record<string, string[]> = {};
    for (const id of flatIds) {
      const issue = issueMap?.[id];
      const dateKey = issue?.target_date ? renderFormattedPayloadDate(issue.target_date) : null;
      if (!dateKey) continue;
      (grouped[dateKey] ||= []).push(id);
    }
    return grouped as TGroupedIssues;
  }, [flatIds, issueMap]);

  return (
    <div className="h-full w-full overflow-hidden bg-surface-1 pt-4">
      <CalendarChart
        // The global filter store is shape-compatible; cast to satisfy the project-scoped prop type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        issuesFilterStore={issuesFilter as any}
        issues={issueMap}
        groupedIssueIds={groupedIssueIds}
        layout={displayFilters?.calendar?.layout}
        showWeekends={displayFilters?.calendar?.show_weekends ?? false}
        issueCalendarView={issueCalendarView}
        quickActions={() => null}
        loadMoreIssues={() => {}}
        getPaginationData={() => undefined}
        getGroupIssueCount={(date) => (date ? (groupedIssueIds[date]?.length ?? 0) : flatIds.length)}
        readOnly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateFilters={updateFilters as any}
        handleDragAndDrop={async () => {}}
        canEditProperties={() => false}
      />
    </div>
  );
});
