// The service worker's logic, apart from its event wiring (sw.ts) so tests can drive it with fakes.
//
// Precache (plan, phase 6; M1, measured in phase 0): a file missing under /shopping/ is answered 200 with
// the MAIN app's index.html, so a status check caches HTML as JavaScript and the next offline start is
// blank. Every response must carry the content type of the file asked for, and the shell must be the
// shopping app's (its marker), or the install fails and the old version keeps serving.
//
// Sending (M10): the browser fires a one-off background sync once it sees a network again, while it is
// alive; the worker then sends the stored queues of the person signed in now, never anyone else's (the
// server would apply them as whoever holds the session cookie).

import type { ClientOptions, Lock } from "@plane/inventory";
import { isHeld, replay, requestJson, retryNow, waiting } from "@plane/inventory";
import type { AppStore } from "./store";

export const SHELL_MARKER = 'name="plane-shopping-shell"';
export const SYNC_TAG = "plane-shopping-queue";
export const CACHE_PREFIX = "plane-shopping-";
/** Caches left by earlier workers at this scope: the phase 0 stub's ("shopping-stub-…") and older versions. */
export const OLD_CACHE_PREFIXES = ["shopping-stub-", CACHE_PREFIX] as const;

/** The caches an activating worker deletes: every older one except the newest previous version's. APLANE-83
 * (measured on the Realme 2026-11-26): a reload answered by the old worker got the old shell; the new worker then
 * activated, deleted the old cache and claimed the page, so the old shell's script came from the network, where
 * it no longer exists → blank page. Keeping one version back lets that page finish loading (it reloads into the
 * new version on its next hide). `keys` is in creation order (CacheStorage.keys()). */
export function cachesToDelete(keys: readonly string[], current: string): string[] {
  const old = keys.filter((k) => k !== current && OLD_CACHE_PREFIXES.some((p) => k.startsWith(p)));
  let keep = -1;
  for (let i = old.length - 1; i >= 0; i--)
    if (old[i]!.startsWith(CACHE_PREFIX)) {
      keep = i;
      break;
    }
  return keep < 0 ? old : old.filter((_, i) => i !== keep);
}

/** A file of the app: this version's cache, then the version kept back (cachesToDelete), then the network. */
export async function fromCaches(
  cachesImpl: Pick<CacheStorage, "match">,
  cacheName: string,
  req: Request,
  fetchImpl: (req: Request) => Promise<Response>
): Promise<Response> {
  return (
    (await cachesImpl.match(req, { cacheName, ignoreSearch: true })) ??
    (await cachesImpl.match(req, { ignoreSearch: true })) ??
    fetchImpl(req)
  );
}

const TYPES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  css: "text/css",
  json: "json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/",
  webp: "image/webp",
  woff2: "font/woff2",
  html: "text/html",
};

/** The content type a precached URL must come with; the scope URL itself is the HTML shell. */
export function expectedType(url: string, scope: string): string {
  const path = new URL(url, "https://x").pathname;
  if (path === scope || path.endsWith("/")) return "text/html";
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "";
}

/** Null when the response may be cached for `url`; otherwise why not. */
export async function precacheProblem(url: string, res: Response, scope: string): Promise<string | null> {
  if (!res.ok) return `${url}: HTTP ${res.status}`;
  if (res.redirected || res.type === "opaqueredirect") return `${url}: redirected`;
  const want = expectedType(url, scope);
  if (!want) return `${url}: no known content type for this file`;
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes(want)) return `${url}: ${type || "no content type"}, expected ${want}`;
  if (want === "text/html" && !(await res.clone().text()).includes(SHELL_MARKER))
    return `${url}: HTML without the shopping shell's marker (the main app's page?)`;
  return null;
}

export interface PrecacheDeps {
  fetchImpl: (req: Request) => Promise<Response>;
  caches: Pick<CacheStorage, "open" | "has" | "delete">;
  cacheName: string;
  assets: readonly string[];
  scope: string;
}

/**
 * Fetches and checks EVERY file before touching any cache, then stores them (phase 6 audit: writing as
 * each answer arrived and deleting the cache on a refusal could delete the cache the active worker serves
 * from, when a new worker had the same version name). A cache that existed before is never deleted; one
 * this install created is removed if storing fails half way. Throws, failing the install, on any problem.
 */
export async function precacheInto(deps: PrecacheDeps): Promise<void> {
  // Without the shell nothing opens offline; the gate cannot see a dropped shell (the scope string is in the
  // bundle anyway), so the install refuses it and the dev E2E (worker controls the page) goes red.
  if (!deps.assets.some((u) => new URL(u, "https://x").pathname === deps.scope))
    throw new Error(`precache refused: the shell ${deps.scope} is not in the list`);
  const fetched = await Promise.all(
    deps.assets.map(async (url) => {
      const res = await deps.fetchImpl(
        new Request(url, { cache: "reload", credentials: "same-origin", redirect: "manual" })
      );
      return { url, res, problem: await precacheProblem(url, res, deps.scope) };
    })
  );
  const problems = fetched.flatMap((f) => (f.problem ? [f.problem] : []));
  if (problems.length > 0) throw new Error(`precache refused: ${problems.join("; ")}`);
  const existed = await deps.caches.has(deps.cacheName);
  const cache = await deps.caches.open(deps.cacheName);
  try {
    await Promise.all(fetched.map((f) => cache.put(f.url, f.res)));
  } catch (error) {
    if (!existed) await deps.caches.delete(deps.cacheName);
    throw error;
  }
}

export interface SendDeps {
  fetchImpl: typeof fetch;
  base: string;
  listQueues: () => Promise<{ userId: string; workspace: string }[]>;
  openStore: (userId: string, workspace: string) => Promise<AppStore>;
  lock: Lock;
  now: () => number;
}

export type SendOutcome =
  /** Nobody is signed in, or the person signed in has nothing queued. */
  | { kind: "nothing" }
  /** Sent what could be sent; `waiting` are still queued for a reason the person must see (held, refused). */
  | { kind: "sent"; waiting: number }
  /** No network or a server failure: the browser should fire the sync again later. */
  | { kind: "retry" };

/** Sends every stored queue of the person signed in now. */
export async function sendQueues(deps: SendDeps): Promise<SendOutcome> {
  const client: ClientOptions = { base: deps.base, slug: "", fetchImpl: deps.fetchImpl };
  const me = await requestJson<{ id?: string }>(client, "GET", "users/me/");
  if (me.kind === "failed" && (me.failure === "offline" || me.failure === "server")) return { kind: "retry" };
  const userId = me.kind === "ok" ? me.body?.id : undefined;
  if (!userId) return { kind: "nothing" }; // signed out: the queue waits for its owner
  const mine = (await deps.listQueues()).filter((q) => q.userId === userId);
  if (mine.length === 0) return { kind: "nothing" };
  let left = 0;
  let retry = false;
  for (const q of mine) {
    // Sequential: one replay at a time per device, and the lock is shared with every open tab.
    // One unreadable queue (corrupt, or stored by another app version) is skipped, never the rest
    // (phase 6 audit); the page shows it on its own screen. Not a retry: it will not read better later.
    try {
      // oxlint-disable-next-line no-await-in-loop
      const store = await deps.openStore(q.userId, q.workspace);
      // A sync means the network is back: the backoff is over (as when the app opens or goes online).
      // oxlint-disable-next-line no-await-in-loop
      await store.update(retryNow);
      try {
        // oxlint-disable-next-line no-await-in-loop
        await replay(store, { ...client, slug: q.workspace }, q.userId, deps.now, deps.lock);
      } catch {
        // replay marked the failure on the queue.
      }
      // oxlint-disable-next-line no-await-in-loop
      const after = await store.read();
      const n = waiting(after);
      left += n;
      // Not when the head is held: the person must answer first, and a retry would only burn the browser's
      // background-sync attempts (decision 3 audit).
      const head = after.entries[0];
      if (
        n > 0 &&
        !(head && isHeld(head, deps.now())) &&
        (after.failure?.kind === "offline" || after.failure?.kind === "server")
      )
        retry = true;
    } catch {
      // skipped, see above
    }
  }
  return retry ? { kind: "retry" } : { kind: "sent", waiting: left };
}
