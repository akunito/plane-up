/**
 * L1-19 — cross-project Board groups the loaded flat list by state group (B-18)
 * L1-20 — cross-project Calendar buckets the loaded flat list by target_date (B-19)
 * L1-14 — the "Then sort by" rules editor (B-27, B-30, B-31)
 *
 * Store hooks are mocked; the card list and the calendar chart are replaced by stubs
 * that expose what they were given, so the tests read the grouping, not the pixels.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssueOrderByOptions } from "@plane/types";

// ---------------------------------------------------------------- store mocks
const data = vi.hoisted(() => ({
  ids: [] as string[],
  issueMap: {} as Record<string, { id: string; state_id?: string | null; target_date?: string | null }>,
  states: {} as Record<string, { group: string }>,
  loader: undefined as string | undefined,
  total: 0,
  nextPage: false,
  fetchNextIssues: vi.fn(),
}));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({
    issueMap: data.issueMap,
    issuesFilter: {
      issueFilters: { displayFilters: { calendar: { layout: "month", show_weekends: true } }, displayProperties: {} },
    },
    issues: {
      groupedIssueIds: { "All Issues": data.ids },
      getIssueLoader: () => data.loader,
      getGroupIssueCount: () => data.total,
      getPaginationData: () => ({ nextPageResults: data.nextPage }),
    },
  }),
}));
vi.mock("@/hooks/use-issues-actions", () => ({
  useIssuesActions: () => ({ fetchNextIssues: data.fetchNextIssues, updateFilters: vi.fn() }),
}));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({ getStateById: (id: string) => data.states[id] }),
}));
vi.mock("@/hooks/store/use-calendar-view", () => ({ useCalendarView: () => ({}) }));
// the rules editor scopes rules by the route it is rendered on
const route = vi.hoisted(() => ({
  workspaceSlug: "qa" as string | undefined,
  projectId: "p1" as string | undefined,
  globalViewId: undefined as string | undefined,
}));
vi.mock("@/hooks/store/use-router-params", () => ({ useRouterParams: () => route }));

vi.mock("@/components/issues/issue-layouts/kanban/blocks-list", () => ({
  KanbanIssueBlocksList: (p: {
    groupId: string;
    issueIds: string[];
    canDropOverIssue: boolean;
    canDragIssuesInCurrentGrouping: boolean;
  }) => (
    <ul
      data-testid={`col-${p.groupId}`}
      data-drop={String(p.canDropOverIssue)}
      data-drag={String(p.canDragIssuesInCurrentGrouping)}
    >
      {p.issueIds.map((id) => (
        <li key={id}>{id}</li>
      ))}
    </ul>
  ),
}));
const calendarProps = vi.hoisted(() => ({ last: undefined as undefined | Record<string, unknown> }));
vi.mock("@/components/issues/issue-layouts/calendar/calendar", () => ({
  CalendarChart: (p: Record<string, unknown>) => {
    calendarProps.last = p;
    return <div data-testid="calendar" />;
  },
}));
vi.mock("@plane/i18n", async (orig) => ({
  ...(await orig<object>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { WorkspaceCalendarLayout } from "@/components/issues/issue-layouts/calendar/roots/workspace-root";
import { FilterOrderBy } from "@/components/issues/issue-layouts/filters/header/display-filters/order-by";
import { WorkspaceKanbanBoard } from "@/components/issues/issue-layouts/kanban/roots/workspace-root";
import { multiSortScopeKey, multiSortStore } from "@/store/issue/helpers/multi-sort.store";

const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"];

function seed(items: Array<[string, string | null, string | null]>) {
  data.ids = items.map(([id]) => id);
  data.issueMap = Object.fromEntries(
    items.map(([id, state, target]) => [id, { id, state_id: state, target_date: target }])
  );
  data.total = items.length;
}

beforeEach(() => {
  data.states = {
    s_b: { group: "backlog" },
    s_u: { group: "unstarted" },
    s_s: { group: "started" },
    s_c: { group: "completed" },
    s_x: { group: "cancelled" },
  };
  data.loader = undefined;
  data.nextPage = false;
  data.fetchNextIssues.mockReset();
});

// ---------------------------------------------------------------- L1-19
describe("global Board (L1-19)", () => {
  const column = (g: string) => screen.queryByTestId(`col-${g}`);
  const ids = (g: string) =>
    within(column(g)!)
      .queryAllByRole("listitem")
      .map((li) => li.textContent);

  it("renders the 5 state-group columns in order and puts each item in its group, keeping list order", () => {
    seed([
      ["i1", "s_s", null],
      ["i2", "s_b", null],
      ["i3", "s_s", null],
      ["i4", "s_c", null],
      ["i5", "s_u", null],
      ["i6", "s_x", null],
    ]);
    const { container } = render(<WorkspaceKanbanBoard />);
    const headers = [...container.querySelectorAll("span.text-sm.font-semibold")].map((h) => h.textContent);
    expect(headers).toHaveLength(5);
    expect(ids("started")).toEqual(["i1", "i3"]);
    expect(ids("backlog")).toEqual(["i2"]);
    expect(ids("unstarted")).toEqual(["i5"]);
    expect(ids("completed")).toEqual(["i4"]);
    expect(ids("cancelled")).toEqual(["i6"]);
    const order = [...container.querySelectorAll("ul[data-testid]")].map((u) => u.getAttribute("data-testid"));
    expect(order).toEqual(GROUP_ORDER.map((g) => `col-${g}`));
  });

  it("shows 'No status' only when an item's state is unknown (states not loaded)", () => {
    seed([["i1", "s_s", null]]);
    const { unmount } = render(<WorkspaceKanbanBoard />);
    expect(screen.queryByText("No status")).toBeNull();
    unmount();
    seed([
      ["i1", "s_s", null],
      ["i2", "s_unknown", null],
      ["i3", null, null],
    ]);
    render(<WorkspaceKanbanBoard />);
    expect(screen.getByText("No status")).toBeTruthy();
    expect(ids("__no_state__")).toEqual(["i2", "i3"]);
  });

  it("is read-only: no drag, no drop over cards", () => {
    seed([["i1", "s_s", null]]);
    render(<WorkspaceKanbanBoard />);
    expect(column("started")!.getAttribute("data-drag")).toBe("false");
    expect(column("started")!.getAttribute("data-drop")).toBe("false");
  });

  it("Load more shows loaded/total and pages the flat list; hidden without a next page", () => {
    seed([
      ["i1", "s_s", null],
      ["i2", "s_b", null],
    ]);
    data.total = 40;
    data.nextPage = true;
    const { unmount } = render(<WorkspaceKanbanBoard />);
    fireEvent.click(screen.getByRole("button", { name: "Load more (2/40)" }));
    expect(data.fetchNextIssues).toHaveBeenCalledTimes(1);
    unmount();
    data.nextPage = false;
    render(<WorkspaceKanbanBoard />);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("shows a skeleton while the first page loads", () => {
    seed([]);
    data.loader = "init-loader";
    const { container } = render(<WorkspaceKanbanBoard />);
    expect(container.querySelectorAll("ul[data-testid]")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- L1-20
describe("global Calendar (L1-20)", () => {
  it("buckets by YYYY-MM-DD, drops undated items, and is read-only", () => {
    seed([
      ["i1", "s_s", "2026-10-01"],
      ["i2", "s_s", "2026-10-01"],
      ["i3", "s_s", null],
      ["i4", "s_b", "2026-10-15"],
    ]);
    render(<WorkspaceCalendarLayout />);
    const p = calendarProps.last!;
    expect(p.groupedIssueIds).toEqual({ "2026-10-01": ["i1", "i2"], "2026-10-15": ["i4"] });
    expect(p.readOnly).toBe(true);
    expect((p.canEditProperties as (id: string) => boolean)("i1")).toBe(false);
    const count = p.getGroupIssueCount as (d?: string) => number;
    expect(count("2026-10-01")).toBe(2);
    expect(count("2026-10-02")).toBe(0);
    expect(count(undefined)).toBe(4);
    expect(p.showWeekends).toBe(true);
  });

  it("a datetime near midnight lands on its calendar date, not the UTC neighbour", () => {
    seed([
      ["late", "s_s", "2026-10-01T23:30:00+02:00"],
      ["plain", "s_s", "2026-10-02"],
    ]);
    render(<WorkspaceCalendarLayout />);
    const g = calendarProps.last!.groupedIssueIds as Record<string, string[]>;
    expect(Object.values(g).flat().sort()).toEqual(["late", "plain"]);
    expect(g["2026-10-02"]).toContain("plain");
  });
});

// ---------------------------------------------------------------- L1-14
describe("order-by rules editor (L1-14)", () => {
  const PROJECT_PAGE: TIssueOrderByOptions[] = [
    "-created_at",
    "-updated_at",
    "start_date",
    "-priority",
    "target_date",
  ] as TIssueOrderByOptions[];
  const GLOBAL_PAGE: TIssueOrderByOptions[] = [...PROJECT_PAGE, "project__name" as TIssueOrderByOptions];

  const scope = () => multiSortScopeKey(route);
  const rules = () => multiSortStore.secondaryOrderBy(scope());

  beforeEach(() => {
    localStorage.clear();
    route.projectId = "p1";
    route.globalViewId = undefined;
    multiSortStore.setSecondaryOrderBy(scope(), []);
  });

  const editor = (options: TIssueOrderByOptions[], primary = "-created_at") =>
    render(
      <FilterOrderBy
        selectedOrderBy={primary as TIssueOrderByOptions}
        handleUpdate={() => {}}
        orderByOptions={options}
        enableMultiSort
      />
    );
  const adders = () => screen.queryAllByRole("button", { name: /^\+ / }).map((b) => b.textContent);

  it("State is offered on a project page even though the layout does not list it; Project is not", () => {
    editor(PROJECT_PAGE);
    expect(adders()).toContain("+ common.state");
    expect(adders()).not.toContain("+ common.project");
  });

  it("Project is offered where the layout allows it (global views)", () => {
    editor(GLOBAL_PAGE);
    expect(adders()).toContain("+ common.project");
  });

  it("the primary field and manual order are never addable", () => {
    editor(GLOBAL_PAGE, "-priority");
    expect(adders()).not.toContain("+ common.priority");
    expect(adders().some((a) => /sort_order|manual/i.test(a!))).toBe(false);
  });

  it("adds up to two rules, then hides the adders; a used field is not offered twice", () => {
    const { rerender } = editor(GLOBAL_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "+ common.priority" }));
    expect(rules()).toEqual(["-priority"]);
    rerender(
      <FilterOrderBy
        selectedOrderBy={"-created_at" as TIssueOrderByOptions}
        handleUpdate={() => {}}
        orderByOptions={GLOBAL_PAGE}
        enableMultiSort
      />
    );
    expect(adders()).not.toContain("+ common.priority");
    fireEvent.click(screen.getByRole("button", { name: "+ common.project" }));
    expect(rules()).toEqual(["-priority", "project__name"]);
    expect(adders()).toEqual([]);
  });

  it("toggles direction, reorders within bounds and removes a rule", () => {
    multiSortStore.setSecondaryOrderBy(scope(), ["-priority", "project__name"] as TIssueOrderByOptions[]);
    editor(GLOBAL_PAGE);
    const up = screen.getAllByRole("button", { name: "Move up" });
    const down = screen.getAllByRole("button", { name: "Move down" });
    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    expect((down[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle sort direction" })[1]);
    expect(rules()).toEqual(["-priority", "-project__name"]);
    fireEvent.click(down[0]);
    expect(rules()).toEqual(["-project__name", "-priority"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove sort rule" })[0]);
    expect(rules()).toEqual(["-priority"]);
  });

  it("writes rules to the view it is rendered on (per-view scope)", () => {
    const projectScope = multiSortScopeKey({ workspaceSlug: "qa", projectId: "p1" });
    const onProject = editor(GLOBAL_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "+ common.priority" }));
    expect(multiSortStore.secondaryOrderBy(projectScope)).toEqual(["-priority"]);

    // same component, different route → its own rules, the project's untouched
    route.projectId = undefined;
    route.globalViewId = "all-issues";
    const globalScope = multiSortScopeKey({ workspaceSlug: "qa", globalViewId: "all-issues" });
    expect(multiSortStore.secondaryOrderBy(globalScope)).toEqual([]);
    onProject.unmount(); // otherwise the stale editor (bound to the project scope) takes the click
    editor(GLOBAL_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "+ common.project" }));
    expect(multiSortStore.secondaryOrderBy(globalScope)).toEqual(["project__name"]);
    expect(multiSortStore.secondaryOrderBy(projectScope)).toEqual(["-priority"]);
  });

  it("without enableMultiSort there is no rules editor", () => {
    render(
      <FilterOrderBy
        selectedOrderBy={"-created_at" as TIssueOrderByOptions}
        handleUpdate={() => {}}
        orderByOptions={GLOBAL_PAGE}
      />
    );
    expect(screen.queryByText("Then sort by")).toBeNull();
  });
});
