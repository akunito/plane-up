/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { Package } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { getButtonStyling } from "@plane/propel/button";
import { Breadcrumbs, Header } from "@plane/ui";
import { CommonProjectBreadcrumbs } from "@/components/breadcrumbs/common";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { inventoryLocale, inventoryT } from "@/components/inventory/i18n";
import { shoppingHref } from "@/components/inventory/visibility";
import { useProject } from "@/hooks/store/use-project";

export const ProjectInventoryHeader = observer(function ProjectInventoryHeader() {
  const { workspaceSlug, projectId } = useParams();
  const { currentProjectDetails, loader } = useProject();
  const { currentLocale } = useTranslation();
  const locale = inventoryLocale(currentLocale);
  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs isLoading={loader === "init-loader"}>
          <CommonProjectBreadcrumbs workspaceSlug={workspaceSlug?.toString()} projectId={projectId?.toString()} />
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={inventoryT(locale, "page_title")}
                href={`/${workspaceSlug}/projects/${currentProjectDetails?.id}/inventory/`}
                icon={<Package className="h-4 w-4 text-tertiary" />}
                isLast
              />
            }
            isLast
          />
        </Breadcrumbs>
      </Header.LeftItem>
      <Header.RightItem>
        {/* A plain anchor: /shopping/ is another app, so a full page load, never the router (S51). */}
        <a href={shoppingHref(workspaceSlug?.toString() ?? "")} className={getButtonStyling("secondary", "lg")}>
          {inventoryT(locale, "open_app")}
        </a>
      </Header.RightItem>
    </Header>
  );
});
