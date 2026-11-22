// A fake of the endpoints the app calls, over the phase 3 model of the engine (ModelServer), so the
// screens are tested against the same two behaviours the device queue was. Plain data in, Responses out.

import type { ItemState, Operation } from "@plane/inventory";
import { toBuy } from "@plane/inventory";
import { ModelServer } from "../../inventory/tests/model-server";

export const ME = { id: "00000000-0000-4000-8000-000000000001", display_name: "Ana" };
export const BO = { id: "00000000-0000-4000-8000-000000000002", display_name: "Bo" };
export const PROJECT = "10000000-0000-4000-8000-000000000001";
export const SECRET = "10000000-0000-4000-8000-000000000002";
export const GROCERIES = "20000000-0000-4000-8000-000000000001";
export const BABY = "20000000-0000-4000-8000-000000000002";
export const SUPPLEMENTS = "20000000-0000-4000-8000-000000000003";

let seq = 0;
export const uid = (prefix = "3") => `${prefix}0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export interface Data {
  name: string;
  list: string;
  category?: string;
  store?: string;
  buy_online?: boolean;
  purchase_url?: string;
  photo?: string | null;
}

/** Where the fake's presigned POST points; the fake answers it like storage (APLANE-66). */
export const STORAGE = "https://storage.test/upload";

const LISTS: Record<string, { name: string; project: string }> = {
  [GROCERIES]: { name: "Groceries", project: PROJECT },
  [BABY]: { name: "Baby", project: PROJECT },
  [SUPPLEMENTS]: { name: "Supplements", project: SECRET },
};

export function state(id: string, mode: ItemState["mode"], extra: Partial<ItemState> = {}): ItemState {
  return {
    id,
    rev: 0,
    mode,
    needed: false,
    level: mode === "level" ? "ok" : null,
    quantity: mode === "units" ? 0 : null,
    min_quantity: mode === "units" ? 1 : null,
    restock_to: null,
    last_bought_at: null,
    last_bought_by: null,
    ...extra,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export class FakeApi {
  server: ModelServer;
  data = new Map<string, Data>();
  calls: Call[] = [];
  /** Answer every request with this instead (a status and an optional JSON body). */
  fail: { status: number; json?: unknown } | null = null;
  ordersAt = new Map<string, string>();
  pendingPhotos = new Set<string>();
  /** Runs while storage "receives" a photo, before it answers: a refresh racing the upload. */
  onStorage: (() => Promise<unknown>) | null = null;
  /** History requests fail as a dropped network does (offline). */
  dropHistory = false;
  constructor(items: { state: ItemState; data: Data }[]) {
    this.server = new ModelServer(items.map((i) => i.state));
    for (const i of items) this.data.set(i.state.id, i.data);
  }

  ops(): Operation[] {
    return this.calls
      .filter((c) => c.path.endsWith("/inventory/ops/"))
      .flatMap((c) => (c.body as { ops: Operation[] }).ops);
  }

  private payload(id: string) {
    const s = this.server.items.get(id)!;
    const d = this.data.get(id)!;
    const open = [...this.server.orders.values()].filter((o) => o.item === id && o.status === "open");
    const onOrder = open.reduce((n, o) => n + o.quantity, 0);
    const list = LISTS[d.list]!;
    return {
      ...s,
      name: d.name,
      list: { id: d.list, name: list.name },
      project: { id: list.project, name: list.project === PROJECT ? "Home" : "Me", identifier: "H" },
      needed_by: null,
      needed_at: null,
      category: d.category ?? "",
      store: d.store ?? "",
      buy_online: d.buy_online ?? false,
      purchase_url: d.purchase_url ?? "",
      variant: "",
      last_price: null,
      currency: "",
      expires_on: null,
      barcode: "",
      photo: d.photo ?? null,
      sort_order: 0,
      on_order: onOrder,
      to_buy: toBuy({ ...s, on_order: onOrder, has_open_order: open.length > 0 }),
    };
  }

  private openOrders() {
    return [...this.server.orders.entries()]
      .filter(([, o]) => o.status === "open")
      .map(([id, o]) => ({
        id,
        item: o.item,
        item_name: this.data.get(o.item)?.name ?? "",
        quantity: o.quantity,
        status: o.status,
        reference: "",
        expected_on: null,
        ordered_at: this.ordersAt.get(id) ?? new Date().toISOString(),
        ordered_by: ME.id,
        overdue: false,
        bought_since_at: null,
        bought_since_by: null,
      }));
  }

  private route(method: string, path: string, body: unknown): [number, unknown] {
    const url = new URL(path, "http://x");
    const p = url.pathname;
    if (p === "/api/users/me/settings/")
      return [200, { workspace: { last_workspace_slug: "home", fallback_workspace_slug: "home" } }];
    if (p === "/api/users/me/workspaces/") return [200, [{ slug: "home", name: "Home" }]];
    if (p.endsWith("/inventory/lists/") && !p.includes("/projects/"))
      return [
        200,
        {
          me: ME,
          projects: [
            { id: PROJECT, name: "Home", identifier: "H", network: 0, members: [ME, BO], admins_outside: 0 },
            { id: SECRET, name: "Me", identifier: "M", network: 0, members: [ME], admins_outside: 0 },
          ],
          lists: Object.entries(LISTS).map(([id, l]) => ({
            id,
            name: l.name,
            project: l.project,
            default_mode: "on_demand",
            sort_order: 0,
            item_count: 0,
          })),
        },
      ];
    if (p.endsWith("/inventory/preferences/"))
      return [200, method === "PUT" ? body : { category_order: [], default_grouping: "category" }];
    if (p.endsWith("/inventory/shopping-list/")) {
      const items = [...this.data.keys()].map((id) => this.payload(id));
      const rows = items.filter((i) => i.to_buy > 0);
      const orders = this.openOrders();
      const waiting = new Set(orders.map((o) => o.item));
      return [
        200,
        {
          items: rows,
          count: rows.filter((r) => r.mode !== "pinned").length,
          on_the_way: orders,
          on_the_way_items: items.filter((i) => i.to_buy === 0 && waiting.has(i.id)),
          generated_at: new Date().toISOString(),
        },
      ];
    }
    if (p.endsWith("/inventory/ops/")) {
      const ops = (body as { ops: Operation[] }).ops;
      for (const op of ops)
        if (op.op === "mark_ordered") this.ordersAt.set(op.args.order_id as string, new Date().toISOString());
      const results = this.server.apply(ops, ME.id);
      // The engine answers with the item's full payload; the model answers with its state only.
      for (const r of results) if (r.item) r.item = this.payload(r.item.id);
      return [200, { results }];
    }
    if (p.endsWith("/inventory/suggestions/")) {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = [...this.data.entries()]
        .filter(([, d]) => q && d.name.toLowerCase().includes(q))
        .map(([id]) => this.payload(id));
      return [200, { items, categories: [], stores: [] }];
    }
    const listItems = p.match(/\/inventory\/lists\/([^/]+)\/items\/$/);
    if (listItems) {
      const listId = listItems[1]!;
      if (method === "POST") {
        const b = body as { name: string; mode?: string };
        const existing = [...this.data.entries()].find(
          ([, d]) => d.list === listId && d.name.toLowerCase() === b.name.toLowerCase()
        );
        if (existing) return [409, { error: "exists", item: this.payload(existing[0]) }];
        const id = uid("4");
        const mode = (b.mode ?? "on_demand") as ItemState["mode"];
        this.server.items.set(id, state(id, mode, mode === "on_demand" ? { needed: true } : {}));
        this.data.set(id, { name: b.name, list: listId });
        return [201, this.payload(id)];
      }
      const ids = [...this.data.entries()].filter(([, d]) => d.list === listId).map(([id]) => id);
      return [
        200,
        {
          items: ids.map((id) => this.payload(id)),
          open_orders: this.openOrders().filter((o) => ids.includes(o.item)),
        },
      ];
    }
    const history = p.match(/\/inventory\/items\/([^/]+)\/history\/$/);
    if (history) return [200, []];
    if (path === STORAGE) return [201, {}];
    const photo = p.match(/\/inventory\/items\/([^/]+)\/photo\/(?:([^/]+)\/)?$/);
    if (photo) {
      const d = this.data.get(photo[1]!)!;
      if (method === "POST" && !photo[2]) {
        const assetId = uid("9");
        this.pendingPhotos.add(assetId);
        return [200, { asset_id: assetId, upload_data: { url: STORAGE, fields: { key: `k-${assetId}` } } }];
      }
      if (method === "PATCH" && photo[2] && this.pendingPhotos.has(photo[2])) {
        d.photo = photo[2];
        return [200, this.payload(photo[1]!)];
      }
      if (method === "DELETE" && !photo[2]) {
        d.photo = null;
        return [200, this.payload(photo[1]!)];
      }
    }
    const item = p.match(/\/inventory\/items\/([^/]+)\/$/);
    if (item && method === "PATCH") {
      const d = this.data.get(item[1]!)!;
      const b = body as Record<string, unknown>;
      if (typeof b.name === "string") d.name = b.name;
      if (typeof b.category === "string") d.category = b.category;
      if (typeof b.inventory_list === "string") d.list = b.inventory_list;
      if ("min_quantity" in b) this.server.items.get(item[1]!)!.min_quantity = b.min_quantity as number | null;
      return [200, this.payload(item[1]!)];
    }
    return [404, { error: "not found" }];
  }

  fetch: typeof fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body });
    if (path === STORAGE && this.onStorage) await this.onStorage();
    if (this.dropHistory && path.endsWith("/history/")) throw new TypeError("Failed to fetch");
    if (this.fail) {
      const json = this.fail.json;
      return new Response(json === undefined ? "<html></html>" : JSON.stringify(json), {
        status: this.fail.status,
        headers: { "content-type": json === undefined ? "text/html" : "application/json" },
      });
    }
    const [status, out] = this.route(method, path, body);
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  };
}
