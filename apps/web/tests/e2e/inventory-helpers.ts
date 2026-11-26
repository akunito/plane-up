/**
 * The qa-inv seed as the inventory specs see it, and how they put it back (APLANE-62/63): shared by
 * shopping.spec.ts (the app) and inventory-main.spec.ts (the main app's surfaces), which run against the
 * same seed one after the other.
 */
import { randomUUID } from "node:crypto";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { apiDelete, apiPatch, apiPost, authFile, expect, manifest } from "./helpers";

export const INV = manifest.workspaces["qa-inv"];

export type Item = {
  id: string;
  name: string;
  rev: number;
  mode: string;
  project: { id: string };
  needed: boolean;
  level: string | null;
  quantity: number | null;
  category: string;
  photo?: string | null;
};

/** An item as the server holds it now (suggestions return the full payload). */
export async function item(page: Page, name: string): Promise<Item> {
  const res = await page.request.get(`/api/workspaces/qa-inv/inventory/suggestions/?q=${encodeURIComponent(name)}`);
  expect(res.ok()).toBeTruthy();
  const found = ((await res.json()) as { items: Item[] }).items.find((i) => i.name === name);
  expect(found, `item ${name}`).toBeTruthy();
  return found!;
}

/** A server value, polled: a single read can reach the server before the tap was applied. */
export const server = (page: Page, name: string, field: keyof Item) =>
  expect.poll(async () => (await item(page, name))[field], { timeout: 15_000 });

/**
 * Put back what the workflows touch, through the API, whatever the test did or where it stopped: the
 * android project runs after desktop against the same seed (phase 4 audit: a test failing halfway
 * failed every later one).
 */
export async function restoreSeed(page: Page) {
  // Leave the app first: a tap still waiting in it could otherwise land between the reads below and
  // their operations and make them stale (phase 4 re-review).
  await page.goto("about:blank");
  const ops: Record<string, unknown>[] = [];
  const want: [string, { needed?: boolean; quantity?: number; level?: string; pinned?: boolean }][] = [
    ["Milk", { needed: true }],
    ["Salt", { needed: false, pinned: false }],
    // Pinned (APLANE-77): Bread needed, Eggs not.
    ["Bread", { needed: true, pinned: true }],
    ["Eggs", { needed: false, pinned: true }],
    ["Wipes", { quantity: 1 }],
    ["Protein", { quantity: 0 }],
    // Ticked by the offline spec (a buy sets a level item to "ok"); seeded "out".
    ["Detergent", { level: "out" }],
    ["Nappies", { level: "low" }],
  ];
  for (const [name, state] of want) {
    // Sequential: each read gives the revision its own operation names.
    // oxlint-disable-next-line no-await-in-loop
    const now = await item(page, name);
    // The pin goes in a batch of its own and the item is read again: the set_needed below needs the revision the
    // pin produced (both are compare-and-set).
    if (state.pinned !== undefined && (now.mode === "pinned") !== state.pinned) {
      // oxlint-disable-next-line no-await-in-loop -- rare: only after a test stopped half-way
      const pinRes = await apiPost(page, "/api/workspaces/qa-inv/inventory/ops/", {
        ops: [
          {
            v: 1,
            client_op_id: randomUUID(),
            queue_id: null,
            target: now.id,
            op: "pin",
            args: { pinned: state.pinned },
            base_rev: now.rev,
          },
        ],
      });
      // oxlint-disable-next-line no-await-in-loop
      const pinned = ((await pinRes.json()) as { results: { result: string }[] }).results[0];
      expect(pinned?.result, `restoreSeed pin ${name}: ${JSON.stringify(pinned)}`).toBe("applied");
      // oxlint-disable-next-line no-await-in-loop
      Object.assign(now, await item(page, name));
    }
    if (state.needed !== undefined && now.needed !== state.needed)
      ops.push({ target: now.id, op: "set_needed", args: { needed: state.needed }, base_rev: now.rev });
    if (state.quantity !== undefined && now.quantity !== state.quantity)
      ops.push({ target: now.id, op: "recount", args: { quantity: state.quantity }, base_rev: now.rev });
    if (state.level !== undefined && now.level !== state.level)
      ops.push({ target: now.id, op: "set_level", args: { level: state.level }, base_rev: now.rev });
  }
  const list = await (await page.request.get("/api/workspaces/qa-inv/inventory/shopping-list/")).json();
  const seeded = new Set([INV!.inventory.orders.open, INV!.inventory.orders.overdue]);
  for (const o of list.on_the_way as { id: string; item: string }[])
    if (!seeded.has(o.id)) ops.push({ target: o.item, op: "cancel", args: { order_id: o.id } });
  if (ops.length) {
    const res = await apiPost(page, "/api/workspaces/qa-inv/inventory/ops/", {
      ops: ops.map((o) => Object.assign(o, { v: 1, client_op_id: randomUUID(), queue_id: null })),
    });
    // A 200 is not a restore: every operation must have applied (a cancel of an order closed meanwhile
    // is already done, which is fine).
    const results = ((await res.json()) as { results: { result: string; reason?: string }[] }).results;
    for (const r of results)
      expect(r.result === "applied" || r.reason === "already_done", `restoreSeed: ${JSON.stringify(r)}`).toBeTruthy();
  }
  // An item a failed create test left behind is needed, so it would change every later count.
  const leftovers = await (await page.request.get("/api/workspaces/qa-inv/inventory/suggestions/?q=QA%20e2e")).json();
  for (const left of leftovers.items as Item[])
    if (left.name.startsWith("QA e2e "))
      // oxlint-disable-next-line no-await-in-loop -- rarely more than one
      await apiDelete(page, `/api/workspaces/qa-inv/projects/${left.project.id}/inventory/items/${left.id}/`);
  const salt = await item(page, "Salt");
  // The photo tests add one to Salt (shopping app) and Detergent (main app), seeded without. Always, not only
  // when a photo shows: a test stopped by its timeout skips its own cleanup, and the DELETE also clears uploads
  // a failed run left pending, which would otherwise count against the cap.
  await apiDelete(page, `/api/workspaces/qa-inv/projects/${salt.project.id}/inventory/items/${salt.id}/photo/`);
  const detergent = await item(page, "Detergent");
  await apiDelete(
    page,
    `/api/workspaces/qa-inv/projects/${detergent.project.id}/inventory/items/${detergent.id}/photo/`
  );
  if (salt.category !== "Pantry")
    await apiPatch(page, `/api/workspaces/qa-inv/projects/${salt.project.id}/inventory/items/${salt.id}/`, {
      category: "Pantry",
    });
}

export async function contextFor(browser: Browser, info: TestInfo, user: "qa-inv-ana" | "qa-inv-bo" | "qa-inv-gus") {
  const context = await browser.newContext({ ...info.project.use, storageState: authFile(user) });
  return { context, page: await context.newPage() };
}
