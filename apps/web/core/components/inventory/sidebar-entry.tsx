/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// The sidebar's shopping entry (plan, phase 5): first entry, with the to-buy counter, and a plain anchor,
// because /shopping/ is another app and must load in full, never through the router (S51).

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
import { inventoryLocale, inventoryT } from "./i18n";
import { useInventoryVisible, useShoppingCount } from "./visibility";

export const InventorySidebarEntry = observer(function InventorySidebarEntry() {
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString() ?? "";
  const visible = useInventoryVisible();
  const count = useShoppingCount(slug, visible);
  const { currentLocale } = useTranslation();
  if (!visible) return null;
  const label = inventoryT(inventoryLocale(currentLocale), "nav_shopping");
  return (
    <a href="/shopping/" data-testid="sidebar-shopping">
      <SidebarNavItem>
        <div className="flex items-center gap-1.5 py-[1px]">
          <ShoppingCart className="size-4 flex-shrink-0" />
          <p className="text-13 leading-5 font-medium">{label}</p>
        </div>
        {count !== null && count > 0 && (
          <span className="text-11 font-medium text-tertiary" data-testid="sidebar-shopping-count">
            {count}
          </span>
        )}
      </SidebarNavItem>
    </a>
  );
});
