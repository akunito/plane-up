/**
 * L1-24 — constants the fork depends on (B-22, B-29, B-30, B-31). These live in shared
 * packages, where an unrelated edit could silently drop an entry.
 */
import { describe, expect, it } from "vitest";
import { ISSUE_DISPLAY_FILTERS_BY_PAGE, ISSUE_ORDER_BY_OPTIONS } from "@plane/constants";
import { EIssueLayoutTypes } from "@plane/types";
import { GLOBAL_VIEW_LAYOUTS } from "@/plane-web/components/views/helper";

describe("constants contract (L1-24)", () => {
  it("order-by options include State (everywhere) and Project (global views)", () => {
    const keys = ISSUE_ORDER_BY_OPTIONS.map((o) => o.key);
    expect(keys).toContain("-state__name");
    expect(keys).toContain("project__name");
  });

  it("global views offer exactly Table, Board and Calendar", () => {
    expect(GLOBAL_VIEW_LAYOUTS).toEqual([
      EIssueLayoutTypes.SPREADSHEET,
      EIssueLayoutTypes.KANBAN,
      EIssueLayoutTypes.CALENDAR,
    ]);
  });

  it("my_issues (global views) configures spreadsheet, list, kanban and calendar", () => {
    const layouts = ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions;
    for (const layout of ["spreadsheet", "list", "kanban", "calendar"] as const)
      expect(layouts[layout], layout).toBeDefined();
  });

  it("global spreadsheet/list/kanban allow ordering by project; project pages do not", () => {
    const my = ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions;
    for (const layout of ["spreadsheet", "list", "kanban"] as const)
      expect(my[layout]?.display_filters.order_by, layout).toContain("project__name");
    const issues = ISSUE_DISPLAY_FILTERS_BY_PAGE.issues.layoutOptions;
    for (const opts of Object.values(issues))
      expect(opts?.display_filters.order_by ?? []).not.toContain("project__name");
  });

  it("the global kanban groups by state group only", () => {
    expect(ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions.kanban?.display_filters.group_by).toEqual([
      "state_detail.group",
    ]);
  });
});
