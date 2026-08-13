/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import {
  EIssueFilterType,
  ISSUE_DISPLAY_FILTERS_BY_PAGE,
  ISSUE_LAYOUTS,
  GLOBAL_VIEW_TRACKER_ELEMENTS,
  DEFAULT_GLOBAL_VIEWS_LIST,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ViewsIcon } from "@plane/propel/icons";
import type { IIssueDisplayFilterOptions, IIssueDisplayProperties, ICustomSearchSelectOption } from "@plane/types";
import { EIssuesStoreType, EIssueLayoutTypes } from "@plane/types";
import { Breadcrumbs, Header, BreadcrumbNavigationSearchDropdown } from "@plane/ui";
import { cn } from "@plane/utils";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { SwitcherLabel } from "@/components/common/switcher-label";
import { DisplayFiltersSelection, FiltersDropdown } from "@/components/issues/issue-layouts/filters";
import { IssueLayoutIcon } from "@/components/issues/issue-layouts/layout-icon";
import { WorkItemFiltersToggle } from "@/components/work-item-filters/filters-toggle";
import { DefaultWorkspaceViewQuickActions } from "@/components/workspace/views/default-view-quick-action";
import { CreateUpdateWorkspaceViewModal } from "@/components/workspace/views/modal";
import { WorkspaceViewQuickActions } from "@/components/workspace/views/quick-action";
// hooks
import { useGlobalView } from "@/hooks/store/use-global-view";
import { useIssues } from "@/hooks/store/use-issues";
import { useAppRouter } from "@/hooks/use-app-router";
import { GlobalViewLayoutSelection, GLOBAL_VIEW_LAYOUTS } from "@/plane-web/components/views/helper";

export const GlobalIssuesHeader = observer(function GlobalIssuesHeader() {
  // states
  const [createViewModal, setCreateViewModal] = useState(false);
  // router
  const router = useAppRouter();
  const { workspaceSlug, globalViewId: routerGlobalViewId } = useParams();
  const globalViewId = routerGlobalViewId ? routerGlobalViewId.toString() : undefined;
  // store hooks
  const {
    issuesFilter: { filters, updateFilters },
  } = useIssues(EIssuesStoreType.GLOBAL);
  const { getViewDetailsById, currentWorkspaceViews } = useGlobalView();
  const { t } = useTranslation();

  const issueFilters = globalViewId ? filters[globalViewId.toString()] : undefined;

  const activeLayout = issueFilters?.displayFilters?.layout;
  const viewDetails = globalViewId ? getViewDetailsById(globalViewId) : undefined;

  const handleDisplayFilters = useCallback(
    (updatedDisplayFilter: Partial<IIssueDisplayFilterOptions>) => {
      if (!workspaceSlug || !globalViewId) return;
      updateFilters(
        workspaceSlug.toString(),
        undefined,
        EIssueFilterType.DISPLAY_FILTERS,
        updatedDisplayFilter,
        globalViewId
      );
    },
    [workspaceSlug, updateFilters, globalViewId]
  );

  const handleDisplayProperties = useCallback(
    (property: Partial<IIssueDisplayProperties>) => {
      if (!workspaceSlug || !globalViewId) return;
      updateFilters(workspaceSlug.toString(), undefined, EIssueFilterType.DISPLAY_PROPERTIES, property, globalViewId);
    },
    [workspaceSlug, updateFilters, globalViewId]
  );

  const handleLayoutChange = useCallback(
    (layout: EIssueLayoutTypes) => {
      if (!workspaceSlug || !globalViewId) return;
      updateFilters(
        workspaceSlug.toString(),
        undefined,
        EIssueFilterType.DISPLAY_FILTERS,
        { layout: layout },
        globalViewId
      );
    },
    [workspaceSlug, updateFilters, globalViewId]
  );

  const isLocked = viewDetails?.is_locked;

  const isDefaultView = DEFAULT_GLOBAL_VIEWS_LIST.find((view) => view.key === globalViewId);

  const defaultViewDetails = DEFAULT_GLOBAL_VIEWS_LIST.find((view) => view.key === globalViewId);

  const defaultOptions = DEFAULT_GLOBAL_VIEWS_LIST.map((view) => ({
    value: view.key,
    query: view.key,
    content: <SwitcherLabel name={t(view.i18n_label)} LabelIcon={ViewsIcon} />,
  }));

  const workspaceOptions = (currentWorkspaceViews || []).map((view) => {
    const _view = getViewDetailsById(view);
    if (!_view) return;
    return {
      value: _view.id,
      query: _view.name,
      content: <SwitcherLabel name={_view.name} LabelIcon={ViewsIcon} />,
    };
  });

  const switcherOptions = [...defaultOptions, ...workspaceOptions].filter(
    (option) => option !== undefined
  ) as ICustomSearchSelectOption[];
  const currentLayoutFilters = useMemo(() => {
    const layout = activeLayout ?? EIssueLayoutTypes.SPREADSHEET;
    return ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions[layout];
  }, [activeLayout]);

  return (
    <>
      <CreateUpdateWorkspaceViewModal isOpen={createViewModal} onClose={() => setCreateViewModal(false)} />
      <Header>
        {/* The header lives in a fixed-height (h-11) slot, so it must stay on one line. Let the
            breadcrumb shrink/truncate (min-w-0) so the right-side controls always stay visible. */}
        <Header.LeftItem className="min-w-0 flex-nowrap overflow-hidden max-md:max-w-[42%]">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={<BreadcrumbLink label={t("views")} icon={<ViewsIcon className="h-4 w-4 text-tertiary" />} />}
            />
            <Breadcrumbs.Item
              component={
                <BreadcrumbNavigationSearchDropdown
                  selectedItem={globalViewId?.toString() || ""}
                  navigationItems={switcherOptions}
                  onChange={(value: string) => {
                    router.push(`/${workspaceSlug}/workspace-views/${value}`);
                  }}
                  title={viewDetails?.name ?? t(defaultViewDetails?.i18n_label ?? "")}
                  icon={
                    <Breadcrumbs.Icon>
                      <ViewsIcon className="size-4 flex-shrink-0 text-tertiary" />
                    </Breadcrumbs.Icon>
                  }
                  isLast
                />
              }
              isLast
            />
          </Breadcrumbs>
        </Header.LeftItem>

        <Header.RightItem className="flex-shrink-0 items-center">
          {/* Layout switcher: desktop only. On phones it lives inside the Display popover (below) to
              leave room for the breadcrumb view-switcher to stay tappable. */}
          {!isLocked && (
            <div className="hidden md:flex">
              <GlobalViewLayoutSelection
                onChange={handleLayoutChange}
                selectedLayout={activeLayout ?? EIssueLayoutTypes.SPREADSHEET}
                workspaceSlug={workspaceSlug.toString()}
              />
            </div>
          )}
          {globalViewId && <WorkItemFiltersToggle entityType={EIssuesStoreType.GLOBAL} entityId={globalViewId} />}
          {!isLocked && (
            <FiltersDropdown title={t("common.display")} placement="bottom-end">
              {/* Fixed-height scroll box on phones so the bottom-docked sheet doesn't shrink/jump when
                  switching layouts (e.g. Calendar has fewer Display options). `md:contents` removes the
                  box on desktop so the popper sizes normally. */}
              <div className="flex h-[70vh] flex-col overflow-y-auto md:contents">
                {/* Layout switcher inside Display on phones, with labels (mirrors the desktop switcher). */}
                <div className="mb-3 border-b border-subtle px-2 pt-1 pb-3 md:hidden">
                  <div className="text-xs mb-2 font-medium text-tertiary">Layout</div>
                  <div className="flex flex-wrap gap-2">
                    {ISSUE_LAYOUTS.filter((l) => GLOBAL_VIEW_LAYOUTS.includes(l.key)).map((l) => {
                      const isActive = (activeLayout ?? EIssueLayoutTypes.SPREADSHEET) === l.key;
                      return (
                        <button
                          key={l.key}
                          type="button"
                          onClick={() => handleLayoutChange(l.key)}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-3 py-1.5 text-13 font-medium",
                            isActive
                              ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                              : "border-subtle text-secondary"
                          )}
                        >
                          <IssueLayoutIcon layout={l.key} size={14} strokeWidth={2} className="size-3.5" />
                          <span>{t(l.i18n_title)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <DisplayFiltersSelection
                  layoutDisplayFiltersOptions={currentLayoutFilters}
                  displayFilters={issueFilters?.displayFilters ?? {}}
                  handleDisplayFiltersUpdate={handleDisplayFilters}
                  displayProperties={issueFilters?.displayProperties ?? {}}
                  handleDisplayPropertiesUpdate={handleDisplayProperties}
                />
              </div>
            </FiltersDropdown>
          )}
          {/* Add view: desktop only — on phones it's an item inside the "⋯" menu (onCreateView). */}
          <Button
            variant="primary"
            size="lg"
            className="hidden flex-shrink-0 md:flex"
            data-ph-element={GLOBAL_VIEW_TRACKER_ELEMENTS.RIGHT_HEADER_ADD_BUTTON}
            onClick={() => setCreateViewModal(true)}
          >
            {t("workspace_views.add_view")}
          </Button>
          {/* view actions ("⋯") — shown on mobile too; on phones it also hosts "Add view". */}
          <div className="block">
            {viewDetails && (
              <WorkspaceViewQuickActions
                workspaceSlug={workspaceSlug?.toString()}
                view={viewDetails}
                onCreateView={() => setCreateViewModal(true)}
              />
            )}
            {isDefaultView && defaultViewDetails && (
              <DefaultWorkspaceViewQuickActions
                workspaceSlug={workspaceSlug?.toString()}
                view={defaultViewDetails}
                onCreateView={() => setCreateViewModal(true)}
              />
            )}
          </div>
        </Header.RightItem>
      </Header>
    </>
  );
});
