/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import { useTheme } from "next-themes";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TIssue } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
import { Loader } from "@plane/ui";
// assets
import emptyIssueDark from "@/app/assets/empty-state/search/issues-dark.webp?url";
import emptyIssueLight from "@/app/assets/empty-state/search/issues-light.webp?url";
// components
import { EmptyState } from "@/components/common/empty-state";
import { PageHead } from "@/components/core/page-title";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import { useAppRouter } from "@/hooks/use-app-router";
// layouts
import { ProjectAuthWrapper } from "@/layouts/auth-layout/project-wrapper";
// plane web imports
import { useWorkItemProperties } from "@/hooks/use-issue-properties";
import { WorkItemDetailRoot } from "@/components/browse/workItem-detail";

import type { Route } from "./+types/page";

export const IssueDetailsPage = observer(function IssueDetailsPage({ params }: Route.ComponentProps) {
  // router
  const router = useAppRouter();
  const { workspaceSlug, workItem } = params;
  // hooks
  const { resolvedTheme } = useTheme();
  // store hooks
  const { t } = useTranslation();
  const {
    fetchIssueWithIdentifier,
    issue: { getIssueById },
  } = useIssueDetail();
  const { getProjectById, getProjectByIdentifier } = useProject();
  const { toggleIssueDetailSidebar, issueDetailSidebarCollapsed } = useAppTheme();

  const [projectIdentifier, sequence_id] = workItem.split("-");

  // fetching issue details
  // `error` is deliberately not destructured — see the empty-state condition below.
  const { data, isLoading } = useSWR<TIssue, Error>(
    `ISSUE_DETAIL_${workspaceSlug}_${projectIdentifier}_${sequence_id}`,
    () => fetchIssueWithIdentifier(workspaceSlug.toString(), projectIdentifier, sequence_id)
  );

  // derived values
  const projectDetails = getProjectByIdentifier(projectIdentifier);
  const issueId = data?.id;
  const projectId = data?.project_id ?? projectDetails?.id ?? "";
  const issue = getIssueById(issueId?.toString() || "") || undefined;
  const project = (issue?.project_id && getProjectById(issue?.project_id)) || undefined;
  const issueLoader = !issue || isLoading;
  const pageTitle = project && issue ? `${project?.identifier}-${issue?.sequence_id} ${issue?.name}` : undefined;

  useWorkItemProperties(
    projectId,
    workspaceSlug.toString(),
    issueId,
    issue?.is_epic ? EIssueServiceType.EPICS : EIssueServiceType.ISSUES
  );

  useEffect(() => {
    const handleToggleIssueDetailSidebar = () => {
      if (window && window.innerWidth < 768) {
        toggleIssueDetailSidebar(true);
      }
      if (window && issueDetailSidebarCollapsed && window.innerWidth >= 768) {
        toggleIssueDetailSidebar(false);
      }
    };
    window.addEventListener("resize", handleToggleIssueDetailSidebar);
    handleToggleIssueDetailSidebar();
    return () => window.removeEventListener("resize", handleToggleIssueDetailSidebar);
  }, [issueDetailSidebarCollapsed, toggleIssueDetailSidebar]);

  useEffect(() => {
    if (data?.is_intake) {
      router.push(`/${workspaceSlug}/projects/${data.project_id}/intake/?currentTab=open&inboxIssueId=${data?.id}`);
    }
  }, [workspaceSlug, data, router]);

  // Keyed on "settled with no data", and deliberately NOT on SWR's `error` (APLANE-35).
  //
  // SWR's failure path sets `error` and leaves `data` in place — verified in the installed swr
  // 2.2.4: the catch assigns `finalState.error` and never touches data, with `isLoading` false.
  // WEB_SWR_CONFIG turns `revalidateOnFocus` on for every page, so a phone returning from the
  // background during a radio reconnect fails ONE revalidation, and an `error ||` here would
  // replace the work item the user was reading with a dead-end "does not exist" — unmounting the
  // detail root, losing their scroll position and any open editor — while the item sat right there
  // in `data`. In the common case that is worse than the bug this commit fixes, which is why
  // `error` is not in this condition.
  //
  // `!data` alone still catches everything that matters: a first load that failed, whatever shape
  // the failure took, including the falsy throw the service change above fixes.
  //
  // The cost, stated plainly: a work item DELETED while someone is viewing it now keeps showing
  // stale content until they navigate away. Telling that apart from a network blip needs the HTTP
  // status, which Plane's services destroy by convention (`throw error.response.data`) — the same
  // reason pinned-entity.service.ts bypasses that convention to keep the status for the sidebar.
  if (!isLoading && !data) {
    return (
      <EmptyState
        image={resolvedTheme === "dark" ? emptyIssueDark : emptyIssueLight}
        title={t("issue.empty_state.issue_detail.title")}
        description={t("issue.empty_state.issue_detail.description")}
        primaryButton={{
          text: t("issue.empty_state.issue_detail.primary_button.text"),
          onClick: () => router.push(`/${workspaceSlug}/workspace-views/all-issues/`),
        }}
      />
    );
  }

  if (issueLoader) {
    return (
      <Loader className="flex h-full gap-5 p-5">
        <div className="basis-2/3 space-y-2">
          <Loader.Item height="30px" width="40%" />
          <Loader.Item height="15px" width="60%" />
          <Loader.Item height="15px" width="60%" />
          <Loader.Item height="15px" width="40%" />
        </div>
        <div className="basis-1/3 space-y-3">
          <Loader.Item height="30px" />
          <Loader.Item height="30px" />
          <Loader.Item height="30px" />
          <Loader.Item height="30px" />
        </div>
      </Loader>
    );
  }

  return (
    <>
      <PageHead title={pageTitle} />
      {workspaceSlug && projectId && issueId && (
        <ProjectAuthWrapper workspaceSlug={workspaceSlug} projectId={projectId}>
          <WorkItemDetailRoot
            workspaceSlug={workspaceSlug.toString()}
            projectId={projectId.toString()}
            issueId={issueId.toString()}
            issue={issue}
          />
        </ProjectAuthWrapper>
      )}
    </>
  );
});

export default IssueDetailsPage;
