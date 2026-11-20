// The queue's storage format and its migrations. A queue written by one version of the app must be
// readable by the next ones (plan, phase 3): every format change adds a migration from n to n+1 here,
// and the tests read a stored queue of every past version.

import { createQueue, onRestart } from "./queue";
import type { QueueState } from "./queue";
import { newUuid } from "./ops";

export const STORAGE_VERSION = 1;

/**
 * One queue per user on this install: another user signing in on the same phone gets their own key,
 * and never loads or sends this one (brief: queue ownership).
 */
export function storageKey(userId: string): string {
  return `plane-inventory-queue:${userId}`;
}

/** A new queue for a user on this install, with its own queue_id (a UUID, as the server requires). */
export function newQueue(userId: string): QueueState {
  return createQueue(userId, newUuid());
}

export interface Stored {
  version: number;
  state: unknown;
}

export type Migration = (state: unknown) => unknown;

/** MIGRATIONS[n] turns a version-n state into a version-(n+1) state. None exist yet: version 1 is the first. */
export const MIGRATIONS: Record<number, Migration> = {};

export function serialize(state: QueueState): string {
  return JSON.stringify({ version: STORAGE_VERSION, state } satisfies Stored);
}

export type Loaded = { ok: true; state: QueueState } | { ok: false; reason: "newer" | "corrupt"; raw: string };

/**
 * Read a stored queue as it is, for an atomic read-modify-write inside the running app. A queue from a
 * NEWER app is kept as it is and the app asks to be updated, never discarded (brief: queue ownership).
 */
export function parse(
  raw: string,
  migrations: Record<number, Migration> = MIGRATIONS,
  current: number = STORAGE_VERSION
): Loaded {
  let stored: Stored;
  try {
    stored = JSON.parse(raw) as Stored;
  } catch {
    return { ok: false, reason: "corrupt", raw };
  }
  if (typeof stored?.version !== "number" || stored.state === null || typeof (stored.state as object) !== "object")
    return { ok: false, reason: "corrupt", raw };
  if (stored.version > current) return { ok: false, reason: "newer", raw };
  let state: unknown = stored.state;
  for (let v = stored.version; v < current; v++) {
    const step = migrations[v];
    if (!step) return { ok: false, reason: "corrupt", raw };
    state = step(state);
  }
  return { ok: true, state: state as QueueState };
}

/**
 * Read a stored queue when the app starts. Loading counts as a restart: no replay is running, and the
 * backoff is over. Never inside a running app's update: it would clear the "sending" of a live replay.
 */
export function load(
  raw: string,
  migrations: Record<number, Migration> = MIGRATIONS,
  current: number = STORAGE_VERSION
): Loaded {
  const out = parse(raw, migrations, current);
  return out.ok ? { ok: true, state: onRestart(out.state) } : out;
}
