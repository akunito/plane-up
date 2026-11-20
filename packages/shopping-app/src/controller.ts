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
  Lists,
  Notice,
  OpName,
  Preferences,
  QueueState,
} from "@plane/inventory";
import {
  approve,
  BACKOFF_MAX_MS,
  createItem,
  createQueue,
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
  workspaces: { slug: string; name: string }[];
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
  private readonly now: () => number;
  private readonly lock: Lock | undefined;
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
    };
  }

  // ---------------------------------------------------------------- React plumbing

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
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
      return this.set({ phase: "error", connection: settings.kind === "failed" ? settings.failure : "refused" });
    }
    // From here an offline fallback may open only this person's snapshot (phase 6 audit: a person who had
    // just signed in, then lost the network, was shown the previous person's lists and queue).
    this.confirmedUser = settings.body.id ?? null;
    const workspaces = await requestJson<{ slug: string; name: string }[]>(client, "GET", "users/me/workspaces/");
    const all =
      workspaces.kind === "ok" && Array.isArray(workspaces.body)
        ? workspaces.body.map((w) => ({ slug: w.slug, name: w.name }))
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
    if (!slug) return this.set({ phase: "no_workspace", workspaces: all });
    this.set({ slug, workspaces: all });
    await this.openWorkspace();
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
    if (lists.kind === "refused" && lists.status === 403) return this.set({ phase: "no_access" });
    if (lists.kind === "failed" && (lists.failure === "signed_out_app" || lists.failure === "signed_out_proxy"))
      return this.signedOut(lists.failure);
    if (lists.kind !== "ok") {
      if (lists.kind === "failed" && (await this.openOffline(lists.failure))) return;
      return this.set({ phase: "error", connection: lists.kind === "failed" ? lists.failure : "refused" });
    }
    prefs.set("slug", this.state.slug);
    // Who used this device last: an offline start opens their snapshot and queue (and only theirs).
    prefs.set("user", lists.body.me.id);
    this.confirmedUser = lists.body.me.id;
    if (lists.body.lists.length === 0) {
      this.openedOffline = false;
      return this.set({ phase: "no_inventory", lists: lists.body });
    }
    const key = `${lists.body.me.id}:${this.state.slug}`;
    if (this.storeKey && this.storeKey !== key) {
      // Another person or workspace than what is on screen (a reconnect after an offline start): nothing of
      // the previous one may carry over, or be saved into this one's snapshot (phase 6 audit), as in
      // switchWorkspace.
      this.watched.clear();
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.set({ known: {}, orders: [], covered: null, preferences: EMPTY_PREFERENCES, toast: null });
    }
    if (!this.store || this.storeKey !== key) {
      this.store = null;
      try {
        let store = this.stores.get(key);
        if (!store) {
          const open = this.deps.openStore ?? defaultStore;
          store = await open(lists.body.me.id, this.state.slug);
          this.stores.set(key, store);
        }
        this.store = store;
        this.storeKey = key;
      } catch (error) {
        if (error instanceof StoredQueueError)
          return this.set({ phase: error.reason === "newer" ? "newer" : "corrupt", lists: lists.body });
        throw error;
      }
    }
    const queue = await this.store.read();
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
    try {
      let store = this.stores.get(key);
      if (!store) {
        const open = this.deps.openStore ?? defaultStore;
        store = await open(userId, slug);
        this.stores.set(key, store);
      }
      this.store = store;
      this.storeKey = key;
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
   * The server says nobody is signed in. The device forgets who used it last, so an offline start never
   * shows that person's lists to whoever holds the device next (design: a shared device). Their queue
   * stays stored and is sent after they sign in again.
   */
  private signedOut(failure: FailureKind): void {
    prefs.set("user", null);
    this.set({ phase: "signed_out", connection: failure });
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
          // rather than show "No connection" for ever while taps pile up (phase 6 audit).
          this.openedOffline = false;
          this.signedOut(probe.failure);
          return;
        }
        if (probe.kind !== "ok") return; // still offline: stay on the snapshot
        // openedOffline stays set until openWorkspace holds the confirmed person's store.
        await this.startOnce();
        // A start that ended on another screen (no access, no inventory, an error) is not offline any more;
        // one that fell back to the snapshot again set the flag itself.
        if (this.state.phase !== "ready") this.openedOffline = false;
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
    let id: string | null = null;
    const tapOptions: { tick?: boolean; orderQuantity?: number } = {};
    if (options.tick !== undefined) tapOptions.tick = options.tick;
    if (options.orderQuantity !== undefined) tapOptions.orderQuantity = options.orderQuantity;
    await this.updateQueue((s) => {
      const next = tap(s, name, itemId, args, { now: this.now(), newId: newUuid }, tapOptions);
      id = next.entries[next.entries.length - 1]!.op.client_op_id;
      return next;
    });
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
  }

  /** "Discard all": one atomic change, so a replay cannot slip between two discards. */
  async discardMany(ids: string[]): Promise<void> {
    await this.updateQueue((s) => ids.reduce((acc, id) => discard(acc, id), s));
    void this.flush();
  }

  async discardHead(): Promise<void> {
    await this.updateQueue((s) => discardHead(s));
    void this.flush();
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
    if (!this.store || this.state.phase === "loading") return;
    const target = this.store;
    const store: AppStore = {
      update: (fn) => this.updateQueue(fn, target),
      read: () => target.read(),
    };
    const userId = this.state.queue.userId;
    const before = this.state.queue.entries.length;
    try {
      await replay(store, this.client(), userId, this.now, this.lock);
    } catch {
      // replay already marked the failure on the queue; the screen shows it.
    }
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

  async setGrouping(grouping: Grouping): Promise<void> {
    const preferences = { ...this.state.preferences, default_grouping: grouping };
    this.set({ preferences });
    const out = await savePreferences(this.client(), preferences);
    if (out.kind === "ok") this.set({ preferences: out.body });
  }

  private async learn(payloads: ItemData[], startedAt: number, target: AppStore | null): Promise<void> {
    if (!target || this.store !== target) return; // answered after a workspace switch
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
    win.addEventListener("focus", onFocus);
    win.addEventListener("online", onOnline);
    win.document.addEventListener("visibilitychange", onVisible);
    const timer = win.setInterval(() => {
      if (win.document.visibilityState === "visible" && this.state.phase === "ready") void this.refresh();
    }, POLL_MS);
    return () => {
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("online", onOnline);
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
    // IndexedDB refused (a private window): keep working, in memory.
    return memoryStore(newQueue(userId));
  }
}

export function entryOf(state: QueueState, clientOpId: string): Entry | undefined {
  return (
    state.entries.find((e) => e.op.client_op_id === clientOpId) ??
    state.recent.find((e) => e.op.client_op_id === clientOpId)
  );
}
