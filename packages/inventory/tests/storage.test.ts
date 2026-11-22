import { describe, expect, it } from "vitest";

import { OP_VERSION } from "../src/ops";
import { createQueue } from "../src/queue";
import { load, parse, serialize, STORAGE_VERSION } from "../src/storage";
import type { Migration } from "../src/storage";

describe("storage", () => {
  it("round-trips the current version and forgets a running replay", () => {
    const state = { ...createQueue("ana", "q"), sending: true };
    const loaded = load(serialize(state));
    expect(loaded).toMatchObject({ ok: true, state: { userId: "ana", queueId: "q", sending: false } });
  });

  it("reads a queue written by version n with the app at n+1 and at n+2", () => {
    // The chain the real MIGRATIONS will follow: each step n -> n+1, applied in order.
    const v1 = JSON.stringify({ version: 1, state: { userId: "ana", queueId: "q", entries: [] } });
    const migrations: Record<number, Migration> = {
      1: (s) => ({ ...(s as object), known: {}, done: {} }),
      2: (s) => ({ ...(s as object), notices: [], recent: [], needsRefresh: [], failure: null }),
    };
    expect(load(v1, migrations, 2)).toMatchObject({ ok: true, state: { known: {}, done: {} } });
    expect(load(v1, migrations, 3)).toMatchObject({ ok: true, state: { known: {}, notices: [], recent: [] } });
  });

  it("a queue stored by every past version loads with its operations in this build's format (S25)", () => {
    // Written as storage version 1 wrote it, operation format 1. Raising OP_VERSION without a migration that
    // rewrites queued operations fails here: the new build would send the old format, be refused again and
    // stay blocked behind "Update the app" (queue.ts, outdated; phase 9 audit).
    const op = { v: 1, client_op_id: "c1", queue_id: "q", target: "milk", op: "buy", args: {} };
    const entry = { op, tappedAt: 1, transmission: "never", attempts: 0 };
    const v1 = JSON.stringify({ version: 1, state: { ...createQueue("ana", "q"), entries: [entry] } });
    const loaded = load(v1);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.state.entries.map((e) => e.op.v)).toEqual([OP_VERSION]);
  });

  it("keeps a queue from a newer app instead of discarding it, and never guesses a missing step", () => {
    const newer = JSON.stringify({ version: STORAGE_VERSION + 1, state: {} });
    expect(load(newer)).toEqual({ ok: false, reason: "newer", raw: newer });
    expect(load(JSON.stringify({ version: 1, state: {} }), {}, 2)).toMatchObject({ ok: false, reason: "corrupt" });
    expect(load("{nope")).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("parse, used inside the running app's atomic updates, keeps a live replay's sending flag and backoff", () => {
    const failing = {
      ...createQueue("ana", "q"),
      sending: true,
      failure: { kind: "server" as const, attempts: 2, nextTryAt: 99 },
    };
    expect(parse(serialize(failing))).toMatchObject({ ok: true, state: { sending: true, failure: { nextTryAt: 99 } } });
    expect(load(serialize(failing))).toMatchObject({ ok: true, state: { sending: false } });
    const newer = JSON.stringify({ version: STORAGE_VERSION + 1, state: {} });
    expect(parse(newer)).toEqual({ ok: false, reason: "newer", raw: newer });
  });
});
