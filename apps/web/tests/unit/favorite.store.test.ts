/**
 * L1-10 / L1-11 — FavoriteStore reorder math + dedupe on fetch (B-01).
 * The service is replaced with mocks; nothing leaves the process.
 */
import { orderBy } from "lodash-es";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IFavorite } from "@plane/types";
import { FavoriteStore } from "@/store/favorite.store";

const SLUG = "qa";
// only what the FavoriteStore constructor dereferences
const ROOT = { projectRoot: { project: {} }, projectView: {}, module: {}, cycle: {}, projectPages: {} };

function fav(id: string, sequence: number, extra: Partial<IFavorite> = {}): IFavorite {
  return {
    id,
    sequence,
    name: id,
    entity_type: "project",
    entity_identifier: `e-${id}`,
    is_folder: false,
    parent: null,
    ...extra,
  } as IFavorite;
}

function makeStore(favs: IFavorite[]) {
  const store = new FavoriteStore(ROOT as never);
  const service = {
    updateFavorite: vi.fn(async () => ({})),
    getFavorites: vi.fn(async () => favs),
  };
  store.favoriteService = service as never;
  for (const f of favs) {
    store.favoriteMap[f.id] = { ...f };
    store.favoriteIds.push(f.id);
  }
  return { store, service };
}

/** ids as the sidebar shows them: sequence high → low */
const shown = (store: FavoriteStore) => orderBy(Object.values(store.favoriteMap), "sequence", "desc").map((f) => f.id);

describe("reOrderFavorite (L1-10)", () => {
  // shown order: a(40000) b(30000) c(20000) d(10000)
  let store: FavoriteStore;
  let service: { updateFavorite: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    ({ store, service } = makeStore([fav("a", 40000), fav("b", 30000), fav("c", 20000), fav("d", 10000)]));
  });

  it("moves an item above a middle destination (between it and its upper neighbour)", async () => {
    await store.reOrderFavorite(SLUG, "d", "b", "reorder-above");
    expect(shown(store)).toEqual(["a", "d", "b", "c"]);
    expect(service.updateFavorite).toHaveBeenCalledWith(SLUG, "d", { sequence: 35000 });
  });

  it("moves an item below a middle destination (between it and its lower neighbour)", async () => {
    await store.reOrderFavorite(SLUG, "a", "b", "reorder-below");
    expect(shown(store)).toEqual(["b", "a", "c", "d"]);
    expect(service.updateFavorite).toHaveBeenCalledWith(SLUG, "a", { sequence: 25000 });
  });

  it("above the top item → destination + GAP", async () => {
    await store.reOrderFavorite(SLUG, "c", "a", "reorder-above");
    expect(shown(store)).toEqual(["c", "a", "b", "d"]);
    expect(store.favoriteMap.c.sequence).toBe(50000);
  });

  it("below the bottom item → destination − GAP", async () => {
    await store.reOrderFavorite(SLUG, "a", "d", "reorder-below");
    expect(shown(store)).toEqual(["b", "c", "d", "a"]);
    expect(store.favoriteMap.a.sequence).toBe(0);
  });

  it("does not use the moved item as its own neighbour (the upstream bug)", async () => {
    // c is directly below b: moving c below b must keep c between b and d, not jump
    await store.reOrderFavorite(SLUG, "c", "b", "reorder-below");
    expect(shown(store)).toEqual(["a", "b", "c", "d"]);
    expect(store.favoriteMap.c.sequence).toBe(20000);
  });

  it("handles a destination whose sequence is 0 (falsy but defined)", async () => {
    ({ store } = makeStore([fav("a", 10000), fav("z", 0)]));
    await store.reOrderFavorite(SLUG, "a", "z", "reorder-below");
    expect(shown(store)).toEqual(["z", "a"]);
    expect(store.favoriteMap.a.sequence).toBe(-10000);
  });

  it("single favourite: no edge → GAP, nothing breaks", async () => {
    ({ store } = makeStore([fav("a", 123)]));
    await store.reOrderFavorite(SLUG, "a", "a", undefined);
    expect(store.favoriteMap.a.sequence).toBe(10000);
  });

  it("does not change local state when the API call fails", async () => {
    service.updateFavorite.mockRejectedValueOnce(new Error("500"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(store.reOrderFavorite(SLUG, "d", "b", "reorder-above")).rejects.toThrow("500");
    expect(shown(store)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a strict order through many repeated midpoint moves into the same gap", async () => {
    // Repeatedly drop the bottom item right below `a` — each move halves the a/next gap.
    // Measured limit (2026-09-17): the 51st consecutive move into the SAME gap collides
    // (IEEE-754: 10000 / 2^51 is below the float step at 4e4). 50 is what we guarantee;
    // a renormalisation pass would lift it if it ever matters.
    const moves = 50;
    for (let i = 0; i < moves; i++) {
      const bottom = shown(store).at(-1)!;
      await store.reOrderFavorite(SLUG, bottom, "a", "reorder-below");
      const seqs = shown(store).map((id) => store.favoriteMap[id].sequence);
      expect(new Set(seqs).size, `duplicate sequence after move ${i + 1}: ${seqs}`).toBe(seqs.length);
      expect(shown(store)[1]).toBe(bottom);
    }
  });
});

describe("fetchFavorite dedupe (L1-11)", () => {
  it("refetching does not duplicate ids", async () => {
    const favs = [fav("a", 2), fav("b", 1)];
    const store = new FavoriteStore(ROOT as never);
    store.favoriteService = { getFavorites: vi.fn(async () => favs) } as never;
    await store.fetchFavorite(SLUG);
    await store.fetchFavorite(SLUG);
    expect(store.favoriteIds).toEqual(["a", "b"]);
  });
});
