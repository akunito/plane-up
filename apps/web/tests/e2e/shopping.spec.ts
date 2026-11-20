/**
 * The standalone shopping app at /shopping/ (APLANE-62, plan phase 4), against dev seeded with the
 * qa-inv workspace. Online workflows on the desktop and android projects; WebKit (iphone) is not a
 * target of this app (brief: two Android phones on Chromium browsers, plus desktop).
 *
 * Every workflow puts the seeded data back as it found it: the android project runs after the desktop
 * one against the same seed, and so do the visual baselines.
 *
 * Visual baselines (@visual-shopping) live on the runner like every other baseline. A missing one is
 * CREATED and the test passes, logging "BASELINE CREATED": Playwright's default would fail the run that
 * creates it, and a red E2E restores dev, so the first deploy of a new screen could never make its own
 * baseline. Only these screens do this; the existing visual spec keeps Playwright's default. Look at a
 * created baseline before trusting it.
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiDelete, apiPatch, apiPost, authFile, expect, expectNoHorizontalOverflow, manifest, test } from "./helpers";

const INV = manifest.workspaces["qa-inv"];
const items = INV?.inventory.items ?? {};

type Item = {
  id: string;
  name: string;
  rev: number;
  project: { id: string };
  needed: boolean;
  level: string | null;
  quantity: number | null;
  category: string;
};

/** Open the app and wait until it is ready (the loading, error and signed-out screens carry data-phase). */
async function open(page: Page, hash = "#/") {
  await page.goto(`/shopping/${hash}`);
  await expect(page.locator('meta[name="plane-shopping-shell"]')).toHaveCount(1);
  await expect(page.locator("[data-phase]")).toHaveCount(0);
}

/** Every tap has been answered: nothing is waiting in the queue. */
async function settled(page: Page) {
  await expect(page.getByText(/Waiting to be sent/)).toHaveCount(0);
}

/** An item as the server holds it now (suggestions return the full payload). */
async function item(page: Page, name: string): Promise<Item> {
  const res = await page.request.get(`/api/workspaces/qa-inv/inventory/suggestions/?q=${encodeURIComponent(name)}`);
  expect(res.ok()).toBeTruthy();
  const found = ((await res.json()) as { items: Item[] }).items.find((i) => i.name === name);
  expect(found, `item ${name}`).toBeTruthy();
  return found!;
}

/** A server value, polled: a single read can reach the server before the tap was applied. */
const server = (page: Page, name: string, field: keyof Item) =>
  expect.poll(async () => (await item(page, name))[field], { timeout: 15_000 });

/**
 * Put back what the workflows touch, through the API, whatever the test did or where it stopped: the
 * android project runs after desktop against the same seed (phase 4 audit: a test failing halfway
 * failed every later one).
 */
async function restoreSeed(page: Page) {
  const ops: Record<string, unknown>[] = [];
  const want: [string, { needed?: boolean; quantity?: number }][] = [
    ["Milk", { needed: true }],
    ["Salt", { needed: false }],
    ["Wipes", { quantity: 1 }],
    ["Protein", { quantity: 0 }],
  ];
  for (const [name, state] of want) {
    // Sequential: each read gives the revision its own operation names.
    // oxlint-disable-next-line no-await-in-loop
    const now = await item(page, name);
    if (state.needed !== undefined && now.needed !== state.needed)
      ops.push({ target: now.id, op: "set_needed", args: { needed: state.needed }, base_rev: now.rev });
    if (state.quantity !== undefined && now.quantity !== state.quantity)
      ops.push({ target: now.id, op: "recount", args: { quantity: state.quantity }, base_rev: now.rev });
  }
  const list = await (await page.request.get("/api/workspaces/qa-inv/inventory/shopping-list/")).json();
  const seeded = new Set([INV!.inventory.orders.open, INV!.inventory.orders.overdue]);
  for (const o of list.on_the_way as { id: string; item: string }[])
    if (!seeded.has(o.id)) ops.push({ target: o.item, op: "cancel", args: { order_id: o.id } });
  if (ops.length)
    await apiPost(page, "/api/workspaces/qa-inv/inventory/ops/", {
      ops: ops.map((o) => Object.assign(o, { v: 1, client_op_id: randomUUID(), queue_id: null })),
    });
  const salt = await item(page, "Salt");
  if (salt.category !== "Pantry")
    await apiPatch(page, `/api/workspaces/qa-inv/projects/${salt.project.id}/inventory/items/${salt.id}/`, {
      category: "Pantry",
    });
}

async function recount(page: Page, name: string, from: number, to: number) {
  await open(page, "#/inventory");
  await page.getByRole("button", { name: `${name}: type the count, now ${from}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("At home").fill(String(to));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: `${name}: type the count, now ${to}` })).toBeVisible();
  await settled(page);
}

async function contextFor(browser: Browser, info: TestInfo, user: "qa-inv-ana" | "qa-inv-bo" | "qa-inv-gus") {
  const context = await browser.newContext({ ...info.project.use, storageState: authFile(user) });
  return { context, page: await context.newPage() };
}

test.describe("shopping app @shopping", () => {
  test.skip(!INV, "the image under test has no shopping app (seed-qa.sh decides from the image tag)");
  test.use({ storageState: authFile("qa-inv-ana") });
  test.skip(
    ({ browserName }) => browserName === "webkit",
    "Chromium only: the app's devices are Android phones and desktop"
  );
  test.afterEach(async ({ page }) => restoreSeed(page));

  test("the to-buy list: rows, counter without pinned rows, On the way with the overdue order", async ({ page }) => {
    await open(page);
    await expect(page.getByText("6 missing · 2 pinned")).toBeVisible();
    await Promise.all(
      ["Milk", "Detergent", "Wipes", "Nappies", "Mulch", "Bread", "Eggs"].map((name) =>
        expect(page.getByRole("checkbox", { name: `${name}: bought` })).toBeVisible()
      )
    );
    await expect(page.getByRole("checkbox", { name: "Salt: bought" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark Protein as ordered" })).toBeVisible();
    const onTheWay = page.getByRole("region", { name: "On the way · 2" });
    await expect(onTheWay.getByText("Overdue")).toHaveCount(1);
    await expect(onTheWay.getByText("Magnesium")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a tick buys at once, sits under Done, and Undo reverts it on the server", async ({ page }) => {
    await open(page);
    await page.getByRole("checkbox", { name: "Milk: bought" }).click();
    await expect(page.getByRole("region", { name: "Done · 1" })).toBeVisible();
    await settled(page);
    await server(page, "Milk", "needed").toBe(false);
    await page.getByRole("button", { name: "Undo" }).click();
    // The undo is queued once the row is back on the list; only then is "nothing waiting" meaningful.
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await settled(page);
    await server(page, "Milk", "needed").toBe(true);
  });

  test("shopping mode: no online items, a stepper on units rows, untick from Done, finish", async ({ page }) => {
    await open(page, "#/shop");
    await expect(page.getByText(/Ordered online, not shown here: Protein/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Protein: bought" })).toHaveCount(0);
    // Wipes: 1 at home, restock to 4 → buys 3; one more → 4.
    await page.getByRole("button", { name: "Wipes: one more" }).click();
    await page.getByRole("checkbox", { name: "Wipes: bought" }).click();
    await expect(page.getByRole("checkbox", { name: "Wipes: not bought after all" })).toBeVisible();
    await settled(page);
    await server(page, "Wipes", "quantity").toBe(5);
    await page.getByRole("checkbox", { name: "Wipes: not bought after all" }).click();
    await expect(page.getByRole("checkbox", { name: "Wipes: bought" })).toBeVisible();
    await settled(page);
    await server(page, "Wipes", "quantity").toBe(1);
    await page.getByRole("link", { name: "Finish shopping" }).click();
    await expect(page).toHaveURL(/\/shopping\/#\/$/);
  });

  test("quick capture: one tap by mode, and create into a list", async ({ page }) => {
    await open(page, "#/capture");
    await page.getByRole("searchbox", { name: "Search or add an item" }).fill("sal");
    const needed = page.getByRole("button", { name: "Salt: needed" });
    await expect(needed).toHaveAttribute("aria-pressed", "false");
    await needed.click();
    await expect(needed).toHaveAttribute("aria-pressed", "true");
    await settled(page);
    await server(page, "Salt", "needed").toBe(true);
    await needed.click();
    await expect(needed).toHaveAttribute("aria-pressed", "false");
    await settled(page);
    await server(page, "Salt", "needed").toBe(false);

    const name = `QA e2e ${Date.now()}`;
    await page.getByRole("searchbox").fill(name);
    await page.getByRole("group", { name: "in list" }).getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: `Create “${name}” and add it to the shopping` }).click();
    await expect(page.getByText(`${name}: added to the shopping list.`)).toBeVisible();
    const created = await item(page, name);
    expect(created.needed).toBe(true);
    await apiDelete(page, `/api/workspaces/qa-inv/projects/${INV!.projects.HOME.id}/inventory/items/${created.id}/`);
  });

  test("inventory: who can see each list, and a typed recount", async ({ page }) => {
    await open(page, "#/inventory");
    await expect(page.getByRole("region", { name: "Supplements" }).getByText(/project Mine · only you/)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Groceries" }).getByText(/project Home · with qa-inv-bo/)
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Garden" }).getByText(/public project/)).toBeVisible();
    await recount(page, "Wipes", 1, 5);
    await server(page, "Wipes", "quantity").toBe(5);
    await recount(page, "Wipes", 5, 1);
  });

  test("orders: mark ordered, cancel, order again, a partial arrival", async ({ page }) => {
    await open(page);
    const order = async () => {
      await page.getByRole("button", { name: "Mark Protein as ordered" }).click();
      const dialog = page.getByRole("dialog", { name: "Mark Protein as ordered" });
      await expect(dialog.getByLabel("Quantity")).toHaveValue("3");
      await dialog.getByRole("button", { name: "Mark ordered" }).click();
      await expect(page.getByRole("region", { name: "On the way · 3" })).toBeVisible();
      await settled(page);
    };
    await order();
    // An order action has no undo (brief): the toast offers none.
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await page.getByRole("button", { name: "Protein: the order arrived" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Protein: cancel the order" }).click();
    await expect(page.getByRole("region", { name: "On the way · 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark Protein as ordered" })).toBeVisible();
    await settled(page);

    await order();
    await page.getByRole("button", { name: "Protein: the order arrived" }).click();
    const arrival = page.getByRole("dialog");
    await arrival.getByLabel("Quantity received").fill("1");
    await arrival.getByRole("button", { name: "Arrived" }).click();
    await expect(page.getByRole("region", { name: "On the way · 2" })).toBeVisible();
    await settled(page);
    await server(page, "Protein", "quantity").toBe(1);
    await expect(page.getByRole("region", { name: "On the way · 2" })).toBeVisible();
    await recount(page, "Protein", 1, 0);
  });

  test("item sheet: data saves online when the field is left; history shows applied steps", async ({ page }) => {
    await open(page, `#/item/${items.Salt}`);
    await expect(page.getByRole("heading", { level: 1, name: "Salt" })).toBeVisible();
    await expect(page.getByText(/took it off the list/)).toBeVisible();
    const category = page.getByLabel("Category / aisle");
    await expect(category).toHaveValue("Pantry");
    await category.fill("Spices");
    await category.press("Enter");
    await server(page, "Salt", "category").toBe("Spices");
    await category.fill("Pantry");
    await category.press("Enter");
    await server(page, "Salt", "category").toBe("Pantry");
  });

  test("two people: one flags it needed, the other sees it on the next refresh; lists stay private", async ({
    browser,
  }, info) => {
    const ana = await contextFor(browser, info, "qa-inv-ana");
    const bo = await contextFor(browser, info, "qa-inv-bo");
    await open(ana.page);
    await expect(ana.page.getByRole("checkbox", { name: "Salt: bought" })).toHaveCount(0);
    await open(bo.page, "#/capture");
    await bo.page.getByRole("searchbox").fill("salt");
    await bo.page.getByRole("button", { name: "Salt: needed" }).click();
    await expect(bo.page.getByRole("button", { name: "Salt: needed" })).toHaveAttribute("aria-pressed", "true");
    await server(bo.page, "Salt", "needed").toBe(true);
    // Polling on focus (brief): the other phone coming back to the app.
    await ana.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(ana.page.getByRole("checkbox", { name: "Salt: bought" })).toBeVisible();
    // Bo is in Home only: he never sees ana's secret or public single-member projects.
    await open(bo.page, "#/inventory");
    const chips = bo.page.getByRole("navigation", { name: "List" });
    await expect(chips.getByRole("link", { name: "Groceries" })).toBeVisible();
    await expect(chips.getByRole("link", { name: "Supplements" })).toHaveCount(0);
    await expect(chips.getByRole("link", { name: "Garden" })).toHaveCount(0);
    await open(bo.page, "#/capture");
    await bo.page.getByRole("searchbox").fill("salt");
    await bo.page.getByRole("button", { name: "Salt: needed" }).click();
    await expect(bo.page.getByRole("button", { name: "Salt: needed" })).toHaveAttribute("aria-pressed", "false");
    await server(bo.page, "Salt", "needed").toBe(false);
    await ana.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(ana.page.getByRole("checkbox", { name: "Salt: bought" })).toHaveCount(0);
    await ana.context.close();
    await bo.context.close();
  });

  test("a workspace guest has no access", async ({ browser }, info) => {
    const gus = await contextFor(browser, info, "qa-inv-gus");
    await gus.page.goto("/shopping/");
    await expect(gus.page.locator('[data-phase="no_access"]')).toBeVisible();
    await gus.context.close();
  });
});

// ---------------------------------------------------------------- visual baselines

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState("networkidle");
  const options = {
    animations: "disabled" as const,
    caret: "hide" as const,
    scale: "css" as const,
    // Relative times change from run to run; every one of them is a <time> element in this app.
    mask: [page.locator("time")],
  };
  const file = test.info().snapshotPath(`${name}.png`, { kind: "screenshot" });
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Two identical captures in a row, as toHaveScreenshot waits for, so a frame mid-render is never
    // taken as the reference (phase 4 audit).
    let previous = await page.screenshot(options);
    for (let i = 0; i < 10; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each capture is compared with the one before it
      const next = await page.screenshot(options);
      if (next.equals(previous)) break;
      previous = next;
    }
    fs.writeFileSync(file, previous);
    console.log(`BASELINE CREATED ${path.basename(file)} — look at it before trusting it`);
    test.info().annotations.push({ type: "baseline-created", description: file });
    return;
  }
  await expect(page).toHaveScreenshot(`${name}.png`, { ...options, maxDiffPixelRatio: 0.01 });
};

test.describe("@visual-shopping", () => {
  test.skip(!INV, "the image under test has no shopping app");
  test.use({ storageState: authFile("qa-inv-ana") });
  test.skip(({ browserName }) => browserName === "webkit", "Chromium only");
  test.beforeEach(async ({ page }) => {
    // An hour after the seed: "ordered 1 hr. ago" and "bought 4 days ago" read the same on every run.
    await page.clock.install({ time: new Date(Date.parse(INV!.inventory.generated_at) + 3_600_000) });
  });

  test("VS-01 to-buy list", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await shot(page, "vs-01-list");
  });

  test("VS-02 shopping mode", async ({ page }) => {
    await open(page, "#/shop");
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await shot(page, "vs-02-shop");
  });

  test("VS-03 quick capture", async ({ page }) => {
    await open(page, "#/capture");
    await page.getByRole("searchbox").fill("nap");
    await expect(page.getByRole("button", { name: "Nappies: Running low" })).toBeVisible();
    await shot(page, "vs-03-capture");
  });

  test("VS-04 inventory", async ({ page }) => {
    await open(page, "#/inventory");
    await expect(page.getByRole("link", { name: "Open Mulch" })).toBeVisible();
    await shot(page, "vs-04-inventory");
  });

  test("VS-05 item sheet", async ({ page }) => {
    // Nappy cream: no workflow above touches it, so its history is the same on every project.
    await open(page, `#/item/${items["Nappy cream"]}`);
    await expect(page.getByText(/set it to: In stock/)).toBeVisible();
    await shot(page, "vs-05-item");
  });

  test("VS-06 order dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Mark Protein as ordered" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-06-order");
  });

  test("VS-07 arrival dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Magnesium: the order arrived" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-07-arrival");
  });

  test("VS-08 waiting and unapplied", async ({ page }) => {
    await open(page, "#/pending");
    await expect(page.getByText("Nothing waiting.")).toBeVisible();
    await shot(page, "vs-08-pending");
  });
});
