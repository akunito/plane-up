/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { observer } from "mobx-react";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EUserProjectRoles } from "@plane/types";
import { PageHead } from "@/components/core/page-title";
import { makeInventoryT } from "@/components/inventory/i18n";
import { ProjectInventoryRoot } from "@/components/inventory/project/root";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import type { Route } from "./+types/page";

function ProjectInventoryPage({ params }: Route.ComponentProps) {
  const { workspaceSlug, projectId } = params;
  const router = useAppRouter();
  const { currentLocale } = useTranslation();
  // Stable: the loaders depend on it, and a new function per render would reload for ever.
  const t = useMemo(() => makeInventoryT(currentLocale), [currentLocale]);
  const { getProjectById, currentProjectDetails } = useProject();
  const { allowPermissions } = useUserPermissions();
  const project = getProjectById(projectId);
  const isAdmin = allowPermissions([EUserProjectRoles.ADMIN], EUserPermissionsLevel.PROJECT);

  if (currentProjectDetails?.inventory_view === false)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-16 font-medium text-primary">{t("disabled_title")}</h2>
        <p className="text-13 text-tertiary">{t("disabled_description")}</p>
        <Button
          variant="primary"
          size="lg"
          disabled={!isAdmin}
          onClick={() => router.push(`/${workspaceSlug}/settings/projects/${projectId}/features/inventory`)}
        >
          {t("disabled_button")}
        </Button>
      </div>
    );

  return (
    <>
      <PageHead title={project?.name ? `${project.name} - ${t("page_title")}` : undefined} />
      <ProjectInventoryRoot workspaceSlug={workspaceSlug} projectId={projectId} t={t} />
    </>
  );
}

export default observer(ProjectInventoryPage);
