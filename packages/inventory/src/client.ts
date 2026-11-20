// The API client. JSON only, redirect: "manual", and M4's definition of "not delivered" (measured
// 2026-11-19/20, brief "Measured in phase 0"): 401 with JSON = signed out of the app; 401 without JSON
// or a redirect = signed out of the authenticating proxy (its 302 goes to another origin, which a page
// cannot follow or read); no answer = no network. Every failure keeps the queue for a retry.

import type { FailureKind } from "./queue";
import type { ItemState, OpResult, Operation } from "./types";

export type Delivery =
  | { kind: "ok"; results: OpResult[] }
  | { kind: "refused"; status: number; error: string }
  | { kind: "failed"; failure: FailureKind; status: number };

export interface ClientOptions {
  /** e.g. "" for same origin. */
  base: string;
  slug: string;
  fetchImpl?: typeof fetch;
  /** A request with no answer by then is "offline" and retried with the same ids (default 30 s): a hung
   * request would hold the device lock and keep the queue "sending" (phase 3 re-review). */
  timeoutMs?: number;
}

const HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json",
};

async function call(opts: ClientOptions, method: string, path: string, body?: unknown) {
  return raw(opts, method, `/api/workspaces/${encodeURIComponent(opts.slug)}/inventory/${path}`, body);
}

function raw(opts: ClientOptions, method: string, url: string, body?: unknown) {
  const f = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method,
    headers: HEADERS,
    redirect: "manual",
    credentials: "same-origin",
    cache: "no-store",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  init.signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  return f(`${opts.base}${url}`, init);
}

async function classify(
  response: Response
): Promise<Exclude<Delivery, { kind: "ok" }> | { kind: "json"; body: unknown }> {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    return { kind: "failed", failure: "signed_out_proxy", status: response.status };
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (response.status === 401)
    return { kind: "failed", failure: isJson ? "signed_out_app" : "signed_out_proxy", status: 401 };
  if (response.status >= 500 || !isJson) return { kind: "failed", failure: "server", status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Labelled JSON but not JSON (truncated, a proxy's page): a failed request, retried.
    return { kind: "failed", failure: "server", status: response.status };
  }
  if (response.status >= 400) {
    const error = (body as { error?: string })?.error ?? `HTTP ${response.status}`;
    return { kind: "refused", status: response.status, error };
  }
  return { kind: "json", body };
}

export async function sendOps(opts: ClientOptions, ops: Operation[]): Promise<Delivery> {
  let response: Response;
  try {
    response = await call(opts, "POST", "ops/", { ops });
  } catch {
    return { kind: "failed", failure: "offline", status: 0 };
  }
  const out = await classify(response);
  if (out.kind !== "json") return out;
  const results = (out.body as { results?: OpResult[] })?.results;
  if (!Array.isArray(results)) return { kind: "failed", failure: "server", status: response.status };
  return { kind: "ok", results };
}

export interface ShoppingList {
  items: (ItemState & Record<string, unknown>)[];
  count: number;
  on_the_way: Record<string, unknown>[];
  /** Items fully covered by an open order: off the list, but "Arrived" and "Cancel" need their state. */
  on_the_way_items?: (ItemState & Record<string, unknown>)[];
  generated_at: string;
}

export async function fetchShoppingList(
  opts: ClientOptions
): Promise<{ kind: "ok"; list: ShoppingList } | Exclude<Delivery, { kind: "ok" }>> {
  let response: Response;
  try {
    response = await call(opts, "GET", "shopping-list/");
  } catch {
    return { kind: "failed", failure: "offline", status: 0 };
  }
  const out = await classify(response);
  if (out.kind !== "json") return out;
  return { kind: "ok", list: out.body as ShoppingList };
}

export type Fetched<T> = { kind: "ok"; body: T; status: number } | Exclude<Delivery, { kind: "ok" }>;

/**
 * Any JSON request under /api/ with the same failure rules as the queue's. `path` starts after "/api/".
 * Online-only actions (creating an item, editing its data) use it directly and are never queued.
 */
export async function requestJson<T>(
  opts: ClientOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<Fetched<T>> {
  let response: Response;
  try {
    response = await raw(opts, method, `/api/${path}`, body);
  } catch {
    return { kind: "failed", failure: "offline", status: 0 };
  }
  // A 204 has no body and no content type: success, not a server failure.
  if (response.status === 204) return { kind: "ok", body: null as T, status: 204 };
  const out = await classify(response);
  if (out.kind !== "json") return out;
  return { kind: "ok", body: out.body as T, status: response.status };
}

/** A refusal whose body carries more than the error (409 "exists" offers the existing item). */
export async function requestJsonWithRefusal<T, R>(
  opts: ClientOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<Fetched<T> | { kind: "conflict"; status: number; body: R }> {
  let response: Response;
  try {
    response = await raw(opts, method, `/api/${path}`, body);
  } catch {
    return { kind: "failed", failure: "offline", status: 0 };
  }
  if (response.status === 409 && (response.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      return { kind: "conflict", status: 409, body: (await response.json()) as R };
    } catch {
      return { kind: "failed", failure: "server", status: 409 };
    }
  }
  const out = await classify(response);
  if (out.kind !== "json") return out;
  return { kind: "ok", body: out.body as T, status: response.status };
}

const ws = (opts: ClientOptions) => `workspaces/${encodeURIComponent(opts.slug)}`;
const project = (opts: ClientOptions, projectId: string) =>
  `${ws(opts)}/projects/${encodeURIComponent(projectId)}/inventory`;

/**
 * Every item of one list (the project endpoint). The to-buy list leaves out items not on it, so this
 * is how the app refreshes those (an item a discarded entry made doubtful, or one viewed in stock).
 */
export async function fetchListItems(
  opts: ClientOptions,
  projectId: string,
  listId: string
): Promise<
  { kind: "ok"; items: ItemState[]; open_orders: Record<string, unknown>[] } | Exclude<Delivery, { kind: "ok" }>
> {
  const out = await requestJson<{ items?: ItemState[]; open_orders?: Record<string, unknown>[] }>(
    opts,
    "GET",
    `${project(opts, projectId)}/lists/${encodeURIComponent(listId)}/items/`
  );
  if (out.kind !== "ok") return out;
  return { kind: "ok", items: out.body?.items ?? [], open_orders: out.body?.open_orders ?? [] };
}

export interface Person {
  id: string;
  display_name: string;
}

export interface VisibleProject {
  id: string;
  name: string;
  identifier: string;
  /** 0 secret, 2 public (Project.network). */
  network: number;
  /** Everyone who can see this project's lists. */
  members: Person[];
  /** Workspace admins outside the project: each could add themselves (brief: Privacy). */
  admins_outside: number;
}

export interface VisibleList {
  id: string;
  name: string;
  project: string;
  default_mode: string;
  sort_order: number;
  item_count: number;
}

export interface Lists {
  me: Person;
  projects: VisibleProject[];
  lists: VisibleList[];
}

export const fetchLists = (opts: ClientOptions) => requestJson<Lists>(opts, "GET", `${ws(opts)}/inventory/lists/`);

export interface Suggestions {
  items: (ItemState & Record<string, unknown>)[];
  categories: string[];
  stores: string[];
}

export const fetchSuggestions = (opts: ClientOptions, query: string) =>
  requestJson<Suggestions>(opts, "GET", `${ws(opts)}/inventory/suggestions/?q=${encodeURIComponent(query)}`);

export interface Preferences {
  category_order: string[];
  default_grouping: "category" | "store" | "list" | "urgency";
}

export const fetchPreferences = (opts: ClientOptions) =>
  requestJson<Preferences>(opts, "GET", `${ws(opts)}/inventory/preferences/`);

export const savePreferences = (opts: ClientOptions, preferences: Preferences) =>
  requestJson<Preferences>(opts, "PUT", `${ws(opts)}/inventory/preferences/`, preferences);

export interface HistoryEntry {
  id: string;
  client_op_id: string;
  op: string;
  args: Record<string, unknown>;
  actor: Person | null;
  source: string;
  occurred_at: string;
  received_at: string;
  reverted: boolean;
}

export const fetchHistory = (opts: ClientOptions, projectId: string, itemId: string) =>
  requestJson<HistoryEntry[]>(opts, "GET", `${project(opts, projectId)}/items/${encodeURIComponent(itemId)}/history/`);

/** Online only: a new item is created by the server, never queued (brief: items are created online). */
export const createItem = (opts: ClientOptions, projectId: string, listId: string, data: Record<string, unknown>) =>
  requestJsonWithRefusal<
    ItemState & Record<string, unknown>,
    { error: string; item?: ItemState & Record<string, unknown> }
  >(opts, "POST", `${project(opts, projectId)}/lists/${encodeURIComponent(listId)}/items/`, data);

/** Online only: data fields, never state (state changes only through operations). */
export const updateItem = (opts: ClientOptions, projectId: string, itemId: string, data: Record<string, unknown>) =>
  requestJsonWithRefusal<ItemState & Record<string, unknown>, { error: string }>(
    opts,
    "PATCH",
    `${project(opts, projectId)}/items/${encodeURIComponent(itemId)}/`,
    data
  );
