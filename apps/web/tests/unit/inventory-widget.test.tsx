/**
 * APLANE-63 (inventory phase 5): the Home widget and the sidebar entry. Only for a viewer who can see a
 * project with inventory on; the widget ticks online with a fresh queue id per request and keeps nothing
 * when the request fails (S42); the counter is the to-buy count (S20).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  projects: {} as Record<string, { inventory_view?: boolean; member_role?: number }>,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "home" }),
  usePathname: () => "/home/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@plane/i18n", async (orig) => ({
  ...(await orig<object>()),
  useTranslation: () => ({ t: (k: string) => k, currentLocale: "en" }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    joinedProjectIds: Object.keys(state.projects),
    getPartialProjectById: (id: string) => state.projects[id],
  }),
}));

import { ShoppingListWidget } from "@/components/inventory/home-widget";
import { InventorySidebarEntry } from "@/components/inventory/sidebar-entry";

const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  rev: 3,
  mode: "on_demand",
  needed: true,
  level: null,
  quantity: null,
  min_quantity: null,
  restock_to: null,
  last_bought_at: null,
  last_bought_by: null,
  name,
  category: "",
  buy_online: false,
  to_buy: 1,
  list: { id: "l1", name: "Groceries" },
  ...extra,
});

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let listItems: ReturnType<typeof item>[] = [];
let opsAnswer: (body: any) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  state.projects = { p1: { inventory_view: true, member_role: 15 } };
  listItems = [item("a", "Milk"), item("b", "Wipes", { mode: "units", quantity: 0, min_quantity: 2, to_buy: 3 })];
  opsAnswer = (body) =>
    json(200, {
      results: body.ops.map((op: any) => ({ client_op_id: op.client_op_id, result: "applied", rev: 4 })),
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? "GET", body });
      if (url.endsWith("/inventory/shopping-list/"))
        return json(200, { items: listItems, count: listItems.length, on_the_way: [], generated_at: "" });
      if (url.endsWith("/inventory/ops/")) return opsAnswer(body);
      if (url.includes("/inventory/suggestions/")) return json(200, { items: listItems, categories: [], stores: [] });
      if (url.endsWith("/inventory/lists/"))
        return json(200, { me: { id: "u1", display_name: "Ana" }, projects: [], lists: [] });
      return json(404, { error: "not found" });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("who sees the widget and the sidebar entry", () => {
  it("nobody without a member role in a project with inventory on, and no request is made", () => {
    for (const projects of [
      {},
      { p1: { inventory_view: false, member_role: 20 } },
      { p1: { inventory_view: true, member_role: 5 } },
    ]) {
      state.projects = projects;
      const { container, unmount } = render(
        <>
          <ShoppingListWidget workspaceSlug="home" />
          <InventorySidebarEntry />
        </>
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
    expect(calls).toEqual([]);
  });

  it("the sidebar entry is a plain anchor to /shopping/ with the to-buy count", async () => {
    render(<InventorySidebarEntry />);
    const link = screen.getByTestId("sidebar-shopping");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/shopping/");
    await waitFor(() => expect(screen.getByTestId("sidebar-shopping-count").textContent).toBe("2"));
  });
});

describe("the Home widget", () => {
  it("lists the to-buy rows and ticks online: buy with the list's quantity, a fresh queue id each time", async () => {
    render(<ShoppingListWidget workspaceSlug="home" />);
    await screen.findByText("Wipes");
    expect(screen.getByTestId("shopping-widget-count").textContent).toBe("2 to buy");
    fireEvent.click(screen.getByLabelText("Wipes: bought"));
    await screen.findByText("Wipes: bought.");
    fireEvent.click(screen.getByLabelText("Milk: bought"));
    await screen.findByText("Milk: bought.");
    const ops = calls.filter((c) => c.url.endsWith("/inventory/ops/")).map((c) => c.body.ops[0]);
    expect(ops.map((o) => [o.op, o.target, o.args])).toEqual([
      ["buy", "b", { quantity: 3 }],
      ["buy", "a", {}],
    ]);
    expect(ops[0].queue_id).not.toBe(ops[1].queue_id);
    expect(ops[0].age_ms).toBe(0);
    // Each change reloads the list (and the counter, through the same event).
    expect(calls.filter((c) => c.url.endsWith("/shopping-list/")).length).toBeGreaterThanOrEqual(3);
  });

  it("a failed request says so and keeps nothing to send later (S42)", async () => {
    opsAnswer = () => {
      throw new TypeError("network");
    };
    render(<ShoppingListWidget workspaceSlug="home" />);
    await screen.findByText("Milk");
    fireEvent.click(screen.getByLabelText("Milk: bought"));
    await screen.findByText("No connection: nothing was changed.");
    const before = calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls.slice(before).some((c) => c.url.endsWith("/ops/"))).toBe(false);
  });

  it("capture: a statement from a view that is not refreshed is refused and says who changed it (S67)", async () => {
    opsAnswer = (body) =>
      json(200, {
        results: [
          {
            client_op_id: body.ops[0].client_op_id,
            result: "stale",
            changed: { op: "set_needed", by: "u2", by_name: "Bo", at: null },
            item: item("a", "Milk", { needed: false, rev: 5 }),
          },
        ],
      });
    listItems = [item("a", "Milk", { needed: false, to_buy: 0 })];
    render(<ShoppingListWidget workspaceSlug="home" />);
    fireEvent.change(screen.getByLabelText("Add or search…"), { target: { value: "mi" } });
    fireEvent.click(await screen.findByLabelText("Milk: Needed"));
    await screen.findByText("Bo changed it first; the row now shows their change.");
    const op = calls.find((c) => c.url.endsWith("/inventory/ops/"))!.body.ops[0];
    expect([op.op, op.args, op.base_rev]).toEqual(["set_needed", { needed: true }, 3]);
  });
});
