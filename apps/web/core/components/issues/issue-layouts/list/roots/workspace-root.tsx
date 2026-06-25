/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
// hooks
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import { ProjectIssueQuickActions } from "../../quick-action-dropdowns";
import { BaseListRoot } from "../base-list-root";

/**
 * Cross-project List layout for workspace-level / global ("All Issues") views.
 * The OSS build only ships a Spreadsheet layout for global views (List/Board are
 * Enterprise-stubbed); this renders the shared BaseListRoot against the GLOBAL
 * store so global views can show a phone-friendly list. Must be rendered inside
 * the GLOBAL IssuesStoreContext (it is — WorkspaceActiveLayout provides it).
 */
export const WorkspaceIssuesListLayout = observer(function WorkspaceIssuesListLayout() {
  // router
  const { workspaceSlug, globalViewId } = useParams();
  // store
  const { allowPermissions } = useUserPermissions();

  const canEditPropertiesBasedOnProject = (projectId: string) =>
    allowPermissions(
      [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
      EUserPermissionsLevel.PROJECT,
      workspaceSlug.toString(),
      projectId
    );

  return (
    <BaseListRoot
      QuickActions={ProjectIssueQuickActions}
      canEditPropertiesBasedOnProject={canEditPropertiesBasedOnProject}
      viewId={globalViewId?.toString()}
    />
  );
});
