// Sending the queue: one replay at a time per device (plan, phase 3), against a store whose every
// change is one atomic read-modify-write (an IndexedDB transaction in the app). A read, an await and a
// write would overwrite a tap made in between, or let an undo remove an entry already on the wire
// (phase 3 audit).

import type { ClientOptions } from "./client";
import { sendOps } from "./client";
import type { QueueState } from "./queue";
import { answeredCount, nextBatch, onDelivered, onFailed } from "./queue";
import type { Operation } from "./types";

export interface QueueStore {
  /** Atomically apply fn to the stored state and store the result. Taps and undos use it too. */
  update(fn: (state: QueueState) => QueueState): Promise<QueueState>;
}

export type Lock = (<T>(fn: () => Promise<T>) => Promise<T>) & {
  /** Exclusive across every tab and the worker (Web Locks): a "sending" found inside it is stale. */
  exclusive?: boolean;
};

interface LockManagerLike {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The device lock. Callers WAIT for it rather than skip: a caller that skipped while a replay was
 * finishing would leave its tap unsent until the next trigger (phase 3 audit). Web Locks serialise
 * across tabs and the worker; without them, a promise chain serialises within this JS context only.
 */
export function makeLock(locks: LockManagerLike | undefined): Lock {
  if (locks) {
    const lock: Lock = (fn) => locks.request("plane-inventory-replay", fn);
    lock.exclusive = true;
    return lock;
  }
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export const deviceLock: Lock = makeLock((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks);

/** Send everything sendable, batch after batch, until the queue is empty, held or failing. */
export async function replay(
  store: QueueStore,
  client: ClientOptions,
  currentUserId: string,
  now: () => number,
  lock: Lock = deviceLock
): Promise<void> {
  await lock(async () => {
    // Sequential on purpose: strict FIFO, one batch on the wire at a time.
    /* oxlint-disable no-await-in-loop */
    // Inside a device-wide lock nobody else is sending: a "sending" left by a tab that died mid-request
    // would otherwise block every tab until a reload (phase 3 re-review).
    if (lock.exclusive) await store.update((s) => (s.sending ? { ...s, sending: false } : s));
    for (;;) {
      let batch: Operation[] | null = null;
      await store.update((s) => {
        const next = nextBatch(s, now(), currentUserId);
        batch = next ? next.batch : null;
        return next ? next.state : s;
      });
      if (!batch) return;
      let progressed = false;
      try {
        const delivery = await sendOps(client, batch, currentUserId);
        await store.update((s) => {
          if (delivery.kind === "failed") return onFailed(s, delivery.failure, now(), { status: delivery.status });
          if (delivery.kind === "refused")
            return onFailed(s, "refused", now(), { status: delivery.status, error: delivery.error });
          // An answer that matches none of the batch is no progress: back off instead of looping.
          if (answeredCount(batch!, delivery.results) === 0) return onFailed(s, "server", now(), { status: 200 });
          progressed = true;
          return onDelivered(s, delivery.results);
        });
      } catch (error) {
        // Never leave the queue marked "sending": nothing else would clear it before a reload.
        await store.update((s) => onFailed(s, "server", now()));
        throw error;
      }
      if (!progressed) return;
    }
    /* oxlint-enable no-await-in-loop */
  });
}
