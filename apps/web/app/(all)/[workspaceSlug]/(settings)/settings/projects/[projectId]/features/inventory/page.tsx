/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { PageHead } from "@/components/core/page-title";
import { inventoryLocale, inventoryT } from "@/components/inventory/i18n";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { SettingsHeading } from "@/components/settings/heading";
import { ProjectSettingsFeatureControlItem } from "@/components/settings/project/content/feature-control-item";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import type { Route } from "./+types/page";
import { FeaturesInventoryProjectSettingsHeader } from "./header";

function FeaturesInventorySettingsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug, projectId } = params;
  const { workspaceUserInfo, allowPermissions } = useUserPermissions();
  const { currentProjectDetails } = useProject();
  const { currentLocale } = useTranslation();
  const locale = inventoryLocale(currentLocale);
  const pageTitle = currentProjectDetails?.name
    ? `${currentProjectDetails.name} settings - ${inventoryT(locale, "feature_title")}`
    : undefined;
  const canPerformProjectAdminActions = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.PROJECT);

  if (workspaceUserInfo && !canPerformProjectAdminActions) {
    return <NotAuthorizedView section="settings" isProjectView className="h-auto" />;
  }

  return (
    <SettingsContentWrapper header={<FeaturesInventoryProjectSettingsHeader />}>
      <PageHead title={pageTitle} />
      <section className="w-full">
        <SettingsHeading
          title={inventoryT(locale, "feature_title")}
          description={inventoryT(locale, "feature_description")}
        />
        <div className="mt-7">
          <ProjectSettingsFeatureControlItem
            title={inventoryT(locale, "feature_toggle_title")}
            description={inventoryT(locale, "feature_toggle_description")}
            featureProperty="inventory_view"
            projectId={projectId}
            value={!!currentProjectDetails?.inventory_view}
            workspaceSlug={workspaceSlug}
          />
        </div>
      </section>
    </SettingsContentWrapper>
  );
}

export default observer(FeaturesInventorySettingsPage);
