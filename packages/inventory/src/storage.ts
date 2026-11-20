// The queue's storage format and its migrations. A queue written by one version of the app must be
// readable by the next ones (plan, phase 3): every format change adds a migration from n to n+1 here,
// and the tests read a stored queue of every past version.

import type { QueueState } from "./queue";

export const STORAGE_VERSION = 1;

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
 * Read a stored queue. A queue from a NEWER app is kept as it is and the app asks to be updated,
 * never discarded (brief: queue ownership).
 */
export function load(
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
  return { ok: true, state: { ...(state as QueueState), sending: false } };
}
