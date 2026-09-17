/**
 * L1-01 / L1-02 — multiSortStore (B-27/B-28): secondary sort rules, persisted to localStorage.
 * The store is a module singleton that reads storage at import time, so each case
 * re-imports it after arranging localStorage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "plane_multi_sort_secondary_order_by";

async function freshStore() {
  vi.resetModules();
  const mod = await import("@/store/issue/helpers/multi-sort.store");
  return mod.multiSortStore;
}

describe("multiSortStore load (L1-01)", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty with no stored value", async () => {
    expect((await freshStore()).secondaryOrderBy).toEqual([]);
  });

  it("restores one or two stored keys", async () => {
    localStorage.setItem(KEY, JSON.stringify(["-priority"]));
    expect((await freshStore()).secondaryOrderBy).toEqual(["-priority"]);
    localStorage.setItem(KEY, JSON.stringify(["-priority", "target_date"]));
    expect((await freshStore()).secondaryOrderBy).toEqual(["-priority", "target_date"]);
  });

  it("truncates more than two stored keys to two", async () => {
    localStorage.setItem(KEY, JSON.stringify(["-priority", "target_date", "-created_at"]));
    expect((await freshStore()).secondaryOrderBy).toEqual(["-priority", "target_date"]);
  });

  it("ignores invalid JSON", async () => {
    localStorage.setItem(KEY, "{not json");
    expect((await freshStore()).secondaryOrderBy).toEqual([]);
  });

  it("ignores JSON that is not an array", async () => {
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect((await freshStore()).secondaryOrderBy).toEqual([]);
  });
});

describe("multiSortStore.setSecondaryOrderBy (L1-02)", () => {
  beforeEach(() => localStorage.clear());

  it("persists the rules", async () => {
    const store = await freshStore();
    store.setSecondaryOrderBy(["-priority", "start_date"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["-priority", "start_date"]);
  });

  it("truncates to two rules, in state and in storage", async () => {
    const store = await freshStore();
    store.setSecondaryOrderBy(["-priority", "start_date", "target_date"]);
    expect(store.secondaryOrderBy).toEqual(["-priority", "start_date"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["-priority", "start_date"]);
  });

  it("still updates state when storage throws (quota)", async () => {
    const store = await freshStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => store.setSecondaryOrderBy(["-priority"])).not.toThrow();
    expect(store.secondaryOrderBy).toEqual(["-priority"]);
  });

  it("replaces the array reference so observers fire (observable.ref)", async () => {
    const store = await freshStore();
    const before = store.secondaryOrderBy;
    store.setSecondaryOrderBy(["-priority"]);
    expect(store.secondaryOrderBy).not.toBe(before);
  });
});
