/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EIssueLayoutTypes } from "@plane/types";
// hooks
import useSize from "@/hooks/use-window-size";

// Mobile breakpoint (matches the sidebar drawer behaviour).
const MOBILE_MAX_WIDTH = 768;

// Layouts that are effectively unusable on a phone-width screen (wide data grids
// / horizontal canvases). On small screens we transparently render List instead,
// without mutating the user's saved layout preference.
const MOBILE_UNSUPPORTED_LAYOUTS: Set<EIssueLayoutTypes | undefined> = new Set([
  EIssueLayoutTypes.SPREADSHEET,
  EIssueLayoutTypes.GANTT,
]);

/**
 * Returns the layout to actually render. On phone-width viewports, Spreadsheet and
 * Gantt fall back to List (fixes pages — e.g. saved Views — that "won't open" on
 * mobile because their saved layout overflows). Desktop is unaffected.
 */
export const useResponsiveIssueLayout = (layout: EIssueLayoutTypes | undefined): EIssueLayoutTypes | undefined => {
  const [width] = useSize();
  if (width > 0 && width < MOBILE_MAX_WIDTH && MOBILE_UNSUPPORTED_LAYOUTS.has(layout)) {
    return EIssueLayoutTypes.LIST;
  }
  return layout;
};
