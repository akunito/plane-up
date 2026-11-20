// One replay at a time per device (plan, phase 3): two tabs, a background sync and a foreground flush
// must never send the same operation concurrently. The Web Locks API serialises across tabs and the
// worker where the browser has it; the in-memory flag covers the rest.

import type { ClientOptions } from "./client";
import { sendOps } from "./client";
import type { QueueState } from "./queue";
import { nextBatch, onDelivered, onFailed } from "./queue";

export interface QueueStore {
  read(): Promise<QueueState>;
  write(state: QueueState): Promise<void>;
}

export type Lock = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

let running = false;

/** The device lock: Web Locks when present (ifAvailable: a second caller skips instead of waiting). */
export const deviceLock: Lock = async (fn) => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    return locks.request("plane-inventory-replay", { ifAvailable: true }, async (lock) => (lock ? fn() : undefined));
  }
  if (running) return undefined;
  running = true;
  try {
    return await fn();
  } finally {
    running = false;
  }
};

/** Send everything sendable, batch after batch, until the queue is empty, held, blocked or failing. */
export async function replay(
  store: QueueStore,
  client: ClientOptions,
  currentUserId: string,
  now: () => number,
  lock: Lock = deviceLock
): Promise<"done" | "busy"> {
  const out = await lock(async () => {
    // Sequential on purpose: strict FIFO, one batch on the wire at a time.
    /* oxlint-disable no-await-in-loop */
    for (;;) {
      const state = await store.read();
      const next = nextBatch(state, now(), currentUserId);
      if (!next) return "done" as const;
      await store.write(next.state);
      const delivery = await sendOps(client, next.batch);
      const latest = await store.read();
      if (delivery.kind === "ok") {
        await store.write(onDelivered(latest, delivery.results));
      } else {
        // "refused" is the whole request (e.g. more than 100 operations): nothing was applied, so it is
        // retried like a failure and the user sees the queue blocked.
        await store.write(onFailed(latest, delivery.kind === "failed" ? delivery.failure : "server", now()));
        return "done" as const;
      }
    }
    /* oxlint-enable no-await-in-loop */
  });
  return out ?? "busy";
}
