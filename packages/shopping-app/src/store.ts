// Where the queue lives on the device. One IndexedDB record per user and workspace (storage.ts storageKey), changed only
// by atomic read-modify-write inside one readwrite transaction: the function runs synchronously inside
// the transaction, so a tap in another tab cannot land between the read and the write (phase 3 audit:
// a read, an await and a write loses updates).

import type { Migration, QueueState, QueueStore } from "@plane/inventory";
import { load, newQueue, parse, serialize, storageKey } from "@plane/inventory";

export interface AppStore extends QueueStore {
  /** The stored state, without changing it. */
  read(): Promise<QueueState>;
  /** Nothing survives the page (IndexedDB refused): the screen says so (phase 9 review). */
  volatile?: boolean;
}

export class StoredQueueError extends Error {
  constructor(readonly reason: "newer" | "corrupt") {
    super(`stored queue is ${reason}`);
  }
}

const DB = "plane-shopping";
const STORE = "kv";

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB, 1);
    open.addEventListener("upgradeneeded", () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    });
    open.addEventListener("success", () => resolve(open.result));
    open.addEventListener("error", () => reject(open.error));
  });
}

function transact(
  db: IDBDatabase,
  key: string,
  userId: string,
  fn: (state: QueueState) => QueueState,
  first: boolean,
  migrations?: Record<number, Migration>
): Promise<QueueState> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let result: QueueState | undefined;
    let failure: unknown;
    const get = store.get(key);
    get.addEventListener("success", () => {
      try {
        const raw = get.result as string | undefined;
        let state: QueueState;
        if (raw === undefined) state = newQueue(userId);
        else {
          const loaded = first ? load(raw) : parse(raw, migrations);
          if (!loaded.ok) throw new StoredQueueError(loaded.reason);
          state = loaded.state;
        }
        const next = fn(state);
        result = next;
        if (next !== state || raw === undefined || first) store.put(serialize(next), key);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
    tx.addEventListener("complete", () => resolve(result!));
    tx.addEventListener("abort", () => reject(failure ?? tx.error));
    tx.addEventListener("error", () => reject(failure ?? tx.error));
  });
}

/**
 * The app's store. Opening it counts as a restart (storage.ts load): once per page load, tab and workspace (the controller keeps what it opened), which
 * is safe while another tab replays only because replay runs under the exclusive Web Lock and clears a
 * stale "sending" inside it.
 */
export async function idbStore(userId: string, workspace: string, factory: IDBFactory = indexedDB): Promise<AppStore> {
  const db = await openDb(factory);
  const key = storageKey(userId, workspace);
  await transact(db, key, userId, (s) => s, true);
  return {
    update: (fn) => transact(db, key, userId, fn, false),
    read: () => transact(db, key, userId, (s) => s, false),
  };
}

/**
 * Throw away a stored queue that cannot be read (corrupt). Only on the person's explicit choice, on the
 * screen that says what is lost; a queue from a NEWER app is never offered for this.
 */
export async function discardStored(userId: string, workspace: string, factory: IDBFactory = indexedDB): Promise<void> {
  const db = await openDb(factory);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(storageKey(userId, workspace));
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error));
    tx.addEventListener("error", () => reject(tx.error));
  });
}

/** For tests, and when IndexedDB is unavailable (a private window may refuse it). */
/**
 * Keeps the queue serialized, as IndexedDB does: every update and read gets a freshly parsed copy, so code that
 * compares queue objects by identity fails here as it does on the phone (phase 9 review: the tests ran on a store
 * that kept identity and missed exactly that).
 */
export function memoryStore(initial: QueueState): AppStore {
  let stored = serialize(initial);
  const fresh = (): QueueState => {
    const loaded = parse(stored);
    if (!loaded.ok) throw new StoredQueueError(loaded.reason);
    return loaded.state;
  };
  return {
    update: async (fn) => {
      const state = fresh();
      const next = fn(state);
      if (next !== state) stored = serialize(next);
      return next;
    },
    read: async () => fresh(),
  };
}

/** Per-device conveniences only (workspace, grouping, list filter, last tick). Never the queue. */
export const prefs = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(`plane-shopping:${key}`) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) globalThis.localStorage?.removeItem(`plane-shopping:${key}`);
      else globalThis.localStorage?.setItem(`plane-shopping:${key}`, value);
    } catch {
      // Storage refused (private window, quota): the app works without these.
    }
  },
};

/**
 * The last thing the server said, per user and workspace, so the app opens offline with the list it last
 * showed (plan, phase 6: cold start from the icon with no network). Separate from the queue on purpose:
 * the queue is the device's truth and must be read atomically; the snapshot is a cache that may be lost.
 * A missing or unreadable snapshot is simply "nothing to show offline".
 */
export interface Snapshot {
  v: 1;
  savedAt: number;
  userId: string;
  slug: string;
  workspaces: { slug: string; name: string }[];
  lists: unknown;
  known: unknown;
  orders: unknown;
  /** client_op_ids the last to-buy snapshot covered (null before any). */
  covered: string[] | null;
  preferences: unknown;
}

const snapshotKey = (userId: string, workspace: string) => `plane-shopping-snapshot:${userId}:${workspace}`;

export interface SnapshotStore {
  load(userId: string, workspace: string): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export function idbSnapshots(factory: IDBFactory = indexedDB): SnapshotStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= openDb(factory));
  return {
    async load(userId, workspace) {
      try {
        const d = await open();
        const raw = await new Promise<unknown>((resolve, reject) => {
          const get = d.transaction(STORE, "readonly").objectStore(STORE).get(snapshotKey(userId, workspace));
          get.addEventListener("success", () => resolve(get.result));
          get.addEventListener("error", () => reject(get.error));
        });
        if (typeof raw !== "string") return null;
        const parsed = JSON.parse(raw) as Snapshot;
        return parsed?.v === 1 && parsed.userId === userId && parsed.slug === workspace ? parsed : null;
      } catch {
        return null;
      }
    },
    async save(snapshot) {
      try {
        const d = await open();
        await new Promise<void>((resolve, reject) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(JSON.stringify(snapshot), snapshotKey(snapshot.userId, snapshot.slug));
          tx.addEventListener("complete", () => resolve());
          tx.addEventListener("abort", () => reject(tx.error));
          tx.addEventListener("error", () => reject(tx.error));
        });
      } catch {
        // A cache: losing a write only means an older list offline.
      }
    },
  };
}

export function memorySnapshots(): SnapshotStore {
  const all = new Map<string, Snapshot>();
  return {
    load: async (userId, workspace) => all.get(snapshotKey(userId, workspace)) ?? null,
    save: async (s) => void all.set(snapshotKey(s.userId, s.slug), s),
  };
}

/** Every stored queue on this device (the worker sends them for whoever is signed in). */
export async function storedQueues(factory: IDBFactory = indexedDB): Promise<{ userId: string; workspace: string }[]> {
  const db = await openDb(factory);
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error));
  });
  const out: { userId: string; workspace: string }[] = [];
  const prefix = storageKey("", "").split(":")[0] + ":";
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith(prefix)) continue;
    const [userId, ...rest] = k.slice(prefix.length).split(":");
    if (userId && rest.length > 0) out.push({ userId, workspace: rest.join(":") });
  }
  return out;
}

/**
 * The queue for the worker: never counts as a restart (idbStore's first open clears "sending" flags,
 * which is safe in a page only because its replay runs under the device lock; the worker may open it
 * while a page is replaying).
 *
 * Rule for every future storage version (phase 6 audit): the worker reads only queues stored in ITS OWN
 * version and never migrates one. A new worker takes over at once (skipWaiting) while an open page may
 * still run the old bundle until its next hide; a queue the worker migrated would read as "newer" there,
 * and every tap made in that page would be refused. Older queues wait for the page, which migrates them.
 */
export async function idbStoreQuiet(
  userId: string,
  workspace: string,
  factory: IDBFactory = indexedDB
): Promise<AppStore> {
  const db = await openDb(factory);
  const key = storageKey(userId, workspace);
  const noMigrations: Record<number, Migration> = {};
  return {
    update: (fn) => transact(db, key, userId, fn, false, noMigrations),
    read: () => transact(db, key, userId, (s) => s, false, noMigrations),
  };
}
