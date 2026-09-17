/**
 * L1-01 / L1-02 — multiSortStore (B-27/B-28): secondary sort rules, kept PER VIEW and
 * persisted to localStorage. The store reads storage at import time, so each case
 * re-imports it after arranging localStorage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssueOrderByOptions } from "@plane/types";

const KEY = "plane_multi_sort_secondary_order_by_v2";
const LEGACY_KEY = "plane_multi_sort_secondary_order_by";

async function freshStore() {
  vi.resetModules();
  return import("@/store/issue/helpers/multi-sort.store");
}

const PROJECT = { workspaceSlug: "qa", projectId: "p1" };
const OTHER_PROJECT = { workspaceSlug: "qa", projectId: "p2" };
const CYCLE = { workspaceSlug: "qa", projectId: "p1", cycleId: "c1" };
const GLOBAL = { workspaceSlug: "qa", globalViewId: "all-issues" };

describe("scope keys (L1-01)", () => {
  it("one key per view, most specific id wins", async () => {
    const { multiSortScopeKey: key } = await freshStore();
    expect(key(PROJECT)).not.toBe(key(OTHER_PROJECT));
    expect(key(CYCLE)).not.toBe(key(PROJECT));
    expect(key({ ...PROJECT, moduleId: "m1" })).not.toBe(key(CYCLE));
    expect(key({ ...PROJECT, viewId: "v1" })).not.toBe(key(PROJECT));
    expect(key(GLOBAL)).not.toBe(key({ workspaceSlug: "qa", globalViewId: "assigned" }));
    expect(key({ workspaceSlug: "qa", profileId: "u1" } as never)).toBe(key({ workspaceSlug: "qa" }));
    // the same view always maps to the same key, and workspaces never collide
    expect(key(PROJECT)).toBe(key({ ...PROJECT }));
    expect(key(PROJECT)).not.toBe(key({ workspaceSlug: "other", projectId: "p1" }));
  });
});

describe("rules are per view (L1-01/L1-02)", () => {
  beforeEach(() => localStorage.clear());

  it("setting rules on one view leaves the others alone", async () => {
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    store.setSecondaryOrderBy(key(PROJECT), ["-priority"] as TIssueOrderByOptions[]);
    expect(store.secondaryOrderBy(key(PROJECT))).toEqual(["-priority"]);
    expect(store.secondaryOrderBy(key(OTHER_PROJECT))).toEqual([]);
    expect(store.secondaryOrderBy(key(CYCLE))).toEqual([]);
    expect(store.secondaryOrderBy(key(GLOBAL))).toEqual([]);
  });

  it("persists every view's rules and restores them", async () => {
    const first = await freshStore();
    const pk = first.multiSortScopeKey(PROJECT);
    const gk = first.multiSortScopeKey(GLOBAL);
    first.multiSortStore.setSecondaryOrderBy(pk, ["-priority", "target_date"] as TIssueOrderByOptions[]);
    first.multiSortStore.setSecondaryOrderBy(gk, ["project__name"] as TIssueOrderByOptions[]);
    const restored = await freshStore();
    expect(restored.multiSortStore.secondaryOrderBy(pk)).toEqual(["-priority", "target_date"]);
    expect(restored.multiSortStore.secondaryOrderBy(gk)).toEqual(["project__name"]);
  });

  it("truncates to two rules and drops a view's entry when cleared", async () => {
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    const pk = key(PROJECT);
    store.setSecondaryOrderBy(pk, ["-priority", "target_date", "start_date"] as TIssueOrderByOptions[]);
    expect(store.secondaryOrderBy(pk)).toEqual(["-priority", "target_date"]);
    store.setSecondaryOrderBy(pk, []);
    expect(store.secondaryOrderBy(pk)).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).not.toHaveProperty(pk);
  });

  it("replaces the map reference so observers fire (observable.ref)", async () => {
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    const before = store.byScope;
    store.setSecondaryOrderBy(key(PROJECT), ["-priority"] as TIssueOrderByOptions[]);
    expect(store.byScope).not.toBe(before);
  });

  it("survives invalid storage: bad JSON, an array, junk entries", async () => {
    localStorage.setItem(KEY, "{not json");
    expect((await freshStore()).multiSortStore.byScope).toEqual({});
    localStorage.setItem(KEY, JSON.stringify(["-priority"]));
    expect((await freshStore()).multiSortStore.byScope).toEqual({});
    localStorage.setItem(KEY, JSON.stringify({ "qa|project:p1": [1, "-priority", {}, "target_date"] }));
    const { multiSortStore: store } = await freshStore();
    expect(store.secondaryOrderBy("qa|project:p1")).toEqual(["-priority", "target_date"]);
  });

  it("still updates state when storage throws (quota)", async () => {
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const pk = key(PROJECT);
    expect(() => store.setSecondaryOrderBy(pk, ["-priority"] as TIssueOrderByOptions[])).not.toThrow();
    expect(store.secondaryOrderBy(pk)).toEqual(["-priority"]);
  });
});

describe("migration from the v1 global list (L1-01)", () => {
  beforeEach(() => localStorage.clear());

  it("v1 rules keep applying to every view until one gets its own", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["-priority"]));
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    expect(store.secondaryOrderBy(key(PROJECT))).toEqual(["-priority"]);
    expect(store.secondaryOrderBy(key(GLOBAL))).toEqual(["-priority"]);

    store.setSecondaryOrderBy(key(PROJECT), ["target_date"] as TIssueOrderByOptions[]);
    expect(store.secondaryOrderBy(key(PROJECT))).toEqual(["target_date"]);
    expect(store.secondaryOrderBy(key(GLOBAL))).toEqual(["-priority"]); // untouched views keep the old default
    expect(localStorage.getItem(LEGACY_KEY), "v1 key is retired once v2 is written").toBeNull();
  });

  it("v2 wins when both exist", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["-priority"]));
    localStorage.setItem(KEY, JSON.stringify({ "qa|project:p1": ["target_date"] }));
    const { multiSortStore: store, multiSortScopeKey: key } = await freshStore();
    expect(store.secondaryOrderBy(key(PROJECT))).toEqual(["target_date"]);
    expect(store.secondaryOrderBy(key(GLOBAL))).toEqual([]);
  });
});
