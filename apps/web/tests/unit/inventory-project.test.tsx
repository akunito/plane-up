/**
 * APLANE-63: Project › Inventory's table against the real answer shapes. An operation answers with the
 * item's state only (engine item_state); a data edit answers with the full payload. Phase 5 re-review: a
 * state-only answer swapped into the row blanked its name and fields.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeInventoryT } from "@/components/inventory/i18n";
import { ProjectInventoryRoot } from "@/components/inventory/project/root";

const salt = {
  id: "s1",
  rev: 2,
  mode: "on_demand",
  needed: false,
  level: null,
  quantity: null,
  min_quantity: null,
  restock_to: null,
  last_bought_at: null,
  last_bought_by: null,
  name: "Salt",
  category: "Pantry",
  store: "Market",
  buy_online: false,
  to_buy: 0,
  on_order: 0,
  list: { id: "l1", name: "Groceries" },
  project: { id: "p1", name: "Home", identifier: "HOME" },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let holdReload: Promise<void> | null = null;
let patchStatus = 200;
let listGets = 0;
let listItems: unknown[] = [salt];

beforeEach(() => {
  holdReload = null;
  patchStatus = 200;
  listGets = 0;
  listItems = [salt];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (url.endsWith("/projects/p1/inventory/lists/"))
        return json(200, [{ id: "l1", name: "Groceries", default_mode: "on_demand", sort_order: 0 }]);
      if (url.endsWith("/inventory/lists/"))
        return json(200, {
          me: { id: "u1", display_name: "Ana" },
          projects: [{ id: "p1", name: "Home", identifier: "HOME", network: 0, members: [], admins_outside: 0 }],
          lists: [],
        });
      if (url.includes("/inventory/suggestions/")) return json(200, { items: [], categories: ["Pantry"], stores: [] });
      if (url.endsWith("/lists/l1/items/")) {
        listGets += 1;
        if (listGets > 1 && holdReload) await holdReload;
        return json(200, { items: listItems, open_orders: [] });
      }
      if (url.endsWith("/inventory/ops/"))
        return json(200, {
          results: body.ops.map((op: { client_op_id: string }) => ({
            client_op_id: op.client_op_id,
            result: "applied",
            rev: 3,
            item: {
              id: "s1",
              rev: 3,
              mode: "on_demand",
              needed: true,
              level: null,
              quantity: null,
              min_quantity: null,
              restock_to: null,
              last_bought_at: null,
              last_bought_by: null,
            },
          })),
        });
      if (url.endsWith("/items/s1/") && init.method === "PATCH")
        return patchStatus === 200 ? json(200, { ...salt, ...body }) : json(patchStatus, { error: "nope" });
      return json(404, {});
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => render(<ProjectInventoryRoot workspaceSlug="home" projectId="p1" t={makeInventoryT("en")} />);

describe("Project › Inventory table", () => {
  it("APLANE-77: pinned rows are also gathered in a group at the top; the list below is alphabetical", async () => {
    listItems = [
      { ...salt, id: "z1", name: "Zucchini" },
      { ...salt, id: "b1", name: "Bread", mode: "pinned", needed: true },
      salt,
    ];
    const { container } = mount();
    const pinned = await screen.findByTestId("inventory-pinned");
    const names = (el: HTMLElement) =>
      within(el)
        .getAllByLabelText("Name")
        .map((i) => (i as HTMLInputElement).value);
    // "Pinned" is also an option of every row's Tracking select: the group's header is the <th>.
    expect(within(pinned).getByText("Pinned", { selector: "th" })).toBeTruthy();
    expect(names(pinned)).toEqual(["Bread"]);
    const all = container.querySelectorAll("tbody")[1] as HTMLElement;
    expect(within(all).getByText("All items", { selector: "th" })).toBeTruthy();
    expect(names(all)).toEqual(["Bread", "Salt", "Zucchini"]);
  });

  it("APLANE-77: with nothing pinned there is no group and no header", async () => {
    mount();
    await screen.findByRole("button", { name: "Salt: Needed" });
    expect(screen.queryByTestId("inventory-pinned")).toBeNull();
    expect(screen.queryByText("All items")).toBeNull();
  });

  it("a state-only operation answer is merged: the row keeps its name and fields", async () => {
    holdReload = new Promise(() => {}); // the quiet reload never answers: only the merge can show the row
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Salt: Needed" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Salt: Needed" }).getAttribute("aria-pressed")).toBe("true")
    );
    expect((screen.getByLabelText("Salt: Category / aisle") as HTMLInputElement).value).toBe("Pantry");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Salt");
  });

  it("a refused data edit shows the saved value again, and says why", async () => {
    patchStatus = 400;
    mount();
    const category = (await screen.findByLabelText("Salt: Category / aisle")) as HTMLInputElement;
    fireEvent.focus(category);
    fireEvent.change(category, { target: { value: "Spices" } });
    fireEvent.blur(category);
    await screen.findByText("Refused: nope.");
    await waitFor(() => expect(category.value).toBe("Pantry"));
  });
});
