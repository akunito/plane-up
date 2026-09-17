/**
 * L1-15b / L1-16 / L1-17 — pins resolved from their UUIDs (B-08…B-10, APLANE-13).
 * Live titles and identifiers, and the agreed behaviour when the entity is deleted,
 * archived, or the user loses access.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchWorkItem: vi.fn(),
  fetchPage: vi.fn(),
}));
vi.mock("@/services/pinned-entity.service", () => ({
  PinnedEntityService: class {
    fetchWorkItem = api.fetchWorkItem;
    fetchPage = api.fetchPage;
  },
}));

const store = vi.hoisted(() => ({
  favourites: {} as Record<string, unknown>,
  deleteFavorite: vi.fn(async () => {}),
  identifiers: { p1: "QAA" } as Record<string, string>,
}));
vi.mock("@/hooks/store/use-favorite", () => ({
  useFavorite: () => ({ currentWorkspaceFavorites: store.favourites, deleteFavorite: store.deleteFavorite }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectIdentifierById: (id: string) => store.identifiers[id] }),
}));

import { usePinnedEntities } from "@/hooks/use-pinned-entities";

const favourite = (id: string, entity_type: "page" | "issue", extra: Record<string, unknown> = {}) => ({
  id,
  entity_type,
  entity_identifier: `${id}-entity`,
  project_id: "p1",
  sequence: 100,
  parent: null,
  // what was stored when it was pinned — deliberately stale
  name: entity_type === "issue" ? "OLD-1 old title" : "old page title",
  entity_data: { name: entity_type === "issue" ? "old title" : "old page title" },
  ...extra,
});

/** Every test gets its own SWR cache: the key only depends on the pinned ids, so a shared
 *  cache would serve the previous test's answer and the fetcher would never run. */
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const render = (slug?: string | undefined) => renderHook(() => usePinnedEntities(slug ?? "qa"), { wrapper });
const renderWithoutWorkspace = () => renderHook(() => usePinnedEntities(undefined), { wrapper });

beforeEach(() => {
  store.favourites = {};
  store.identifiers = { p1: "QAA" };
  store.deleteFavorite.mockClear();
  api.fetchWorkItem.mockReset();
  api.fetchPage.mockReset();
});

describe("live titles and identifiers (L1-15b/L1-16)", () => {
  it("shows the work item's current name and identifier, not the pinned label", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    api.fetchWorkItem.mockResolvedValue({ status: 200, data: { name: "renamed title", sequence_id: 12 } });
    const { result } = render();
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));
    expect(result.current.tickets[0]).toMatchObject({
      name: "renamed title",
      label: "QAA-12",
      href: "/qa/browse/QAA-12/",
    });
  });

  it("follows a project identifier change", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    store.identifiers = { p1: "RENAMED" };
    api.fetchWorkItem.mockResolvedValue({ status: 200, data: { name: "title", sequence_id: 3 } });
    const { result } = render();
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));
    expect(result.current.tickets[0].label).toBe("RENAMED-3");
    expect(result.current.tickets[0].href).toBe("/qa/browse/RENAMED-3/");
  });

  it("shows a page's current name and route", async () => {
    store.favourites = { f2: favourite("f2", "page") };
    api.fetchPage.mockResolvedValue({ status: 200, data: { name: "renamed page" } });
    const { result } = render();
    await waitFor(() => expect(result.current.pages).toHaveLength(1));
    expect(result.current.pages[0]).toMatchObject({
      name: "renamed page",
      href: "/qa/projects/p1/pages/f2-entity",
    });
  });
});

describe("deleted, archived, no access (L1-15b)", () => {
  it("a deleted work item drops the pin (server-side, so every device agrees)", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    api.fetchWorkItem.mockResolvedValue({ status: 404 });
    const { result } = render();
    await waitFor(() => expect(store.deleteFavorite).toHaveBeenCalledWith("qa", "f1"));
    expect(result.current.tickets).toHaveLength(0);
  });

  it("a deleted page drops the pin", async () => {
    store.favourites = { f2: favourite("f2", "page") };
    api.fetchPage.mockResolvedValue({ status: 404 });
    const { result } = render();
    await waitFor(() => expect(store.deleteFavorite).toHaveBeenCalledWith("qa", "f2"));
    expect(result.current.pages).toHaveLength(0);
  });

  it("an archived work item is kept and opens its archived route", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    api.fetchWorkItem.mockResolvedValue({
      status: 200,
      data: { name: "archived item", sequence_id: 9, archived_at: "2026-10-01" },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));
    expect(result.current.tickets[0].isArchived).toBe(true);
    expect(result.current.tickets[0].href).toBe("/qa/projects/p1/archives/issues/f1-entity");
    expect(store.deleteFavorite).not.toHaveBeenCalled();
  });

  it.each([401, 403])("no access (%i) hides the pin but never deletes it", async (status) => {
    store.favourites = { f1: favourite("f1", "issue"), f2: favourite("f2", "page") };
    api.fetchWorkItem.mockResolvedValue({ status });
    api.fetchPage.mockResolvedValue({ status });
    const { result } = render();
    await waitFor(() => expect(api.fetchWorkItem).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tickets).toHaveLength(0);
    expect(result.current.pages).toHaveLength(0);
    expect(store.deleteFavorite).not.toHaveBeenCalled();
  });

  it("a server error keeps the pin with its last known label", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    api.fetchWorkItem.mockResolvedValue({ status: 500 });
    const { result } = render();
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));
    expect(result.current.tickets[0].name).toBe("old title"); // the snapshot stored at pin time
    expect(store.deleteFavorite).not.toHaveBeenCalled();
  });
});

describe("list shape (L1-15/L1-17)", () => {
  it("splits pages and tickets, sorts by sequence desc and ignores other favourite types", async () => {
    store.favourites = {
      f1: favourite("f1", "issue", { sequence: 1 }),
      f2: favourite("f2", "issue", { sequence: 9 }),
      f3: favourite("f3", "page", { sequence: 5 }),
      f4: { ...favourite("f4", "page"), entity_type: "project" },
      f5: { ...favourite("f5", "page"), parent: "folder-1" },
      f6: { ...favourite("f6", "issue"), entity_identifier: null },
    };
    api.fetchWorkItem.mockImplementation(async (_s: string, _p: string, id: string) => ({
      status: 200,
      data: { name: id, sequence_id: 1 },
    }));
    api.fetchPage.mockResolvedValue({ status: 200, data: { name: "page" } });
    const { result } = render();
    await waitFor(() => expect(result.current.tickets).toHaveLength(2));
    expect(result.current.tickets.map((t) => t.favoriteId)).toEqual(["f2", "f1"]);
    expect(result.current.pages.map((p) => p.favoriteId)).toEqual(["f3"]);
    expect(api.fetchWorkItem).toHaveBeenCalledTimes(2); // f6 has no entity id, f4/f5 are not pins
  });

  it("does nothing without a workspace", async () => {
    store.favourites = { f1: favourite("f1", "issue") };
    const { result } = renderWithoutWorkspace();
    await waitFor(() => expect(result.current.tickets).toHaveLength(0));
    expect(api.fetchWorkItem).not.toHaveBeenCalled();
  });
});
