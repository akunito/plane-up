/**
 * L1-03…L1-09 — frontend multi-sort in BaseIssuesStore (B-27, B-30, B-31).
 *
 * The store is built against a hand-made root store (only what sorting reads). An
 * independent oracle below re-states Plane's ordering rules, so the matrix tests check
 * the result is really ordered — not merely that two code paths agree.
 */
import { orderBy } from "lodash-es";
import { beforeEach, describe, expect, it } from "vitest";
import type { TIssue, TIssueOrderByOptions } from "@plane/types";
// Load the store context first, as the app does: base-issues.store sits in an import cycle
// (store-context → root store → archived store `extends BaseIssuesStore`) that only resolves in this order.
import "@/lib/store-context";
import { BaseIssuesStore } from "@/store/issue/helpers/base-issues.store";
import { multiSortScopeKey, multiSortStore } from "@/store/issue/helpers/multi-sort.store";

// ---------------------------------------------------------------- fixture
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const states: Record<string, { name: string; group: string }> = {
  s1: { name: "Todo", group: "unstarted" },
  s2: { name: "in progress", group: "started" },
  s3: { name: "Done", group: "completed" },
};
const projects: Record<string, { name: string }> = {
  p1: { name: "alpha" },
  p2: { name: "Beta" },
  p3: { name: "gamma" },
};
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;

// 16 items with deliberate ties on every key; created_at is unique (the base order).
const ISSUES: TIssue[] = Array.from({ length: 16 }, (_, i) => ({
  id: `i${String(i).padStart(2, "0")}`,
  name: `item ${i}`,
  priority: PRIORITIES[i % 5],
  state_id: `s${(i % 3) + 1}`,
  project_id: `p${((i * 7) % 3) + 1}`,
  created_at: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
  updated_at: `2026-09-${String(((i * 5) % 16) + 1).padStart(2, "0")}T10:00:00Z`,
  start_date: i % 4 === 0 ? null : day((i % 3) + 1),
  target_date: i % 5 === 2 ? null : day((i % 4) + 10),
  sort_order: 1000 - i * 10,
  label_ids: i % 2 ? ["l1"] : [],
  assignee_ids: [],
  module_ids: [],
  cycle_id: null,
})) as unknown as TIssue[];
const byId = Object.fromEntries(ISSUES.map((i) => [i.id, i]));

class TestIssuesStore extends BaseIssuesStore {
  fetchParentStats = () => {};
  updateParentStats = () => {};
}

const SCOPE = multiSortScopeKey({ workspaceSlug: "qa", projectId: "p-test" });

function makeStore(primary?: TIssueOrderByOptions, opts: { projectMap?: unknown } = {}) {
  const rootIssueStore = {
    workspaceSlug: "qa",
    projectId: "p-test",
    issues: { getIssuesByIds: (ids: string[]) => ids.map((id) => byId[id]).filter(Boolean), issuesMap: byId },
    stateMap: states,
    projectMap: "projectMap" in opts ? opts.projectMap : projects,
    labelMap: { l1: { name: "bug" } },
    memberMap: {},
    moduleMap: {},
    cycleMap: {},
    rootStore: { state: { stateMap: states } },
  };
  const filters = { issueFilters: { displayFilters: { order_by: primary, layout: "list" } } };
  return new TestIssuesStore(rootIssueStore as never, filters as never);
}

// ---------------------------------------------------------------- oracle
type Key = TIssueOrderByOptions;
const base = (k: string) => (k.startsWith("-") ? k.slice(1) : k);
const isDesc = (k: string) => k.startsWith("-");

/** [emptyRank, value] — empty values sort last in BOTH directions (Plane's rule). */
function oracleValue(issue: TIssue, key: Key): [number, string | number] {
  switch (base(key)) {
    case "created_at":
    case "updated_at":
      return [0, new Date(issue[base(key) as "created_at"]).toISOString()];
    case "start_date":
    case "target_date": {
      const v = issue[base(key) as "start_date"];
      return v ? [0, v] : [1, ""];
    }
    case "priority":
      return [0, PRIORITIES.indexOf(issue.priority as (typeof PRIORITIES)[number])];
    case "state__name":
      return [0, states[issue.state_id!].name.toLowerCase()];
    case "project__name":
      return [0, projects[issue.project_id!].name.toLowerCase()];
    default:
      throw new Error(`oracle has no rule for ${key}`);
  }
}

/** Direction on the value. Plane's "-priority" means urgent first (ascending index). */
function valueDescending(key: Key) {
  if (base(key) === "priority") return !isDesc(key);
  return isDesc(key);
}

function compare(a: TIssue, b: TIssue, keys: Key[]): number {
  for (const key of keys) {
    const [ea, va] = oracleValue(a, key);
    const [eb, vb] = oracleValue(b, key);
    if (ea !== eb) return ea - eb;
    if (va !== vb) return (va < vb ? -1 : 1) * (valueDescending(key) ? -1 : 1);
  }
  // full tie → the created_at-desc base order is kept (stable sort)
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

function expectOrdered(ids: string[], keys: Key[]) {
  expect(ids).toHaveLength(ISSUES.length);
  for (let i = 1; i < ids.length; i++) {
    const c = compare(byId[ids[i - 1]], byId[ids[i]], keys);
    if (c > 0) throw new Error(`[${keys.join(", ")}] out of order at ${i}: ${ids[i - 1]} before ${ids[i]}`);
  }
}

const ORACLE_KEYS: Key[] = [
  "created_at",
  "-created_at",
  "updated_at",
  "-updated_at",
  "start_date",
  "-start_date",
  "target_date",
  "-target_date",
  "priority",
  "-priority",
  "state__name",
  "-state__name",
  "project__name",
  "-project__name",
] as Key[];
const ALL_KEYS: Key[] = [
  ...ORACLE_KEYS,
  "sort_order",
  "assignees__first_name",
  "-assignees__first_name",
  "labels__name",
  "-labels__name",
  "issue_module__module__name",
  "-issue_module__module__name",
  "issue_cycle__cycle__name",
  "-issue_cycle__cycle__name",
  "estimate_point__key",
  "-estimate_point__key",
  "link_count",
  "-link_count",
  "attachment_count",
  "-attachment_count",
  "sub_issues_count",
  "-sub_issues_count",
] as Key[];
const ids = ISSUES.map((i) => i.id);

beforeEach(() => {
  localStorage.clear();
  multiSortStore.setSecondaryOrderBy(SCOPE, []);
});

describe("getSortDescriptor (L1-03)", () => {
  it("has a descriptor for every order-by key", () => {
    const store = makeStore();
    const missing = ALL_KEYS.filter((k) => store.getSortDescriptor(k) === null);
    expect(missing).toEqual([]);
  });

  it("returns null for keys it does not know", () => {
    expect(makeStore().getSortDescriptor("not_a_key" as Key)).toBeNull();
  });
});

describe("descriptor ≡ Plane's single-key sort (L1-04)", () => {
  it.each(ALL_KEYS)("%s", (key) => {
    const store = makeStore();
    const d = store.getSortDescriptor(key)!;
    const baseOrder = orderBy(ISSUES, (i) => new Date(i.created_at).toISOString(), ["desc"]);
    const viaDescriptor = orderBy(baseOrder, d.iteratees as never, d.orders).map((i) => i.id);
    expect(viaDescriptor).toEqual(store.issuesSortWithOrderBy(ids, key));
  });
});

describe("multi-key ordering matrix (L1-05)", () => {
  it("single keys are ordered", () => {
    const store = makeStore();
    for (const k of ORACLE_KEYS) expectOrdered(store.issuesSortWithMultipleOrderBy(ids, [k]), [k]);
  });

  it("primary × secondary × tertiary (distinct fields, both directions)", () => {
    const store = makeStore();
    let combos = 0;
    for (const p of ORACLE_KEYS)
      for (const s1 of ORACLE_KEYS.filter((k) => base(k) !== base(p)))
        for (const s2 of ORACLE_KEYS.filter((k) => base(k) !== base(p) && base(k) !== base(s1))) {
          expectOrdered(store.issuesSortWithMultipleOrderBy(ids, [p, s1, s2]), [p, s1, s2]);
          combos++;
        }
    expect(combos).toBe(14 * 12 * 10);
  });

  it("the secondary key actually changes the order within primary ties", () => {
    const store = makeStore();
    const a = store.issuesSortWithMultipleOrderBy(ids, ["-priority", "target_date"] as Key[]);
    const b = store.issuesSortWithMultipleOrderBy(ids, ["-priority", "-target_date"] as Key[]);
    expect(a).not.toEqual(b);
  });
});

describe("empty values (L1-06)", () => {
  it.each(["start_date", "-start_date", "target_date", "-target_date"] as Key[])("%s puts empties last", (k) => {
    const sorted = makeStore().issuesSortWithMultipleOrderBy(ids, ["-priority", k] as Key[]);
    // within each priority group, no dated item may follow an undated one
    const field = base(k) as "start_date";
    for (let i = 1; i < sorted.length; i++) {
      const prev = byId[sorted[i - 1]],
        cur = byId[sorted[i]];
      if (prev.priority === cur.priority && !prev[field]) expect(cur[field]).toBeFalsy();
    }
  });
});

describe("unknown keys in the chain (L1-07)", () => {
  it("are ignored; the remaining keys still apply", () => {
    const store = makeStore();
    const withJunk = store.issuesSortWithMultipleOrderBy(ids, ["-priority", "bogus" as Key, "target_date"] as Key[]);
    expect(withJunk).toEqual(store.issuesSortWithMultipleOrderBy(ids, ["-priority", "target_date"] as Key[]));
  });

  it("undefined keys are dropped (no primary order_by set)", () => {
    const store = makeStore();
    expect(store.issuesSortWithMultipleOrderBy(ids, [undefined, "-priority"])).toEqual(
      store.issuesSortWithOrderBy(ids, "-priority")
    );
  });
});

describe("project sort (L1-08, B-31)", () => {
  it("is case-insensitive", () => {
    const sorted = makeStore().issuesSortWithOrderBy(ids, "project__name" as Key);
    const names = sorted.map((id) => projects[byId[id].project_id!].name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it("does not throw without a project map or with an unknown project", () => {
    expect(() =>
      makeStore(undefined, { projectMap: undefined }).issuesSortWithOrderBy(ids, "project__name" as Key)
    ).not.toThrow();
    expect(() =>
      makeStore(undefined, { projectMap: { p1: projects.p1 } }).issuesSortWithOrderBy(ids, "-project__name" as Key)
    ).not.toThrow();
  });
});

describe("sortIds + reapplyMultiSort (L1-09)", () => {
  it("sortIds chains the persisted primary with the active secondary rules", () => {
    const store = makeStore("-priority" as Key);
    multiSortStore.setSecondaryOrderBy(SCOPE, ["project__name", "-target_date"] as Key[]);
    expectOrdered(store.sortIds(ids), ["-priority", "project__name", "-target_date"] as Key[]);
  });

  it("re-sorts a flat list when the rules change (reaction)", () => {
    const store = makeStore("-priority" as Key);
    store.groupedIssueIds = { "All Issues": [...ids] } as never;
    multiSortStore.setSecondaryOrderBy(SCOPE, ["state__name"] as Key[]);
    expectOrdered((store.groupedIssueIds as Record<string, string[]>)["All Issues"], [
      "-priority",
      "state__name",
    ] as Key[]);
  });

  it("re-sorts grouped and sub-grouped lists", () => {
    const store = makeStore("-priority" as Key);
    const half = ids.slice(0, 8),
      rest = ids.slice(8);
    store.groupedIssueIds = { g1: [...half], g2: { sg1: [...rest] } } as never;
    multiSortStore.setSecondaryOrderBy(SCOPE, ["-target_date"] as Key[]);
    const g = store.groupedIssueIds as unknown as { g1: string[]; g2: { sg1: string[] } };
    const check = (list: string[]) => {
      for (let i = 1; i < list.length; i++)
        expect(compare(byId[list[i - 1]], byId[list[i]], ["-priority", "-target_date"] as Key[])).toBeLessThanOrEqual(
          0
        );
    };
    check(g.g1);
    check(g.g2.sg1);
    expect(new Set([...g.g1, ...g.g2.sg1])).toEqual(new Set(ids));
  });

  it("rules set on another view do not re-sort this one (per-view scope)", () => {
    const store = makeStore("-priority" as Key);
    store.groupedIssueIds = { "All Issues": [...ids] } as never;
    const before = [...((store.groupedIssueIds as Record<string, string[]>)["All Issues"] ?? [])];
    multiSortStore.setSecondaryOrderBy(multiSortScopeKey({ workspaceSlug: "qa", projectId: "other" }), [
      "state__name",
    ] as Key[]);
    expect((store.groupedIssueIds as Record<string, string[]>)["All Issues"]).toEqual(before);
    expect(store.multiSortScope).toBe(SCOPE);
  });

  it("is a no-op without loaded ids", () => {
    const store = makeStore("-priority" as Key);
    store.groupedIssueIds = undefined as never;
    expect(() => multiSortStore.setSecondaryOrderBy(SCOPE, ["state__name"] as Key[])).not.toThrow();
  });
});
