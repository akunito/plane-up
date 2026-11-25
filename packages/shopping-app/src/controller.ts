// The app's state and everything that changes it: loading, polling, taps, undo, sending, online-only
// edits. React reads it through useSyncExternalStore (app.tsx); tests drive it with a fake fetch and a
// memory store.
//
// Polling (brief, Designer defaults): on focus, on reconnect, after the device's own operations and every
// 20 s while a screen is visible. The queue is per user AND workspace (storage.ts storageKey): a workspace
// switch opens the other workspace's queue, and a replay already running keeps writing to the queue it
// started with. The queue holds every tap until it is answered, so nothing is lost when a request fails.
//
// Offline (phase 6): every successful read is saved as a snapshot per user and workspace (store.ts), and a
// start that cannot reach the server opens from the last one, with the queue, and says so. When the
// connection returns, the app starts again in full, which also notices another person signed in on this
// device (their queue and snapshot are another key).

import type {
  ClientOptions,
  Entry,
  FailureKind,
  Fetched,
  ImageEnv,
  Lists,
  Notice,
  OpName,
  Preferences,
  QueueState,
} from "@plane/inventory";
import {
  approve,
  browserImageEnv,
  removePhoto,
  retryOutdated,
  sameFailure,
  shrinkPhoto,
  uploadPhoto,
  BACKOFF_MAX_MS,
  createItem,
  createQueue,
  deleteItem,
  deviceLock,
  discard,
  discardHead,
  dismiss,
  fetchListItems,
  fetchLists,
  fetchPreferences,
  fetchShoppingList,
  fetchSuggestions,
  finishShopping,
  newQueue,
  newUuid,
  applyAnyway,
  refreshed,
  replay,
  requestJson,
  retryNow,
  savePreferences,
  tap,
  undo,
  updateItem,
} from "@plane/inventory";
import type { Lock } from "@plane/inventory";
import type { AppStore, Snapshot, SnapshotStore } from "./store";
import { discardStored, idbSnapshots, idbStore, memoryStore, prefs, StoredQueueError } from "./store";
import type { Grouping, ItemData, Known, Order } from "./model";
import { dropMissingFromList, mergeFetched, mergeSnapshot } from "./model";

export const POLL_MS = 20_000;
/** "Done" empties itself after six hours without a tick (brief, Designer defaults). */
export const DONE_RESET_MS = 6 * 60 * 60 * 1000;
const TOAST_MS = 6_000;

export type Phase =
  | "corrupt"
  | "loading"
  | "ready"
  | "signed_out"
  | "no_workspace"
  | "no_access"
  | "no_inventory"
  | "error"
  | "newer";

export interface Toast {
  id: number;
  /** Text already translated by the screen that made it. */
  text: string;
  /** The entry an "Undo" would revert; absent for order actions, which have no undo (brief). */
  undoId?: string;
}

export interface AppState {
  phase: Phase;
  slug: string;
  /** role: the person's workspace role (20 admin), as users/me/workspaces/ answers it. */
  workspaces: { slug: string; name: string; role?: number }[];
  lists: Lists | null;
  known: Record<string, Known>;
  orders: Order[];
  /** Answers already in when the last to-buy snapshot started: its On the way covers them (model openOrders). */
  covered: ReadonlySet<string> | null;
  queue: QueueState;
  preferences: Preferences;
  /** The last request failure that is not the queue's own (refresh, edits). */
  connection: FailureKind | null;
  toast: Toast | null;
  lastTickAt: number;
  /** When what is shown was read from the server; set when the app opened from a saved snapshot. */
  offlineSince: number | null;
  /** The device cannot keep changes: the queue lives in memory, or a write to it failed (phase 9 review). */
  storageProblem: "volatile" | "write_failed" | null;
}

/** One row of the main app's lite project list (GET workspaces/{slug}/projects/), as the drawer reads it. */
export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  member_role?: number | null;
  archived_at?: string | null;
  sort_order?: number | null;
  logo_props?: { in_use?: string; emoji?: { value?: string }; icon?: { name?: string; color?: string } } | null;
  cycle_view?: boolean;
  module_view?: boolean;
  issue_views_view?: boolean;
  page_view?: boolean;
  inbox_view?: boolean;
  inventory_view?: boolean;
}

export interface Deps {
  base: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** A store for the given user and workspace; defaults to IndexedDB, falling back to memory. */
  openStore?: (userId: string, workspace: string) => Promise<AppStore>;
  lock?: Lock;
  /** The workspace in the address, if any. */
  slug?: string | null;
  /** Where the last server answer is kept for an offline start; defaults to IndexedDB. */
  snapshots?: SnapshotStore;
  /**
   * Called after every change that leaves something to send (a tap, an undo, an approval): main.tsx
   * asks the worker for a one-off background sync, which the browser fires once it sees a network.
   */
  onQueued?: () => void;
  /** Decoding and re-encoding a photo; the browser's canvas by default (tests pass a fake). */
  imageEnv?: ImageEnv;
}

type Listener = () => void;

const EMPTY_PREFERENCES: Preferences = { category_order: [], default_grouping: "category" };

export class Controller {
  private state: AppState;
  private listeners = new Set<Listener>();
  private store: AppStore | null = null;
  /** user:workspace of the open store. */
  private storeKey = "";
  /**
   * Every store opened in this page load, by user:workspace: switching back reuses it instead of
   * opening (and restarting) it again, and the in-memory fallback keeps a workspace's waiting taps
   * across switches (phase 4 re-review).
   */
  private stores = new Map<string, AppStore>();
  /** Items whose tick is being written (act): a second tick meanwhile is ignored. */
  private ticking = new Set<string>();
  private readonly now: () => number;
  private readonly lock: Lock | undefined;
  private readonly imageEnv: ImageEnv;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lists an inventory screen is showing: reloaded with every refresh. */
  private watched = new Set<string>();
  private toastSeq = 0;
  private readonly snapshots: SnapshotStore;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Opened from a snapshot: the next sign of a connection starts the app again in full. */
  private openedOffline = false;
  private restarting: Promise<void> | null = null;
  /** Who the server said is signed in during this start (settings, then lists); null before it answered. */
  private confirmedUser: string | null = null;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.lock = deps.lock;
    this.imageEnv = deps.imageEnv ?? (browserImageEnv as ImageEnv);
    this.snapshots = deps.snapshots ?? safeSnapshots();
    this.state = {
      phase: "loading",
      slug: deps.slug ?? "",
      workspaces: [],
      lists: null,
      known: {},
      orders: [],
      covered: null,
      queue: createQueue("", ""),
      preferences: EMPTY_PREFERENCES,
      connection: null,
      toast: null,
      lastTickAt: Number(prefs.get("lastTickAt") ?? 0),
      offlineSince: null,
      storageProblem: null,
    };
  }

  // ---------------------------------------------------------------- React plumbing

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    // Any answer saying nobody is signed in (a start, a refresh, a list) makes the device forget who used
    // it last (a replay's: flush). Not from patch.queue: a queue keeps its last failure until something is
    // delivered, so a stale "signed out" re-cleared the user of a person signed in again (phase 6 review).
    if (patch.connection === "signed_out_app" || patch.connection === "signed_out_proxy") this.forgetPerson();
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  client(): ClientOptions {
    const opts: ClientOptions = { base: this.deps.base, slug: this.state.slug };
    if (this.deps.fetchImpl) opts.fetchImpl = this.deps.fetchImpl;
    return opts;
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<void> {
    try {
      await this.startOnce();
    } catch {
      // Anything unexpected ends on a screen with "Try again", never on "Loading…" for ever.
      this.set({ phase: "error" });
    }
  }

  private async startOnce(): Promise<void> {
    const client = this.client();
    this.confirmedUser = null;
    const settings = await requestJson<{
      id?: string;
      workspace?: { last_workspace_slug?: string | null; fallback_workspace_slug?: string | null };
    }>(client, "GET", "users/me/settings/");
    if (
      settings.kind === "failed" &&
      (settings.failure === "signed_out_app" || settings.failure === "signed_out_proxy")
    )
      return this.signedOut(settings.failure);
    if (settings.kind !== "ok") {
      if (settings.kind === "failed" && (await this.openOffline(settings.failure))) return;
      return this.leave({ phase: "error", connection: settings.kind === "failed" ? settings.failure : "refused" });
    }
    // From here an offline fallback may open only this person's snapshot (phase 6 audit: a person who had
    // just signed in, then lost the network, was shown the previous person's lists and queue).
    this.confirmedUser = settings.body.id ?? null;
    const workspaces = await requestJson<{ slug: string; name: string; role?: number }[]>(
      client,
      "GET",
      "users/me/workspaces/"
    );
    const all =
      workspaces.kind === "ok" && Array.isArray(workspaces.body)
        ? workspaces.body.map((w) => {
            const out: { slug: string; name: string; role?: number } = { slug: w.slug, name: w.name };
            if (typeof w.role === "number") out.role = w.role;
            return out;
          })
        : [];
    const remembered = prefs.get("slug");
    // A workspace named by a link (?ws=, main.tsx) or the remembered one counts only when the person is in
    // it (phase 5 re-review: an unknown one ended on "no access" with a picker that could not change).
    const listed = (slug: string | null | undefined) =>
      slug && (all.length === 0 || all.some((w) => w.slug === slug)) ? slug : "";
    const slug =
      listed(this.state.slug) ||
      listed(remembered) ||
      settings.body.workspace?.last_workspace_slug ||
      settings.body.workspace?.fallback_workspace_slug ||
      "";
    if (!slug) return this.leave({ phase: "no_workspace", workspaces: all });
    this.set({ slug, workspaces: all });
    await this.openWorkspace();
  }

  /** The workspace's projects for the Plane drawer, or why not ("offline": no network; "failed": refused or
   * unreadable). Never touches the app's state: a refused read here is not the app's signed-out signal. */
  async planeProjects(): Promise<PlaneProject[] | "offline" | "failed"> {
    if (!this.state.slug) return "failed";
    const r = await requestJson<PlaneProject[]>(
      this.client(),
      "GET",
      `workspaces/${encodeURIComponent(this.state.slug)}/projects/`
    );
    if (r.kind === "ok" && Array.isArray(r.body)) return r.body;
    return r.kind === "failed" && r.failure === "offline" ? "offline" : "failed";
  }

  async switchWorkspace(slug: string): Promise<void> {
    this.watched.clear();
    // A toast from the other workspace would offer an Undo this one cannot do.
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.set({ slug, phase: "loading", lists: null, known: {}, orders: [], covered: null, toast: null });
    try {
      await this.openWorkspace();
    } catch {
      this.set({ phase: "error" });
    }
  }

  /** The person chose to throw away a stored queue that cannot be read. */
  async discardStoredQueue(): Promise<void> {
    const me = this.state.lists?.me.id;
    if (!me) return;
    await discardStored(me, this.state.slug);
    this.set({ phase: "loading" });
    await this.start();
  }

  private async openWorkspace(): Promise<void> {
    const lists = await fetchLists(this.client());
    // 403: a workspace guest, or not a member (guests have no access to inventory, brief).
    if (lists.kind === "refused" && lists.status === 403) return this.leave({ phase: "no_access" });
    if (lists.kind === "failed" && (lists.failure === "signed_out_app" || lists.failure === "signed_out_proxy"))
      return this.signedOut(lists.failure);
    if (lists.kind !== "ok") {
      if (lists.kind === "failed" && (await this.openOffline(lists.failure))) return;
      return this.leave({ phase: "error", connection: lists.kind === "failed" ? lists.failure : "refused" });
    }
    prefs.set("slug", this.state.slug);
    // Who used this device last: an offline start opens their snapshot and queue (and only theirs).
    prefs.set("user", lists.body.me.id);
    this.confirmedUser = lists.body.me.id;
    if (lists.body.lists.length === 0) {
      this.openedOffline = false;
      return this.leave({ phase: "no_inventory", lists: lists.body });
    }
    const key = `${lists.body.me.id}:${this.state.slug}`;
    if (this.storeKey && this.storeKey !== key) {
      // Another person or workspace than what is on screen (a reconnect after an offline start): nothing of
      // the previous one may carry over, or be saved into this one's snapshot (phase 6 audit), as in
      // switchWorkspace.
      this.watched.clear();
      if (this.toastTimer) clearTimeout(this.toastTimer);
      // "loading" while the other store opens: a tap on the old screen would find no store and be lost,
      // and the emptied list would flash (phase 6 re-review).
      this.set({ phase: "loading", known: {}, orders: [], covered: null, preferences: EMPTY_PREFERENCES, toast: null });
    }
    if (!this.store || this.storeKey !== key) {
      this.store = null;
      try {
        let store = this.stores.get(key);
        if (!store) {
          const open = this.deps.openStore ?? defaultStore;
          store = await open(lists.body.me.id, this.state.slug);
          this.stores.set(key, store);
          await store.update(retryOutdated);
        }
        this.store = store;
        this.storeKey = key;
        if (store.volatile) this.set({ storageProblem: "volatile" });
      } catch (error) {
        if (error instanceof StoredQueueError)
          return this.set({ phase: error.reason === "newer" ? "newer" : "corrupt", lists: lists.body });
        throw error;
      }
    }
    // A "wrong_user" refusal was about another person's session; this is the owner's: try at once.
    let queue = await this.store.read();
    if (queue.failure?.kind === "refused" && queue.failure.error === "wrong_user")
      queue = await this.updateQueue(retryNow, this.store);
    this.set({ lists: lists.body, queue });
    // The store is now the confirmed person's: sending, refreshing and saving the snapshot are safe again.
    // Not earlier (phase 6 audit): a tap or poll while the start ran sent the snapshot's queue with the
    // session of whoever is signed in now, and saved their lists under the previous person's key.
    this.openedOffline = false;
    const prefsOut = await fetchPreferences(this.client());
    if (prefsOut.kind === "ok") this.set({ preferences: prefsOut.body });
    await this.refresh();
    this.expireDone();
    this.set({ phase: "ready", offlineSince: null });
    this.saveSnapshot();
    void this.flush();
  }

  /**
   * Opens from the last snapshot when the server cannot be reached (no network, or a server or proxy
   * failure): the list, the queue and "Done" as they were, with a line saying so. Not for a sign-out:
   * the person must sign in again, and showing their list is no help then. False when there is nothing
   * saved for the last user and workspace.
   */
  private async openOffline(failure: FailureKind): Promise<boolean> {
    if (failure !== "offline" && failure !== "server") return false;
    const userId = this.confirmedUser ?? prefs.get("user");
    const slug = this.state.slug || prefs.get("slug") || "";
    if (!userId || !slug) return false;
    const snap = await this.snapshots.load(userId, slug);
    if (!snap) return false;
    const key = `${userId}:${slug}`;
    // Closed first: a StoredQueueError below must not leave the previous workspace's store open.
    this.store = null;
    this.storeKey = "";
    try {
      let store = this.stores.get(key);
      if (!store) {
        const open = this.deps.openStore ?? defaultStore;
        store = await open(userId, slug);
        this.stores.set(key, store);
        await store.update(retryOutdated);
      }
      this.store = store;
      this.storeKey = key;
      if (store.volatile) this.set({ storageProblem: "volatile" });
    } catch (error) {
      if (error instanceof StoredQueueError) {
        this.set({ phase: error.reason === "newer" ? "newer" : "corrupt", lists: snap.lists as Lists });
        return true;
      }
      throw error;
    }
    const queue = await this.store.read();
    this.openedOffline = true;
    this.set({
      slug,
      workspaces: snap.workspaces,
      lists: snap.lists as Lists,
      known: snap.known as Record<string, Known>,
      orders: snap.orders as Order[],
      covered: snap.covered ? new Set(snap.covered) : null,
      preferences: (snap.preferences as Preferences) ?? EMPTY_PREFERENCES,
      queue,
      connection: failure,
      offlineSince: snap.savedAt,
    });
    this.expireDone();
    this.set({ phase: "ready" });
    void this.flush();
    return true;
  }

  /**
   * Whether the open store is the confirmed person's, for the workspace on screen. Sending and writing
   * server answers into the queue happen only then (phase 6 re-review: a start that ended on "no access",
   * "no inventory" or an error kept the snapshot's store, and the next focus sent its queue with the
   * session of whoever is signed in now).
   */
  private ownsStore(): boolean {
    return !!this.store && !!this.confirmedUser && this.storeKey === `${this.confirmedUser}:${this.state.slug}`;
  }

  /**
   * Nobody is signed in any more, or not the person this page started as: forget the device's last user
   * (design: a shared device; the main app's sign-out clears it too; their queue stays stored), and treat
   * the page as unconfirmed, so the next send or refresh first probes the server and starts again in full,
   * opening the store of whoever is signed in then (phase 6 review: a page kept open across a sign-out and
   * another person's sign-in sent the first one's queue with the second one's session).
   */
  private forgetPerson(): void {
    prefs.set("user", null);
    this.confirmedUser = null;
    this.openedOffline = true;
  }

  /** A start or switch that ended on another screen: no queue is open for it (see ownsStore). */
  private leave(patch: Partial<AppState>): void {
    this.store = null;
    this.storeKey = "";
    // Nothing of the person or workspace that was open may carry into the next start: with storeKey
    // cleared, openWorkspace's switch reset does not run (phase 6 review: the previous person's items
    // reached the next person's snapshot after a sign-out and another sign-in on an open page).
    this.watched.clear();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.set({
      lists: null,
      known: {},
      orders: [],
      covered: null,
      preferences: EMPTY_PREFERENCES,
      toast: null,
      offlineSince: null,
      ...patch,
    });
  }

  /**
   * The server says nobody is signed in. The device forgets who used it last, so an offline start never
   * shows that person's lists to whoever holds the device next (design: a shared device). Their queue
   * stays stored and is sent after they sign in again.
   */
  private signedOut(failure: FailureKind): void {
    this.confirmedUser = null;
    this.leave({ phase: "signed_out", connection: failure });
  }

  /** Opened offline and a connection may be back: start again in full (once at a time). */
  private reconnect(): Promise<void> {
    if (!this.openedOffline) return Promise.resolve();
    this.restarting ??= (async () => {
      try {
        const client = this.client();
        const probe = await requestJson(client, "GET", "users/me/settings/");
        if (probe.kind === "failed" && (probe.failure === "signed_out_app" || probe.failure === "signed_out_proxy")) {
          // The network is back but the session is gone (a proxy session expired meanwhile): ask to sign in
          // rather than show "No connection" for ever while taps pile up (phase 6 audit). signedOut() leaves
          // the page unconfirmed (forgetPerson), so the sign-in screen probes once per focus and starts
          // again by itself when someone has signed in.
          this.signedOut(probe.failure);
          return;
        }
        if (probe.kind !== "ok") return; // still offline: stay on the snapshot
        // openedOffline stays set until openWorkspace holds the confirmed person's store.
        await this.startOnce();
        // A start that ended on another screen (no access, no inventory, an error) is not offline any more;
        // one that fell back to the snapshot again set the flag itself; the sign-in screen keeps it (above).
        if (this.state.phase !== "ready" && this.state.phase !== "signed_out") this.openedOffline = false;
      } catch {
        this.set({ phase: "error" });
      } finally {
        this.restarting = null;
      }
    })();
    return this.restarting;
  }

  /** Saves what is on screen for an offline start. Debounced: a refresh and its list loads write once. */
  private saveSnapshot(): void {
    if (this.openedOffline) return; // nothing new to save; and never overwrite with an older copy
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const s = this.state;
      const userId = s.lists?.me.id;
      if (s.phase !== "ready" || !userId || !s.slug || this.storeKey !== `${userId}:${s.slug}`) return;
      const snap: Snapshot = {
        v: 1,
        savedAt: this.now(),
        userId,
        slug: s.slug,
        workspaces: s.workspaces,
        lists: s.lists,
        known: s.known,
        orders: s.orders,
        covered: s.covered ? [...s.covered] : null,
        preferences: s.preferences,
      };
      void this.snapshots.save(snap);
    }, 300);
  }

  // ---------------------------------------------------------------- reading

  /** The to-buy list and "On the way", plus every list an inventory screen is showing. Coalesced. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          // Sequential on purpose: one fetch at a time, again only if asked while one was running.
          // oxlint-disable-next-line no-await-in-loop
          await this.refreshOnce();
        } while (this.refreshAgain);
      } finally {
        // Cleared here, in the same turn as the last check of refreshAgain: a `.finally()` outside ran a
        // microtask later, and a refresh asked in between was dropped (phase 4 audit).
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    if (this.openedOffline) {
      // Not awaited: the full start it may run calls refresh() itself, which would wait for this very
      // refresh (a deadlock, found by the offline tests).
      void this.reconnect();
      return;
    }
    if (!this.ownsStore()) return;
    const target = this.store;
    if (!target) return; // a focus event while the app is still opening
    const startedAt = this.now();
    const covered = new Set(this.state.queue.recent.map((e) => e.op.client_op_id));
    // What the device held for each item when the request started: the snapshot's verdict covers it.
    const revsAtStart: Record<string, number> = {};
    for (const [id, s] of Object.entries(this.state.queue.known)) revsAtStart[id] = s.rev;
    const out = await fetchShoppingList(this.client());
    // A workspace switch while it was in flight: the answer belongs to the other workspace's queue.
    if (this.store !== target) return;
    if (out.kind !== "ok") return this.set({ connection: out.kind === "failed" ? out.failure : "refused" });
    const payloads = [...out.list.items, ...(out.list.on_the_way_items ?? [])] as unknown as ItemData[];
    await this.updateQueue((s) => refreshed(s, payloads), target);
    if (this.store !== target) return;
    this.set({
      known: mergeSnapshot(this.state.known, payloads, startedAt, revsAtStart),
      orders: out.list.on_the_way as unknown as Order[],
      covered,
      connection: null,
    });
    await Promise.all([...this.watched].map((id) => this.loadList(id)));
    this.saveSnapshot();
  }

  watch(listId: string, on: boolean): void {
    if (on) this.watched.add(listId);
    else this.watched.delete(listId);
  }

  /** Every item of one list, for the inventory screen. */
  async loadList(listId: string): Promise<void> {
    // Server answers go into the queue only when the page knows whose it is (see ownsStore).
    if (this.openedOffline || !this.ownsStore()) return;
    const list = this.state.lists?.lists.find((l) => l.id === listId);
    if (!list) return;
    const target = this.store;
    if (!target) return;
    const startedAt = this.now();
    const out = await fetchListItems(this.client(), list.project, listId);
    if (this.store !== target) return;
    if (out.kind !== "ok") return this.set({ connection: out.kind === "failed" ? out.failure : "refused" });
    const payloads = out.items as unknown as ItemData[];
    await this.updateQueue((s) => refreshed(s, payloads), target);
    if (this.store !== target) return;
    // Open orders of this list: upserted. Closed ones disappear with the next to-buy fetch, which lists
    // every open order the viewer can see.
    const orders = new Map(this.state.orders.map((o) => [o.id, o]));
    for (const o of out.open_orders as unknown as Order[]) orders.set(o.id, o);
    this.set({
      known: dropMissingFromList(mergeFetched(this.state.known, payloads, startedAt), listId, payloads, startedAt),
      orders: [...orders.values()],
      connection: null,
    });
    this.saveSnapshot();
  }

  /** Quick capture's search. The items it returns become known, so a tap on one can be queued. */
  async search(query: string): Promise<{ ids: string[]; categories: string[]; stores: string[] } | null> {
    if (this.openedOffline || !this.ownsStore()) {
      void this.reconnect();
      return null;
    }
    const target = this.store;
    const startedAt = this.now();
    const out = await fetchSuggestions(this.client(), query);
    if (!target || this.store !== target) return null;
    if (out.kind !== "ok") {
      this.set({ connection: out.kind === "failed" ? out.failure : "refused" });
      return null;
    }
    const payloads = out.body.items as unknown as ItemData[];
    await this.updateQueue((s) => refreshed(s, payloads), target);
    if (this.store !== target) return null;
    this.set({ known: mergeFetched(this.state.known, payloads, startedAt), connection: null });
    return { ids: payloads.map((p) => p.id), categories: out.body.categories, stores: out.body.stores };
  }

  // ---------------------------------------------------------------- the queue

  private async updateQueue(
    fn: (s: QueueState) => QueueState,
    target: AppStore | null = this.store
  ): Promise<QueueState> {
    if (!target) throw new Error("no store");
    const next = await target.update(fn);
    // Only the open workspace's queue is on screen; a replay of the previous one still lands in its own.
    if (target === this.store) this.set({ queue: next });
    return next;
  }

  /**
   * One tap: queued at once, shown at once (the queue's preview), sent right after. Returns the entry's
   * id, or null when the item is not known (nothing queued).
   */
  async act(
    name: OpName,
    itemId: string,
    args: Record<string, unknown>,
    options: { tick?: boolean; orderQuantity?: number; toast?: string } = {}
  ): Promise<string | null> {
    if (!this.state.queue.known[itemId]) return null;
    // A second tick on the same row while the first is still being written: the checkbox has not turned yet,
    // and both would buy (phase 9 review: a double tap bought twice).
    if (options.tick) {
      if (this.ticking.has(itemId)) return null;
      this.ticking.add(itemId);
    }
    let id: string | null = null;
    const tapOptions: { tick?: boolean; orderQuantity?: number } = {};
    if (options.tick !== undefined) tapOptions.tick = options.tick;
    if (options.orderQuantity !== undefined) tapOptions.orderQuantity = options.orderQuantity;
    try {
      await this.updateQueue((s) => {
        const next = tap(s, name, itemId, args, { now: this.now(), newId: newUuid }, tapOptions);
        id = next.entries[next.entries.length - 1]!.op.client_op_id;
        return next;
      });
    } catch (error) {
      // The tap was not stored: say so instead of losing it silently (phase 9 review). A stored queue another tab
      // left unreadable or newer gets its own screen; anything else (quota, a browser error) is "not saved".
      // Never rethrown: every caller is `void c.act(...)`, so a rejection would be unhandled and the tap lost unseen.
      if (error instanceof StoredQueueError) this.set({ phase: error.reason === "newer" ? "newer" : "corrupt" });
      else this.set({ storageProblem: "write_failed" });
      return null;
    } finally {
      if (options.tick) this.ticking.delete(itemId);
    }
    if (this.state.storageProblem === "write_failed") this.set({ storageProblem: null });
    if (options.tick) {
      prefs.set("lastTickAt", String(this.now()));
      this.set({ lastTickAt: this.now() });
    }
    if (options.toast !== undefined) {
      const order = name === "mark_ordered" || name === "arrived" || name === "cancel";
      this.showToast(options.toast, order ? undefined : (id ?? undefined));
    }
    void this.flush();
    return id;
  }

  /** Undo an entry. False when there is nothing to undo (the queue returned the same state). */
  async undo(clientOpId: string): Promise<boolean> {
    let changed = false;
    await this.updateQueue((s) => {
      const next = undo(s, clientOpId, { now: this.now(), newId: newUuid });
      changed = next !== s;
      return next;
    });
    this.set({ toast: null });
    void this.flush();
    return changed;
  }

  async finishShopping(): Promise<void> {
    await this.updateQueue((s) => finishShopping(s, this.now()));
  }

  /** "Done" also empties itself after six hours without a tick. */
  expireDone(): void {
    const last = this.state.lastTickAt;
    if (Object.keys(this.state.queue.done).length > 0 && last > 0 && this.now() - last > DONE_RESET_MS)
      void this.finishShopping();
  }

  async approve(ids: string[]): Promise<void> {
    await this.updateQueue((s) => approve(s, ids, this.now()));
    void this.flush();
  }

  async discard(id: string): Promise<void> {
    await this.updateQueue((s) => discard(s, id));
    void this.flush();
    void this.refreshDoubtful();
  }

  /** "Discard all": one atomic change, so a replay cannot slip between two discards. */
  async discardMany(ids: string[]): Promise<void> {
    await this.updateQueue((s) => ids.reduce((acc, id) => discard(acc, id), s));
    void this.flush();
    void this.refreshDoubtful();
  }

  async discardHead(): Promise<void> {
    await this.updateQueue((s) => discardHead(s));
    void this.flush();
    void this.refreshDoubtful();
  }

  /**
   * Items a discarded, possibly applied entry left doubtful (queue needsRefresh): their lists are read again,
   * which also reaches items not on the to-buy list (phase 9 review: needsRefresh was kept but never acted on).
   */
  async refreshDoubtful(): Promise<void> {
    const lists = new Set<string>();
    for (const id of this.state.queue.needsRefresh) {
      const list = this.state.known[id]?.data.list.id ?? this.state.queue.known[id]?.list?.id;
      if (list) lists.add(list);
    }
    await Promise.all([...lists].map((list) => this.loadList(list)));
  }

  async applyAnyway(notice: Notice): Promise<void> {
    await this.updateQueue((s) => applyAnyway(s, notice, { now: this.now(), newId: newUuid }));
    void this.flush();
  }

  async dismiss(notice: Notice): Promise<void> {
    await this.updateQueue((s) => dismiss(s, notice));
  }

  async retry(): Promise<void> {
    if (!this.store) return; // still opening, or on the corrupt screen
    await this.updateQueue((s) => retryNow(s));
    await this.flush();
  }

  /** Send what can be sent, then read the lists again (polling after one's own operations). */
  /** The worker sent (part of) a queue: show what is stored now, then read the lists again. */
  async reloadQueue(): Promise<void> {
    const target = this.store;
    if (!target) return;
    const queue = await target.read();
    if (this.store === target) this.set({ queue });
    await this.refresh();
  }

  async flush(): Promise<void> {
    if (this.state.queue.entries.length > 0) this.deps.onQueued?.();
    // Opened offline, nobody has confirmed who is signed in: sending now could apply this queue as
    // someone else. The full start after reconnecting opens the signed-in person's queue and sends it.
    if (this.openedOffline) return this.reconnect();
    if (!this.ownsStore() || this.state.phase === "loading") return;
    const target = this.store!;
    const store: AppStore = {
      update: (fn) => this.updateQueue(fn, target),
      read: () => target.read(),
    };
    const userId = this.state.queue.userId;
    const before = this.state.queue.entries.length;
    const failureBefore = this.state.queue.failure;
    // Checked again inside the device lock: a flush queued behind one that saw a sign-out must not send.
    const outer = this.lock ?? deviceLock;
    const lock: Lock = Object.assign(
      <T>(fn: () => Promise<T>) =>
        outer(() =>
          this.openedOffline || !this.ownsStore() || this.store !== target ? Promise.resolve(undefined as T) : fn()
        ),
      outer.exclusive ? { exclusive: true } : {}
    );
    try {
      await replay(store, this.client(), userId, this.now, lock);
    } catch {
      // replay already marked the failure on the queue; the screen shows it.
    }
    // A failure this replay recorded: onFailed always counts another attempt. Compared by content: the IndexedDB
    // store hands back a freshly parsed queue on every update, so an unchanged failure was never the same object
    // and an old "signed out" made every flush forget the person and restart (phase 9 review).
    const failure = this.state.queue.failure;
    if (
      failure &&
      !sameFailure(failure, failureBefore) &&
      (failure.kind === "signed_out_app" ||
        failure.kind === "signed_out_proxy" ||
        // The server: the session is not this queue's owner (the device changed hands without a sign-out
        // this page saw). Start again as whoever is signed in.
        (failure.kind === "refused" && failure.error === "wrong_user"))
    )
      this.forgetPerson();
    this.scheduleRetry();
    if (before > 0 || this.state.queue.entries.length > 0) await this.refresh();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const failure = this.state.queue.failure;
    // Only a real backoff in the future. A failure whose time has passed means the replay that just ran
    // had nothing it could send (a held head waits for the person): retrying then loops every 50 ms
    // (phase 4 audit). The person's approve, discard or "retry" calls flush() themselves.
    // And not past BACKOFF_MAX_MS ahead, which nextBatch treats as a clock jump and ignores: a timer that
    // far out overflows setTimeout and fires at once, every time (phase 4 re-review).
    const ahead = failure ? failure.nextTryAt - this.now() : 0;
    if (!failure || this.state.queue.entries.length === 0 || ahead <= 0 || ahead > BACKOFF_MAX_MS) return;
    const wait = Math.max(failure.nextTryAt - this.now(), 0) + 50;
    this.retryTimer = setTimeout(() => void this.flush(), wait);
  }

  // ---------------------------------------------------------------- online-only edits

  /** Create an item in a list. "exists" carries the existing item, which the screen then offers. */
  async createItem(
    listId: string,
    name: string,
    mode?: string
  ): Promise<{ kind: "created"; id: string } | { kind: "exists"; id: string | null } | { kind: "failed" }> {
    // Not before the page knows who is signed in: the item would be created as whoever holds the session.
    if (this.openedOffline || !this.ownsStore()) {
      void this.reconnect();
      return { kind: "failed" };
    }
    const list = this.state.lists?.lists.find((l) => l.id === listId);
    if (!list) return { kind: "failed" };
    const target = this.store;
    const startedAt = this.now();
    const body: Record<string, unknown> = { name };
    if (mode) body.mode = mode;
    const out = await createItem(this.client(), list.project, listId, body);
    if (out.kind === "conflict") {
      const existing = out.body.item as unknown as ItemData | undefined;
      if (existing) await this.learn([existing], startedAt, target);
      return { kind: "exists", id: existing?.id ?? null };
    }
    if (out.kind !== "ok") {
      this.set({ connection: out.kind === "failed" ? out.failure : "refused" });
      return { kind: "failed" };
    }
    await this.learn([out.body as unknown as ItemData], startedAt, target);
    return { kind: "created", id: out.body.id };
  }

  /** Edit an item's data (never its state). Returns the error field on a refusal. */
  async updateItem(
    itemId: string,
    data: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.openedOffline || !this.ownsStore()) {
      void this.reconnect();
      return { ok: false, error: "offline" };
    }
    const item = this.state.known[itemId]?.data;
    if (!item) return { ok: false, error: "gone" };
    const target = this.store;
    const startedAt = this.now();
    const out = await updateItem(this.client(), item.project.id, itemId, data);
    if (out.kind === "conflict") return { ok: false, error: "exists" };
    if (out.kind === "refused") return { ok: false, error: out.error };
    if (out.kind !== "ok") {
      this.set({ connection: out.failure });
      return { ok: false, error: out.failure };
    }
    await this.learn([out.body as unknown as ItemData], startedAt, target);
    return { ok: true };
  }

  /**
   * Deletes the item (APLANE-81): online only, like the main app's delete (soft, the server's DELETE). Refused while
   * the device still holds changes to it: they would come back "gone" and the person would not know they were lost.
   */
  async deleteItem(itemId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.openedOffline || !this.ownsStore()) {
      void this.reconnect();
      return { ok: false, error: "offline" };
    }
    const item = this.state.known[itemId]?.data;
    if (!item) return { ok: false, error: "gone" };
    if (this.state.queue.entries.some((e) => e.op.target === itemId)) return { ok: false, error: "waiting" };
    const target = this.store;
    const out = await deleteItem(this.client(), item.project.id, itemId);
    if (out.kind === "failed") {
      this.set({ connection: out.failure });
      return { ok: false, error: out.failure };
    }
    if (out.kind === "refused") return { ok: false, error: out.status === 404 ? "gone" : out.error };
    if (this.store !== target) return { ok: true }; // a workspace switch meanwhile: the next load reads the server
    const known = { ...this.state.known };
    delete known[itemId];
    this.set({ known });
    this.saveSnapshot();
    void this.refresh();
    return { ok: true };
  }

  /** The item's photo (APLANE-66): shrunk on the device, then uploaded; online only, like every data edit. */
  async setPhoto(itemId: string, file: Blob): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.photoEdit(itemId, async (projectId, confirming) => {
      let shrunk: Blob | null;
      try {
        shrunk = await shrinkPhoto(file, this.imageEnv);
      } catch {
        return { kind: "refused", status: 0, error: "photo_unreadable" };
      }
      if (!shrunk) return { kind: "refused", status: 0, error: "too_large" };
      return uploadPhoto<ItemData>(this.client(), projectId, itemId, shrunk, confirming);
    });
  }

  removePhoto(itemId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.photoEdit(itemId, (projectId) => removePhoto<ItemData>(this.client(), projectId, itemId));
  }

  private async photoEdit(
    itemId: string,
    run: (projectId: string, confirming: () => void) => Promise<Fetched<ItemData>>
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.openedOffline || !this.ownsStore()) {
      void this.reconnect();
      return { ok: false, error: "offline" };
    }
    const item = this.state.known[itemId]?.data;
    if (!item) return { ok: false, error: "gone" };
    const target = this.store;
    let startedAt = this.now();
    const out = await run(item.project.id, () => {
      startedAt = this.now();
    });
    if (out.kind === "refused") return { ok: false, error: out.error };
    if (out.kind !== "ok") {
      this.set({ connection: out.failure });
      return { ok: false, error: out.failure };
    }
    await this.learn([out.body], startedAt, target);
    return { ok: true };
  }

  async setGrouping(grouping: Grouping): Promise<void> {
    const preferences = { ...this.state.preferences, default_grouping: grouping };
    this.set({ preferences });
    const out = await savePreferences(this.client(), preferences);
    if (out.kind === "ok") this.set({ preferences: out.body });
  }

  private async learn(payloads: ItemData[], startedAt: number, target: AppStore | null): Promise<void> {
    if (!target || this.store !== target || this.openedOffline || !this.ownsStore()) return; // a switch meanwhile
    await this.updateQueue((s) => refreshed(s, payloads), target);
    if (this.store !== target) return;
    this.set({ known: mergeFetched(this.state.known, payloads, startedAt) });
    this.saveSnapshot();
  }

  // ---------------------------------------------------------------- toasts

  showToast(text: string, undoId?: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const toast: Toast = { id: ++this.toastSeq, text };
    if (undoId !== undefined) toast.undoId = undoId;
    this.set({ toast });
    this.toastTimer = setTimeout(() => this.set({ toast: null }), TOAST_MS);
  }

  dismissToast(): void {
    this.set({ toast: null });
  }

  // ---------------------------------------------------------------- the browser's signals

  /** Focus, reconnect and every 20 s while visible. Returns a function that stops it. */
  attach(win: Window): () => void {
    const onFocus = () => {
      this.expireDone();
      void this.refresh();
      void this.flush();
    };
    const onOnline = () => {
      void this.retry();
      void this.refresh(); // reconnect is a polling point even with nothing queued
    };
    const onVisible = () => {
      if (win.document.visibilityState === "visible") onFocus();
    };
    // The main app's sign-out clears the last user (same origin): this page is no longer sure whose it is.
    const onStorage = (e: StorageEvent) => {
      // Cleared (a sign-out), or another tab confirmed someone else.
      if (e.key === "plane-shopping:user" && this.confirmedUser && e.newValue !== this.confirmedUser)
        this.forgetPerson();
    };
    win.addEventListener("focus", onFocus);
    win.addEventListener("online", onOnline);
    win.addEventListener("storage", onStorage);
    win.document.addEventListener("visibilitychange", onVisible);
    const timer = win.setInterval(() => {
      if (win.document.visibilityState === "visible" && this.state.phase === "ready") void this.refresh();
    }, POLL_MS);
    return () => {
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("online", onOnline);
      win.removeEventListener("storage", onStorage);
      win.document.removeEventListener("visibilitychange", onVisible);
      win.clearInterval(timer);
    };
  }
}

function safeSnapshots(): SnapshotStore {
  // No IndexedDB (a private window, tests): no offline start, nothing else changes.
  return typeof indexedDB === "undefined" ? { load: async () => null, save: async () => {} } : idbSnapshots();
}

async function defaultStore(userId: string, workspace: string): Promise<AppStore> {
  try {
    return await idbStore(userId, workspace);
  } catch (error) {
    if (error instanceof StoredQueueError) throw error;
    // IndexedDB refused (a private window, storage full, a browser error): keep working, in memory, and say so —
    // silently, a page kill lost every tap and the worker could not send them (phase 9 review).
    return { ...memoryStore(newQueue(userId)), volatile: true };
  }
}

export function entryOf(state: QueueState, clientOpId: string): Entry | undefined {
  return (
    state.entries.find((e) => e.op.client_op_id === clientOpId) ??
    state.recent.find((e) => e.op.client_op_id === clientOpId)
  );
}
