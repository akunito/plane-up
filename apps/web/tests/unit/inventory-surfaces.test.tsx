/**
 * APLANE-63 (inventory phase 5): the project entry in both navigation lists, its own labels, the
 * dictionaries, and the aisle order. Plan: "unit tests for both navigation lists".
 */
import { render, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EUserPermissions } from "@plane/constants";

const state = vi.hoisted(() => ({
  locale: "es",
  role: 15 as number,
  project: { id: "p1", inventory_view: true } as Record<string, unknown> | undefined,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "home" }),
  usePathname: () => "/home/projects/p1/issues/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@plane/i18n", async (orig) => ({
  ...(await orig<object>()),
  useTranslation: () => ({ t: (k: string) => `T(${k})`, currentLocale: state.locale }),
}));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({
    isExtendedProjectSidebarOpened: false,
    toggleExtendedProjectSidebar: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));
// The project role is the viewer's role in the project, as the lite list carries it.
const projectNow = () => (state.project ? { ...state.project, member_role: state.role } : undefined);
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getPartialProjectById: projectNow }) }));
const allow = (access: number[]) => access.includes(state.role);
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => ({ allowPermissions: allow }) }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ issue: { getIssueIdByIdentifier: () => undefined, getIssueById: () => undefined } }),
}));

import { orderedCategories } from "@/components/inventory/project/aisle-order";
import { INVENTORY_DICTIONARIES, inventoryLocale, inventoryT, navLabel } from "@/components/inventory/i18n";
import { useNavigationItems } from "@/components/navigation/use-navigation-items";
import { ProjectNavigation } from "@/components/workspace/sidebar/project-navigation";

const sidebar = () =>
  render(
    <MemoryRouter>
      <ProjectNavigation workspaceSlug="home" projectId="p1" />
    </MemoryRouter>
  ).container;

const hookItems = () =>
  renderHook(() =>
    useNavigationItems({
      workspaceSlug: "home",
      projectId: "p1",
      project: projectNow() as never,
      allowPermissions: (access) => allow(access as number[]),
    })
  ).result.current;

beforeEach(() => {
  state.locale = "es";
  state.role = EUserPermissions.MEMBER;
  state.project = { id: "p1", inventory_view: true };
});

describe("the project's Inventory entry, tab navigation (use-navigation-items)", () => {
  it("is there for a member when the project has inventory on, last, with the project route", () => {
    const items = hookItems();
    const inv = items.find((i) => i.key === "inventory");
    expect(inv?.href).toBe("/home/projects/p1/inventory");
    expect(items.at(-1)?.key).toBe("inventory");
  });

  it("is absent with the flag off, and for a guest even with it on", () => {
    state.project = { id: "p1", inventory_view: false };
    expect(hookItems().some((i) => i.key === "inventory")).toBe(false);
    state.project = { id: "p1" };
    expect(hookItems().some((i) => i.key === "inventory")).toBe(false);
    state.project = { id: "p1", inventory_view: true };
    state.role = EUserPermissions.GUEST;
    const items = hookItems();
    expect(items.some((i) => i.key === "inventory")).toBe(false);
    expect(items.some((i) => i.key === "work_items")).toBe(true);
  });
});

describe("the project's Inventory entry, sidebar (project-navigation)", () => {
  it("links to the project page with the fork's own label in the viewer's language", () => {
    const container = sidebar();
    const link = container.querySelector('a[href="/home/projects/p1/inventory/"]');
    expect(link?.textContent).toBe("Inventario");
    // Plane's own entries keep Plane's translation.
    expect(container.querySelector('a[href="/home/projects/p1/issues/"]')?.textContent).toBe("T(sidebar.work_items)");
  });

  it("is not rendered with the flag off or for a guest", () => {
    state.project = { id: "p1", inventory_view: false };
    const off = sidebar();
    expect(off.querySelector('a[href="/home/projects/p1/inventory/"]')).toBeNull();
    state.project = { id: "p1", inventory_view: true };
    state.role = EUserPermissions.GUEST;
    const guest = sidebar();
    expect(guest.querySelector('a[href="/home/projects/p1/inventory/"]')).toBeNull();
  });
});

const tPlane = (k: string) => `T(${k})`;
// oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; the web lib is es2022 (no toSorted)
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("labels", () => {
  it("navLabel uses the fork's dictionary for inventory keys only; other languages fall back to English", () => {
    expect(navLabel("inventory", "sidebar.inventory", tPlane, "pl")).toBe("Zapasy");
    expect(navLabel("features_inventory", "x", tPlane, "de")).toBe("Inventory");
    expect(navLabel("pages", "sidebar.pages", tPlane, "es")).toBe("T(sidebar.pages)");
    expect(inventoryLocale("es-ES")).toBe("es");
    expect(inventoryLocale(undefined)).toBe("en");
  });

  it("every language has every key, non-empty, with the same placeholders as English", () => {
    const en = INVENTORY_DICTIONARIES.en;
    for (const [lang, dict] of Object.entries(INVENTORY_DICTIONARIES))
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(dict[key]?.trim(), `${lang}.${key}`).toBeTruthy();
        expect(placeholders(dict[key]), `${lang}.${key}`).toEqual(placeholders(en[key]));
      }
    expect(inventoryT("es", "widget_count", { n: 3 })).toBe("3 por comprar");
  });
});

describe("aisle order", () => {
  it("keeps the person's order, appends the rest by name, and merges case and spacing (S30)", () => {
    expect(orderedCategories(["dairy", "Gone", "Bakery"], ["Bakery", "Baby", " Dairy ", "dairy", "Cleaning"])).toEqual([
      "Dairy",
      "Bakery",
      "Baby",
      "Cleaning",
    ]);
    expect(orderedCategories([], [])).toEqual([]);
  });
});
