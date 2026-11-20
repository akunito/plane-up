// What the screens show, derived from the server's payloads and the device queue. Pure: no React, no
// network. State comes from the queue's view() (server state plus waiting changes); data fields (name,
// category, store...) come from the newest payload fetched, because editing data does not advance the
// item's revision (brief: Item state).

import type { Entry, ItemState, Lists, Mode, QueueState, VisibleProject } from "@plane/inventory";
import { counts, toBuy, view } from "@plane/inventory";

export interface ItemData extends ItemState {
  name: string;
  list: { id: string; name: string };
  project: { id: string; name: string; identifier: string };
  needed_by?: string | null;
  needed_at?: string | null;
  category: string;
  store: string;
  buy_online: boolean;
  purchase_url: string;
  variant: string;
  last_price: string | null;
  currency: string;
  expires_on: string | null;
  barcode: string;
  sort_order: number;
  on_order: number;
  to_buy: number;
}

export interface Order {
  id: string;
  item: string;
  item_name: string;
  quantity: number;
  status: "open" | "received" | "cancelled";
  reference: string;
  expected_on: string | null;
  ordered_at: string;
  ordered_by: string | null;
  overdue: boolean;
  bought_since_at: string | null;
  bought_since_by: string | null;
  source?: string;
  /** Queued on this device, not yet in a list fetched from the server. */
  local?: boolean;
}

/** One fetched payload and what the server said about it at that moment. */
export interface Known {
  data: ItemData;
  /** Device time the request that brought it STARTED: anything the server knew before then is in it. */
  fetchedAt: number;
  /** The server's to-buy verdict in that payload (to_buy > 0). */
  onList: boolean;
}

export type Grouping = "category" | "store" | "list" | "urgency";

/**
 * Merge payloads fetched by one request started at `startedAt`. Data fields always come from the newest
 * fetch; nothing older replaces something fetched later.
 */
export function mergeFetched(
  known: Record<string, Known>,
  payloads: readonly ItemData[],
  startedAt: number
): Record<string, Known> {
  const out = { ...known };
  for (const data of payloads) {
    const current = out[data.id];
    if (current && current.fetchedAt > startedAt && current.data.rev >= data.rev) continue;
    out[data.id] = { data, fetchedAt: startedAt, onList: data.to_buy > 0 };
  }
  return out;
}

/**
 * A to-buy snapshot requested at `startedAt`: every item it leaves out was not on the list then, unless
 * something fetched later says otherwise.
 */
export function mergeSnapshot(
  known: Record<string, Known>,
  payloads: readonly ItemData[],
  startedAt: number
): Record<string, Known> {
  const out = mergeFetched(known, payloads, startedAt);
  const listed = new Set(payloads.map((p) => p.id));
  for (const [id, k] of Object.entries(out)) {
    if (!listed.has(id) && k.fetchedAt < startedAt) out[id] = { ...k, fetchedAt: startedAt, onList: false };
  }
  return out;
}

/** Drop what a full list fetch no longer returns (deleted or moved away by someone). */
export function dropMissingFromList(
  known: Record<string, Known>,
  listId: string,
  payloads: readonly ItemData[],
  startedAt: number
): Record<string, Known> {
  const present = new Set(payloads.map((p) => p.id));
  const out: Record<string, Known> = {};
  for (const [id, k] of Object.entries(known)) {
    if (k.data.list.id === listId && !present.has(id) && k.fetchedAt < startedAt) continue;
    out[id] = k;
  }
  return out;
}

/**
 * Open orders as the device should show them: the server's, plus order actions tapped after the
 * server's list was requested (queued, or answered and not yet in a newer fetch). A refused action shows
 * until the next fetch, which follows every answer.
 */
export function openOrders(server: readonly Order[], queue: QueueState, ordersFetchedAt: number): Order[] {
  const byId = new Map<string, Order>();
  for (const o of server) if (o.status === "open") byId.set(o.id, o);
  const local: Entry[] = [];
  for (const e of queue.recent) if (e.tappedAt > ordersFetchedAt) local.push(e);
  for (const e of queue.entries) local.push(e);
  local.sort((a, b) => a.tappedAt - b.tappedAt);
  for (const e of local) {
    const orderId = e.op.args.order_id;
    if (typeof orderId !== "string") continue;
    if (e.op.op === "mark_ordered" && !byId.has(orderId)) {
      const quantity = typeof e.op.args.quantity === "number" ? e.op.args.quantity : 1;
      byId.set(orderId, {
        id: orderId,
        item: e.op.target,
        item_name: "",
        quantity,
        status: "open",
        reference: typeof e.op.args.reference === "string" ? e.op.args.reference : "",
        expected_on: typeof e.op.args.expected_on === "string" ? e.op.args.expected_on : null,
        ordered_at: new Date(e.tappedAt).toISOString(),
        ordered_by: queue.userId,
        overdue: false,
        bought_since_at: null,
        bought_since_by: null,
        local: true,
      });
    } else if (e.op.op === "arrived" || e.op.op === "cancel") {
      byId.delete(orderId);
    }
  }
  return [...byId.values()];
}

export interface Row {
  id: string;
  data: ItemData;
  /** State as the device shows it (server state plus waiting changes). */
  state: ItemState;
  quantity: number;
  onOrder: number;
  orders: Order[];
  /** Ticked on this device since the last "Finish shopping". */
  done: boolean;
  /** Changes for this item are waiting to be sent. */
  waiting: boolean;
}

export interface Board {
  /** Rows to buy (not ticked under "Done"). */
  toBuy: Row[];
  done: Row[];
  /** Open orders with their item, for "On the way". */
  onTheWay: { order: Order; row: Row | null }[];
  /** Rows of the sidebar counter: pinned ones never count. */
  count: number;
  pinned: number;
}

export function rowFor(
  id: string,
  known: Record<string, Known>,
  shown: Record<string, ItemState>,
  orders: readonly Order[],
  queue: QueueState
): Row | null {
  const k = known[id];
  const state = shown[id];
  if (!k || !state) return null;
  const mine = orders.filter((o) => o.item === id);
  const onOrder = mine.reduce((n, o) => n + o.quantity, 0);
  const quantity = toBuy({
    mode: state.mode,
    needed: state.needed,
    level: state.level,
    quantity: state.quantity,
    min_quantity: state.min_quantity,
    restock_to: state.restock_to,
    on_order: onOrder,
    has_open_order: mine.length > 0,
  });
  return {
    id,
    data: k.data,
    state,
    quantity,
    onOrder,
    orders: mine,
    done: queue.done[id] !== undefined,
    waiting: queue.entries.some((e) => e.op.target === id),
  };
}

/**
 * The to-buy list. Local derivation decides for an item with waiting changes or whose state the device
 * holds at a newer revision than its last fetch (an answer came back since); otherwise the server's
 * verdict of the last fetch stands, because the device does not know the state of an item that left
 * the list on someone else's phone.
 */
export function board(
  known: Record<string, Known>,
  queue: QueueState,
  serverOrders: readonly Order[],
  ordersFetchedAt: number
): Board {
  const shown = view(queue);
  const orders = openOrders(serverOrders, queue, ordersFetchedAt);
  const pending = new Set(queue.entries.map((e) => e.op.target));
  const toBuyRows: Row[] = [];
  const done: Row[] = [];
  let count = 0;
  let pinned = 0;
  for (const id of Object.keys(known)) {
    const row = rowFor(id, known, shown, orders, queue);
    if (!row) continue;
    if (row.done) {
      done.push(row);
      continue;
    }
    const k = known[id]!;
    const trustLocal = pending.has(id) || row.state.rev > k.data.rev;
    if (row.quantity <= 0 || (!trustLocal && !k.onList)) continue;
    toBuyRows.push(row);
    if (counts(row.state.mode)) count++;
    else pinned++;
  }
  const onTheWay = orders.map((order) => ({ order, row: rowFor(order.item, known, shown, orders, queue) }));
  return { toBuy: toBuyRows, done, onTheWay, count, pinned };
}

/** Urgency: out, then low or below the minimum, then needed, then pinned (brief: Designer defaults). */
export function urgency(state: ItemState): number {
  if (state.mode === "level") return state.level === "out" ? 0 : 1;
  if (state.mode === "units") return (state.quantity ?? 0) <= 0 ? 0 : 1;
  if (state.mode === "on_demand") return 2;
  return 3;
}

export interface Group {
  key: string;
  /** Empty when the group has no name (an item with no category or store). */
  label: string;
  rows: Row[];
}

const byName = (a: Row, b: Row) => a.data.name.localeCompare(b.data.name);

export function group(rows: readonly Row[], grouping: Grouping, categoryOrder: readonly string[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    let key: string;
    let label: string;
    if (grouping === "category") key = label = row.data.category;
    else if (grouping === "store") key = label = row.data.store;
    else if (grouping === "list") {
      key = row.data.list.id;
      label = row.data.list.name;
    } else {
      key = String(urgency(row.state));
      label = key;
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, rows: [] }));
    g.rows.push(row);
  }
  const out = [...groups.values()];
  for (const g of out)
    g.rows.sort(grouping === "urgency" ? byName : (a, b) => urgency(a.state) - urgency(b.state) || byName(a, b));
  // The person's aisle order first (per user, brief), then the rest by name; unnamed groups last.
  const rank = new Map(categoryOrder.map((c, i) => [c.toLocaleLowerCase(), i]));
  out.sort((a, b) => {
    if (grouping === "urgency") return Number(a.key) - Number(b.key);
    if (!a.label !== !b.label) return a.label ? -1 : 1;
    if (grouping === "category") {
      const ra = rank.get(a.label.toLocaleLowerCase()) ?? Infinity;
      const rb = rank.get(b.label.toLocaleLowerCase()) ?? Infinity;
      if (ra !== rb) return ra - rb;
    }
    return a.label.localeCompare(b.label);
  });
  return out;
}

export type Badge = "out" | "low" | "below" | "needed" | "pinned" | "recount" | "ok" | null;

/** What the row says about the item's state; low and out are told apart by text and icon, not colour. */
export function badge(state: ItemState): Badge {
  switch (state.mode) {
    case "pinned":
      return "pinned";
    case "on_demand":
      return state.needed ? "needed" : null;
    case "level":
      return state.level === "out" ? "out" : state.level === "low" ? "low" : "ok";
    case "units":
      if ((state.quantity ?? 0) < 0) return "recount";
      return (state.quantity ?? 0) < (state.min_quantity ?? 0) ? "below" : "ok";
  }
}

/** A negative total is shown as 0 with a "recount" mark (brief: the server never clamps). */
export const shownQuantity = (state: ItemState): number => Math.max(state.quantity ?? 0, 0);

/** Who can see a list, said plainly instead of asserting "only you" from the member count. */
export type Audience =
  | { kind: "only_you" }
  | { kind: "people"; names: string[] }
  | { kind: "public"; names: string[] }
  | { kind: "admins"; names: string[]; admins: number };

export function audience(project: VisibleProject, meId: string): Audience {
  const names = project.members.filter((m) => m.id !== meId).map((m) => m.display_name);
  if (project.network !== 0) return { kind: "public", names };
  if (project.admins_outside > 0) return { kind: "admins", names, admins: project.admins_outside };
  return names.length === 0 ? { kind: "only_you" } : { kind: "people", names };
}

export function projectOf(lists: Lists | null, projectId: string): VisibleProject | undefined {
  return lists?.projects.find((p) => p.id === projectId);
}

export function personName(lists: Lists | null, id: string | null | undefined): string | null {
  if (!id || !lists) return null;
  if (lists.me.id === id) return lists.me.display_name;
  for (const p of lists.projects) for (const m of p.members) if (m.id === id) return m.display_name;
  return null;
}

/** Defaults a list gives a new item, and what each mode's capture action is. */
export const MODES: readonly Mode[] = ["pinned", "on_demand", "level", "units"];
