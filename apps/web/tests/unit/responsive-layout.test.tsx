/**
 * L1-12 — useResponsiveIssueLayout (B-13): below 768px Spreadsheet and Gantt render as
 * List; every other layout, and every layout on wider screens, is left untouched.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EIssueLayoutTypes } from "@plane/types";
import { useResponsiveIssueLayout } from "@/hooks/use-responsive-issue-layout";

const LAYOUTS = [
  EIssueLayoutTypes.LIST,
  EIssueLayoutTypes.KANBAN,
  EIssueLayoutTypes.CALENDAR,
  EIssueLayoutTypes.SPREADSHEET,
  EIssueLayoutTypes.GANTT,
  undefined,
];
const MOBILE_FALLBACK = new Set([EIssueLayoutTypes.SPREADSHEET, EIssueLayoutTypes.GANTT]);

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

describe("useResponsiveIssueLayout (L1-12)", () => {
  for (const width of [0, 320, 767, 768, 1440]) {
    for (const layout of LAYOUTS) {
      const expected = width > 0 && width < 768 && MOBILE_FALLBACK.has(layout!) ? EIssueLayoutTypes.LIST : layout;
      it(`width ${width} · ${layout ?? "undefined"} → ${expected ?? "undefined"}`, () => {
        setWidth(width);
        const { result } = renderHook(() => useResponsiveIssueLayout(layout));
        expect(result.current).toBe(expected);
      });
    }
  }

  it("follows a resize across the 768px breakpoint without touching the saved layout", () => {
    setWidth(1440);
    const saved = EIssueLayoutTypes.SPREADSHEET;
    const { result } = renderHook(() => useResponsiveIssueLayout(saved));
    expect(result.current).toBe(EIssueLayoutTypes.SPREADSHEET);
    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(EIssueLayoutTypes.LIST);
    act(() => {
      setWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(EIssueLayoutTypes.SPREADSHEET);
    expect(saved).toBe(EIssueLayoutTypes.SPREADSHEET);
  });
});
