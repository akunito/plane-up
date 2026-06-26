/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EIssueLayoutTypes } from "@plane/types";
import { WorkspaceCalendarLayout } from "@/components/issues/issue-layouts/calendar/roots/workspace-root";
import { WorkspaceKanbanBoard } from "@/components/issues/issue-layouts/kanban/roots/workspace-root";
import { WorkspaceIssuesListLayout } from "@/components/issues/issue-layouts/list/roots/workspace-root";
import { WorkspaceSpreadsheetRoot } from "@/components/issues/issue-layouts/spreadsheet/roots/workspace-root";
import { WorkspaceAdditionalLayouts } from "@/plane-web/components/views/helper";

export type TWorkspaceLayoutProps = {
  activeLayout: EIssueLayoutTypes | undefined;
  isDefaultView: boolean;
  isLoading?: boolean;
  toggleLoading: (value: boolean) => void;
  workspaceSlug: string;
  globalViewId: string;
  routeFilters: {
    [key: string]: string;
  };
  fetchNextPages: () => void;
  globalViewsLoading: boolean;
  issuesLoading: boolean;
};

export function WorkspaceActiveLayout(props: TWorkspaceLayoutProps) {
  const {
    activeLayout = EIssueLayoutTypes.SPREADSHEET,
    isDefaultView,
    isLoading,
    toggleLoading,
    workspaceSlug,
    globalViewId,
    routeFilters,
    fetchNextPages,
    globalViewsLoading,
    issuesLoading,
  } = props;
  switch (activeLayout) {
    case EIssueLayoutTypes.LIST:
      return <WorkspaceIssuesListLayout />;
    case EIssueLayoutTypes.KANBAN:
      // Cross-project read-only board (frontend-only; groups the flat workspace list by state-group).
      return <WorkspaceKanbanBoard />;
    case EIssueLayoutTypes.CALENDAR:
      // Cross-project read-only calendar (frontend-only; groups the flat workspace list by target_date).
      return <WorkspaceCalendarLayout />;
    case EIssueLayoutTypes.SPREADSHEET:
      return (
        <WorkspaceSpreadsheetRoot
          isDefaultView={isDefaultView}
          isLoading={isLoading}
          toggleLoading={toggleLoading}
          workspaceSlug={workspaceSlug}
          globalViewId={globalViewId}
          routeFilters={routeFilters}
          fetchNextPages={fetchNextPages}
          globalViewsLoading={globalViewsLoading}
          issuesLoading={issuesLoading}
        />
      );
    default:
      return <WorkspaceAdditionalLayouts {...props} />;
  }
}
