// Where the queue lives on the device. One IndexedDB record per user (storage.ts storageKey), changed only
// by atomic read-modify-write inside one readwrite transaction: the function runs synchronously inside
// the transaction, so a tap in another tab cannot land between the read and the write (phase 3 audit:
// a read, an await and a write loses updates).

import type { QueueState, QueueStore } from "@plane/inventory";
import { load, newQueue, parse, serialize, storageKey } from "@plane/inventory";

export interface AppStore extends QueueStore {
  /** The stored state, without changing it. */
  read(): Promise<QueueState>;
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
  first: boolean
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
          const loaded = first ? load(raw) : parse(raw);
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
 * The app's store. The first access of this install counts as a restart (storage.ts load): no replay
 * survives a reload.
 */
export async function idbStore(userId: string, factory: IDBFactory = indexedDB): Promise<AppStore> {
  const db = await openDb(factory);
  const key = storageKey(userId);
  await transact(db, key, userId, (s) => s, true);
  return {
    update: (fn) => transact(db, key, userId, fn, false),
    read: () => transact(db, key, userId, (s) => s, false),
  };
}

/** For tests, and when IndexedDB is unavailable (a private window may refuse it). */
export function memoryStore(initial: QueueState): AppStore {
  let state = initial;
  return {
    update: async (fn) => (state = fn(state)),
    read: async () => state,
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
