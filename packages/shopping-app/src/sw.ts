// The shopping app's service worker, scope /shopping/ (plan, phase 6). Built on its own by apps/web
// (vite.shopping-sw.config.ts) AFTER the app, from whose output it takes the precache list and version.
// Registered only by main.tsx: anything the main bundle imports must never register a worker (gate L3-11).
//
// Update path: a new version precaches everything first and fails its install on any wrong response, so
// the old one keeps serving; then it takes over at once (skipWaiting, claim) and the page reloads itself
// the next time it is hidden (main.tsx). The queue lives in IndexedDB, never in a cache: no version
// change can drop it.

import { deviceLock } from "@plane/inventory";
import { idbStoreQuiet, storedQueues } from "./store";
import { CACHE_PREFIX, SYNC_TAG, fromCaches, precacheInto, rotateCaches, sendQueues } from "./worker-core";

// The few worker types used here, declared locally: the "webworker" lib clashes with "dom" in the one
// TypeScript program this package type-checks as.
interface WaitEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchWaitEvent extends WaitEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface SyncWaitEvent extends WaitEvent {
  readonly tag: string;
}
interface MessageWaitEvent extends WaitEvent {
  readonly data: unknown;
  readonly source: { postMessage(message: unknown): void } | null;
}
interface WorkerScope {
  readonly location: Location;
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string }): Promise<{ postMessage(message: unknown): void }[]>;
  };
}
declare const self: WorkerScope;
declare const __SW_VERSION__: string;
declare const __SW_ASSETS__: string[];

function on<E extends Event>(type: string, listener: (event: E) => void): void {
  (self as unknown as EventTarget).addEventListener(type, listener as EventListener);
}

const SCOPE = "/shopping/";
const CACHE = CACHE_PREFIX + __SW_VERSION__;

function precache(): Promise<void> {
  return precacheInto({
    fetchImpl: (req) => fetch(req),
    caches,
    cacheName: CACHE,
    assets: __SW_ASSETS__,
    scope: SCOPE,
  });
}

on<WaitEvent>("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

on<WaitEvent>("activate", (event) => {
  event.waitUntil(
    (async () => {
      await rotateCaches(caches, CACHE);
      await self.clients.claim();
    })()
  );
});

on<FetchWaitEvent>("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // The API and everything outside the app go to the network untouched.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (url.pathname === `${SCOPE}sw.js`) return;
  if (req.mode === "navigate") {
    // A launch from the icon and every in-scope navigation get the shell; the hash carries the route.
    event.respondWith(caches.match(SCOPE, { cacheName: CACHE }).then((hit) => hit ?? fetch(req)));
    return;
  }
  event.respondWith(fromCaches(caches, CACHE, req, (r) => fetch(r)));
});

async function sendAndTell(): Promise<void> {
  const out = await sendQueues({
    fetchImpl: fetch.bind(globalThis),
    base: "",
    listQueues: () => storedQueues(),
    openStore: idbStoreQuiet,
    lock: deviceLock,
    now: Date.now,
  });
  // Open pages show the queue they read last: tell them to read it again.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker Client, not a window: no target origin
  for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "queue-changed" });
  // Rejecting tells the browser the sync did not finish, so it fires again when it next sees a network.
  if (out.kind === "retry") throw new Error("not delivered");
}

on<SyncWaitEvent>("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(sendAndTell());
});

on<MessageWaitEvent>("message", (event) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker Client, not a window: no target origin
  if (event.data === "version" && event.source) event.source.postMessage({ version: __SW_VERSION__ });
});
