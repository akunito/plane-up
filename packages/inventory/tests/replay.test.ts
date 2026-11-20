// Two replays started at once deliver each operation once (plan, phase 3).

import { expect, it } from "vitest";

import { createQueue, refreshed, tap } from "../src/queue";
import type { QueueState } from "../src/queue";
import { replay } from "../src/replay";
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

it("two replays started at once deliver each operation once", async () => {
  const server = new ModelServer([milk]);
  let n = 0;
  let state: QueueState = refreshed(createQueue("ana", "q"), [milk]);
  for (let i = 0; i < 5; i++) state = tap(state, "adjust", "milk", { delta: 1 }, { now: 0, newId: () => `op-${++n}` });
  const store = { read: async () => state, write: async (s: QueueState) => void (state = s) };
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    const { ops } = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ results: server.apply(ops, "ana") }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = { base: "", slug: "home", fetchImpl };
  const outcomes = await Promise.all([replay(store, client, "ana", () => 0), replay(store, client, "ana", () => 0)]);
  expect(outcomes.toSorted()).toEqual(["busy", "done"]);
  expect(calls).toBe(1);
  expect(server.items.get("milk")!.quantity).toBe(5);
  expect([...server.effects.values()].every((v) => v === 1)).toBe(true);
  expect(state.entries).toEqual([]);
});
