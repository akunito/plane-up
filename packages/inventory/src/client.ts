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
}

const HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json",
};

async function call(opts: ClientOptions, method: string, path: string, body?: unknown) {
  const f = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method,
    headers: HEADERS,
    redirect: "manual",
    credentials: "same-origin",
    cache: "no-store",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return f(`${opts.base}/api/workspaces/${encodeURIComponent(opts.slug)}/inventory/${path}`, init);
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
  const body = (await response.json()) as unknown;
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
