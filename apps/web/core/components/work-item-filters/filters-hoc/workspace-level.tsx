/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo, useState } from "react";
import { isEqual, cloneDeep } from "lodash-es";
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
// plane imports
import { DEFAULT_GLOBAL_VIEWS_LIST, EUserPermissionsLevel } from "@plane/constants";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { IWorkspaceView, TWorkItemFilterExpression } from "@plane/types";
import { EUserProjectRoles, EViewAccess } from "@plane/types";
// components
import { removeNillKeys } from "@/components/issues/issue-layouts/utils";
import { CreateUpdateWorkspaceViewModal } from "@/components/workspace/views/modal";
import { DeleteGlobalViewModal } from "@/components/workspace/views/delete-view-modal";
// hooks
import { useGlobalView } from "@/hooks/store/use-global-view";
import { useLabel } from "@/hooks/store/use-label";
import { useMember } from "@/hooks/store/use-member";
import { useProject } from "@/hooks/store/use-project";
import { useUser, useUserPermissions } from "@/hooks/store/user";
// local imports
import { WorkItemFiltersHOC } from "./base";
import type {
  TEnableDeleteViewProps,
  TEnableSaveViewProps,
  TEnableUpdateViewProps,
  TSharedWorkItemFiltersHOCProps,
} from "./shared";

type TWorkspaceLevelWorkItemFiltersHOCProps = TSharedWorkItemFiltersHOCProps & {
  workspaceSlug: string;
} & TEnableSaveViewProps &
  TEnableUpdateViewProps &
  TEnableDeleteViewProps;

export const WorkspaceLevelWorkItemFiltersHOC = observer(function WorkspaceLevelWorkItemFiltersHOC(
  props: TWorkspaceLevelWorkItemFiltersHOCProps
) {
  const { children, enableSaveView, enableUpdateView, enableDeleteView, entityId, initialWorkItemFilters, workspaceSlug } =
    props;
  // states
  const [isCreateViewModalOpen, setIsCreateViewModalOpen] = useState(false);
  const [createViewPayload, setCreateViewPayload] = useState<Partial<IWorkspaceView> | undefined>(undefined);
  const [isDeleteViewModalOpen, setIsDeleteViewModalOpen] = useState(false);
  // router
  const router = useRouter();
  // hooks
  const { getViewDetailsById, updateGlobalView } = useGlobalView();
  const { data: currentUser } = useUser();
  const { allowPermissions } = useUserPermissions();
  const { joinedProjectIds } = useProject();
  const {
    workspace: { getWorkspaceMemberIds },
  } = useMember();
  const { getWorkspaceLabelIds } = useLabel();
  // derived values
  const hasWorkspaceMemberLevelPermissions = allowPermissions(
    [EUserProjectRoles.ADMIN, EUserProjectRoles.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );
  // workspace admins can delete any view (matches the backend destroy permission); update stays owner-only.
  const isWorkspaceAdmin = allowPermissions(
    [EUserProjectRoles.ADMIN],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );
  const viewDetails = entityId ? getViewDetailsById(entityId) : null;
  const isDefaultView = typeof entityId === "string" && DEFAULT_GLOBAL_VIEWS_LIST.some((view) => view.key === entityId);
  const isViewLocked = viewDetails ? viewDetails?.is_locked : false;
  const isCurrentUserOwner = viewDetails ? viewDetails.owned_by === currentUser?.id : false;
  const canCreateView = useMemo(
    () => enableSaveView && !props.saveViewOptions?.isDisabled && hasWorkspaceMemberLevelPermissions,
    [enableSaveView, props.saveViewOptions?.isDisabled, hasWorkspaceMemberLevelPermissions]
  );
  const canUpdateView = useMemo(
    () =>
      enableUpdateView &&
      !isDefaultView &&
      !props.updateViewOptions?.isDisabled &&
      !isViewLocked &&
      hasWorkspaceMemberLevelPermissions &&
      isCurrentUserOwner,
    [
      enableUpdateView,
      props.updateViewOptions?.isDisabled,
      isDefaultView,
      isViewLocked,
      hasWorkspaceMemberLevelPermissions,
      isCurrentUserOwner,
    ]
  );
  const canDeleteView = useMemo(
    () =>
      enableDeleteView &&
      !isDefaultView &&
      !props.deleteViewOptions?.isDisabled &&
      !isViewLocked &&
      (isCurrentUserOwner || isWorkspaceAdmin),
    [
      enableDeleteView,
      props.deleteViewOptions?.isDisabled,
      isDefaultView,
      isViewLocked,
      isCurrentUserOwner,
      isWorkspaceAdmin,
    ]
  );
  const createViewLabel = useMemo(() => props.saveViewOptions?.label, [props.saveViewOptions?.label]);
  const updateViewLabel = useMemo(() => props.updateViewOptions?.label, [props.updateViewOptions?.label]);
  const deleteViewLabel = useMemo(() => props.deleteViewOptions?.label, [props.deleteViewOptions?.label]);
  const hasAdditionalChanges = useMemo(
    () =>
      !isEqual(initialWorkItemFilters?.displayFilters, viewDetails?.display_filters) ||
      !isEqual(
        removeNillKeys(initialWorkItemFilters?.displayProperties),
        removeNillKeys(viewDetails?.display_properties)
      ),
    [initialWorkItemFilters, viewDetails]
  );

  const getDefaultViewDetailPayload: () => Partial<IWorkspaceView> = useCallback(
    () => ({
      name: viewDetails ? `${viewDetails?.name} 2` : "Untitled",
      description: viewDetails ? viewDetails.description : "",
      access: viewDetails ? viewDetails.access : EViewAccess.PUBLIC,
    }),
    [viewDetails]
  );

  const getViewFilterPayload: (filterExpression: TWorkItemFilterExpression) => Partial<IWorkspaceView> = useCallback(
    (filterExpression: TWorkItemFilterExpression) => ({
      rich_filters: cloneDeep(filterExpression),
      display_filters: cloneDeep(initialWorkItemFilters?.displayFilters),
      display_properties: cloneDeep(initialWorkItemFilters?.displayProperties),
    }),
    [initialWorkItemFilters]
  );

  const handleViewSave = useCallback(
    (expression: TWorkItemFilterExpression) => {
      setCreateViewPayload({
        ...getDefaultViewDetailPayload(),
        ...getViewFilterPayload(expression),
      });
      setIsCreateViewModalOpen(true);
    },
    [getDefaultViewDetailPayload, getViewFilterPayload]
  );

  const handleViewUpdate = useCallback(
    (filterExpression: TWorkItemFilterExpression) => {
      if (!viewDetails) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "We couldn't find the view",
          message: "The view you're trying to update doesn't exist.",
        });

        return;
      }

      updateGlobalView(
        workspaceSlug,
        viewDetails.id,
        {
          ...getViewFilterPayload(filterExpression),
        },
        /* No need to sync filters here as updateFilters already handles it */
        false
      )
        .then(() => {
          setToast({
            type: TOAST_TYPE.SUCCESS,
            title: "Success!",
            message: "Your view has been updated successfully.",
          });
        })
        .catch(() => {
          setToast({
            type: TOAST_TYPE.ERROR,
            title: "Error!",
            message: "Your view could not be updated. Please try again.",
          });
        });
    },
    [viewDetails, updateGlobalView, workspaceSlug, getViewFilterPayload]
  );

  const saveViewOptions = useMemo(
    () => ({
      label: createViewLabel,
      isDisabled: !canCreateView,
      onViewSave: handleViewSave,
    }),
    [createViewLabel, canCreateView, handleViewSave]
  );

  const updateViewOptions = useMemo(
    () => ({
      label: updateViewLabel,
      isDisabled: !canUpdateView,
      // keep the button persistently visible for users who can update (not only on a detected change)
      hasAdditionalChanges: hasAdditionalChanges || canUpdateView,
      onViewUpdate: handleViewUpdate,
    }),
    [updateViewLabel, canUpdateView, hasAdditionalChanges, handleViewUpdate]
  );

  const deleteViewOptions = useMemo(
    () => ({
      label: deleteViewLabel,
      isDisabled: !canDeleteView,
      onViewDelete: () => setIsDeleteViewModalOpen(true),
    }),
    [deleteViewLabel, canDeleteView]
  );

  return (
    <>
      <CreateUpdateWorkspaceViewModal
        preLoadedData={createViewPayload}
        isOpen={isCreateViewModalOpen}
        onClose={() => {
          setCreateViewPayload(undefined);
          setIsCreateViewModalOpen(false);
        }}
      />
      {viewDetails && (
        <DeleteGlobalViewModal
          data={viewDetails}
          isOpen={isDeleteViewModalOpen}
          onClose={() => setIsDeleteViewModalOpen(false)}
          onDeleted={() => router.push(`/${workspaceSlug}/workspace-views/all-issues`)}
        />
      )}
      <WorkItemFiltersHOC
        {...props}
        memberIds={getWorkspaceMemberIds(workspaceSlug)}
        labelIds={getWorkspaceLabelIds(workspaceSlug)}
        projectIds={joinedProjectIds}
        saveViewOptions={saveViewOptions}
        updateViewOptions={updateViewOptions}
        deleteViewOptions={deleteViewOptions}
      >
        {children}
      </WorkItemFiltersHOC>
    </>
  );
});
