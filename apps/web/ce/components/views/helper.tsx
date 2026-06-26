/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { IProjectView } from "@plane/types";
import { EIssueLayoutTypes } from "@plane/types";
import { LayoutSelection } from "@/components/issues/issue-layouts/filters/header/layout-selection";
import type { TWorkspaceLayoutProps } from "@/components/views/helper";

export type TLayoutSelectionProps = {
  onChange: (layout: EIssueLayoutTypes) => void;
  selectedLayout: EIssueLayoutTypes;
  workspaceSlug: string;
};

// Layouts available on the global/workspace views. Upstream OSS leaves this empty (Board is
// Enterprise-stubbed); this fork enables Spreadsheet + List + a cross-project read-only Board.
const GLOBAL_VIEW_LAYOUTS = [EIssueLayoutTypes.SPREADSHEET, EIssueLayoutTypes.LIST, EIssueLayoutTypes.KANBAN];

export function GlobalViewLayoutSelection(props: TLayoutSelectionProps) {
  const { onChange, selectedLayout } = props;
  return <LayoutSelection layouts={GLOBAL_VIEW_LAYOUTS} onChange={onChange} selectedLayout={selectedLayout} />;
}

export function WorkspaceAdditionalLayouts(_props: TWorkspaceLayoutProps) {
  return <></>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function AdditionalHeaderItems(view: IProjectView) {
  return <></>;
}
