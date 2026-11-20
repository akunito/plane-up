// One replay at a time per device, against an atomic store (plan, phase 3; phase 3 audit).
// Steps the fake network one release at a time, so its awaits are sequential on purpose; `finished` is
// set by a promise callback the linter cannot see.
/* oxlint-disable no-await-in-loop, no-unmodified-loop-condition */

import { describe, expect, it } from "vitest";

import { createQueue, refreshed, tap } from "../src/queue";
import type { QueueState } from "../src/queue";
import { makeLock, replay } from "../src/replay";
import type { QueueStore } from "../src/replay";
import type { ItemState } from "../src/types";
import { ModelServer } from "./model-server";

const milk: ItemState = {
  id: "milk",
  rev: 0,
  mode: "units",
  needed: false,
  level: null,
  quantity: 0,
  min_quantity: 1,
  restock_to: null,
  last_bought_at: null,
  last_bought_by: null,
};

function setup(answer?: (ops: never[]) => Response | Promise<Response>) {
  const server = new ModelServer([milk]);
  let state: QueueState = refreshed(createQueue("ana", crypto.randomUUID()), [milk]);
  const store: QueueStore & { get: () => QueueState } = {
    update: async (fn) => (state = fn(state)),
    get: () => state,
  };
  let calls = 0;
  const pending: (() => void)[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const { ops } = JSON.parse(init.body as string);
    await new Promise<void>((resolve) => pending.push(resolve));
    if (answer) return answer(ops);
    return new Response(JSON.stringify({ results: server.apply(ops, "ana") }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const release = async () => {
    while (pending.length) pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  const add = async (n: number) => {
    for (let i = 0; i < n; i++)
      await store.update((s) => tap(s, "adjust", "milk", { delta: 1 }, { now: 0, newId: () => crypto.randomUUID() }));
  };
  return { server, store, client: { base: "", slug: "home", fetchImpl }, calls: () => calls, release, add };
}

async function settle(p: Promise<unknown>, release: () => Promise<void>) {
  let finished = false;
  void p.then(
    () => (finished = true),
    () => (finished = true)
  );
  for (let i = 0; i < 50 && !finished; i++) await release();
  await p;
}

const LOCKS = {
  "web locks": makeLock({
    // A faithful single-context Web Locks: requests for the same name wait in order.
    request: (() => {
      let tail: Promise<unknown> = Promise.resolve();
      return <T>(_name: string, fn: () => Promise<T>) => {
        const run = tail.then(fn);
        tail = run.catch(() => undefined);
        return run;
      };
    })(),
  }),
  "in-memory chain": makeLock(undefined),
};

describe.each(Object.entries(LOCKS))("with %s", (_name, lock) => {
  it("two replays started at once deliver each operation once", async () => {
    const t = setup();
    await t.add(5);
    const both = Promise.all([
      replay(t.store, t.client, "ana", () => 0, lock),
      replay(t.store, t.client, "ana", () => 0, lock),
    ]);
    await settle(both, t.release);
    expect(t.calls()).toBe(1);
    expect(t.server.items.get("milk")!.quantity).toBe(5);
    expect([...t.server.effects.values()].every((v) => v === 1)).toBe(true);
    expect(t.store.get().entries).toEqual([]);
  });

  it("a tap made while a replay is finishing is sent by the replay that waited, not stranded", async () => {
    const t = setup();
    await t.add(1);
    const first = replay(t.store, t.client, "ana", () => 0, lock);
    await new Promise((r) => setTimeout(r, 0)); // first batch on the wire
    await t.add(1);
    const second = replay(t.store, t.client, "ana", () => 0, lock);
    await settle(Promise.all([first, second]), t.release);
    expect(t.server.items.get("milk")!.quantity).toBe(2);
    expect(t.store.get().entries).toEqual([]);
  });
});

describe.each(Object.entries(LOCKS))("with %s, at the worst moment", (_name, lock) => {
  it("a tap after the running replay's last check, before it lets go, is still sent", async () => {
    const t = setup();
    await t.add(1);
    let second: Promise<void> | undefined;
    const inner = t.store.update;
    t.store.update = async (fn) => {
      const before = t.store.get();
      const after = await inner(fn);
      // The holder just found nothing to send: now the person taps and the app starts a replay.
      if (!second && after === before && before.entries.length === 0) {
        await t.add(1);
        second = replay(t.store, t.client, "ana", () => 0, lock);
      }
      return after;
    };
    await settle(
      replay(t.store, t.client, "ana", () => 0, lock),
      t.release
    );
    await settle(second!, t.release);
    expect(t.server.items.get("milk")!.quantity).toBe(2);
    expect(t.store.get().entries).toEqual([]);
  });
});

describe("a replay that gets no usable answer stops and backs off", () => {
  const cases: [string, () => Response, string][] = [
    [
      "a refusal of the whole request (lost access)",
      () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      "refused",
    ],
    [
      "an empty result list",
      () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } }),
      "server",
    ],
    [
      "JSON that is not JSON",
      () => new Response("{trunc", { headers: { "content-type": "application/json" } }),
      "server",
    ],
  ];
  it.each(cases)("%s", async (_name, answer, kind) => {
    const t = setup(answer);
    await t.add(2);
    await settle(
      replay(t.store, t.client, "ana", () => 0, makeLock(undefined)),
      t.release
    );
    expect(t.calls()).toBe(1);
    const s = t.store.get();
    expect(s.failure?.kind).toBe(kind);
    expect(s.sending).toBe(false);
    expect(s.entries.map((e) => e.transmission)).toEqual(["transmitted", "transmitted"]);
    if (kind === "refused") expect(s.failure).toMatchObject({ status: 403, error: "forbidden" });
  });

  it("an exception never leaves the queue marked as sending", async () => {
    const t = setup(
      () =>
        ({
          status: 200,
          type: "basic",
          headers: {
            get: () => {
              throw new Error("boom");
            },
          },
        }) as unknown as Response
    );
    await t.add(1);
    await expect(
      settle(
        replay(t.store, t.client, "ana", () => 0, makeLock(undefined)),
        t.release
      )
    ).rejects.toThrow("boom");
    expect(t.store.get().sending).toBe(false);
  });
});
