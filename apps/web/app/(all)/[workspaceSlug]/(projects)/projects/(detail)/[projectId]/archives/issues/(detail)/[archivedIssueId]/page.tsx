/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
// ui
import { Banner } from "@plane/propel/banner";
import { Button } from "@plane/propel/button";
import { ArchiveIcon } from "@plane/propel/icons";
import { Loader } from "@plane/ui";
// assets
import emptyIssueDark from "@/app/assets/empty-state/search/issues-dark.webp?url";
import emptyIssueLight from "@/app/assets/empty-state/search/issues-light.webp?url";
// components
import { EmptyState } from "@/components/common/empty-state";
import { PageHead } from "@/components/core/page-title";
import { IssueDetailRoot } from "@/components/issues/issue-detail";
// constants
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import type { Route } from "./+types/page";

function ArchivedIssueDetailsPage({ params }: Route.ComponentProps) {
  // router
  const { workspaceSlug, projectId, archivedIssueId } = params;
  const router = useRouter();
  // states
  // hooks
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const {
    fetchIssue,
    issue: { getIssueById },
  } = useIssueDetail();

  const { getProjectById } = useProject();

  const { isLoading } = useSWR(`ARCHIVED_ISSUE_DETAIL_${workspaceSlug}_${projectId}_${archivedIssueId}`, () =>
    fetchIssue(workspaceSlug, projectId, archivedIssueId)
  );

  // derived values
  const issue = getIssueById(archivedIssueId);
  const project = issue ? getProjectById(issue?.project_id ?? "") : undefined;
  const pageTitle = project && issue ? `${project?.identifier}-${issue?.sequence_id} ${issue?.name}` : undefined;

  // Settled with no work item: the sibling of the APLANE-35 fix, on the route nobody reported.
  //
  // This was `if (!issue) return <></>` — an EMPTY WHITE PAGE, with no skeleton, no message and no
  // way out, for a 404, a permission error and (since the services threw `undefined` with no
  // response) every network failure.
  //
  // Which failures that actually covers is narrower than it looks, and worth knowing: `issue` is
  // read from the SHARED issues map, and the archives list writes into it
  // (base-issues.store.ts:482; its `clear()` drops only grouping and pagination, never the map).
  // So arriving from the list, the item is already there on the first render — the old `!issue` was
  // false and the skeleton below did render. This empty state is reached on a cold load: a deep
  // link, a refresh, or a shared URL. The flip side of the same fact is that on the list path the
  // detail renders from the list's copy even when the detail fetch fails, which is stale rather
  // than wrong, and is the better of the two outcomes.
  //
  // Keyed on `!issue` and deliberately NOT on SWR's error (APLANE-35): the store keeps the loaded
  // item when a later revalidation fails, so an `error ||` here would throw away a work item the
  // user is reading over a single blip.
  if (!isLoading && !issue) {
    return (
      <EmptyState
        image={resolvedTheme === "dark" ? emptyIssueDark : emptyIssueLight}
        title={t("issue.empty_state.issue_detail.title")}
        description={t("issue.empty_state.issue_detail.description")}
        primaryButton={{
          text: t("issue.empty_state.issue_detail.primary_button.text"),
          // Same destination as the sibling route, because it is the same label in all 19 locales:
          // "View other work items". Sending it to the archives list instead — which is where this
          // route is reached from, and was my first instinct — would have made the button say one
          // thing and do another.
          onClick: () => router.push(`/${workspaceSlug}/workspace-views/all-issues/`),
        }}
      />
    );
  }

  const issueLoader = !issue || isLoading;

  return (
    <>
      <PageHead title={pageTitle} />
      {issueLoader ? (
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
      ) : (
        <>
          <Banner
            variant="warning"
            title="This work item has been archived. Visit the Archives section to restore it."
            icon={<ArchiveIcon className="size-4" />}
            action={
              <Button
                variant="secondary"
                onClick={() => router.push(`/${workspaceSlug}/projects/${projectId}/archives/issues/`)}
              >
                Go to archives
              </Button>
            }
            className="border-b border-subtle"
          />
          <div className="flex h-full overflow-hidden">
            <div className="h-full w-full space-y-3 divide-y-2 divide-subtle-1 overflow-y-auto">
              <IssueDetailRoot
                workspaceSlug={workspaceSlug}
                projectId={projectId}
                issueId={archivedIssueId}
                is_archived
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default observer(ArchivedIssueDetailsPage);
