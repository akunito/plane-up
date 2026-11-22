/**
 * The shopping app offline (APLANE-64, plan phase 6), Chromium only, against dev seeded with qa-inv:
 * the worker registered with the app's scope, taps made with the network cut and sent when it returns,
 * a reload with no network served from the worker's cache and the saved snapshot, and what needs a
 * connection refused with a clear message.
 *
 * Covered elsewhere, not here: the two-hour hold, stale results, a 5xx / sign-in page / lost answer, a
 * session expired during replay and two tabs replaying (packages/inventory unit and model tests); another
 * person signing in while offline-opened (packages/shopping-app offline tests); the precache refusing the
 * main app's page for a missing file (worker tests and the gate's worker check). On the phone, by hand:
 * airplane mode, cold start from the icon, tap offline + kill the app + restore the network + reopen.
 */
import type { Page } from "@playwright/test";
import { authFile, expect, test } from "./helpers";
import { INV, restoreSeed, server } from "./inventory-helpers";

const MARKER = 'meta[name="plane-shopping-shell"]';

/** Opens the app and waits until the worker controls the page (its first visit installs it). */
async function openControlled(page: Page) {
  await page.goto("/shopping/");
  await expect(page.locator(MARKER)).toHaveCount(1);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator("[data-phase]")).toHaveCount(0);
}

test.describe("shopping app offline @shopping-offline", () => {
  test.skip(!INV, "the image under test has no shopping app (seed-qa.sh decides from the image tag)");
  test.use({ storageState: authFile("qa-inv-ana") });
  test.skip(
    ({ browserName }) => browserName === "webkit",
    "Chromium only: the app's devices are Android phones and desktop"
  );
  test.afterEach(async ({ page, context }) => {
    await context.setOffline(false);
    await restoreSeed(page);
  });

  test("the worker is registered with the app's scope, and the main app has none", async ({ page }) => {
    await openControlled(page);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope ?? "");
    expect(new URL(scope).pathname).toBe("/shopping/");
    await page.goto("/qa-inv/");
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration("/qa-inv/")))).toBe(false);
  });

  test("S55: two tabs open when the network returns deliver each tap once", async ({ page, context }) => {
    await openControlled(page);
    const other = await context.newPage();
    await openControlled(other);
    await context.setOffline(true);
    // Wipes: 1 at home, minimum 3: a tick buys 2. Delivered twice it would read 5.
    await page.getByRole("checkbox", { name: "Wipes: bought" }).click();
    await expect(page.getByText("Waiting to be sent: 1")).toBeVisible();
    // Both tabs see the stored queue and both try to send it the moment the network is back.
    await other.evaluate(() => window.dispatchEvent(new Event("focus")));
    await context.setOffline(false);
    await Promise.all([
      page.evaluate(() => window.dispatchEvent(new Event("online"))),
      other.evaluate(() => window.dispatchEvent(new Event("online"))),
    ]);
    await expect(page.getByText(/Waiting to be sent/)).toHaveCount(0, { timeout: 20_000 });
    await server(page, "Wipes", "quantity").toBe(3);
    await other.close();
  });

  test("taps with the network cut are kept, counted, and sent when it returns", async ({ page, context }) => {
    await openControlled(page);
    await context.setOffline(true);
    await page.getByRole("checkbox", { name: "Milk: bought" }).click();
    await page.getByRole("checkbox", { name: "Detergent: bought" }).click();
    await expect(page.getByText("Waiting to be sent: 2")).toBeVisible();
    await expect(page.getByText("No connection. Changes are kept and sent when it returns.")).toBeVisible();
    await context.setOffline(false);
    // The page sends on "online" (the worker's background sync does the same when the page is closed).
    await expect(page.getByText(/Waiting to be sent/)).toHaveCount(0, { timeout: 20_000 });
    await server(page, "Milk", "needed").toBe(false);
    await server(page, "Detergent", "level").toBe("ok");
  });

  test("a reload with no network opens from the worker's cache and the last list, and says so", async ({
    page,
    context,
  }) => {
    await openControlled(page);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    // The snapshot is written a moment after the list loads: polled, not a fixed wait (phase 9 review).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open("plane-shopping");
              open.addEventListener("error", () => resolve(false));
              open.addEventListener("success", () => {
                const db = open.result;
                if (!db.objectStoreNames.contains("kv")) return resolve(false);
                const keys = db.transaction("kv", "readonly").objectStore("kv").getAllKeys();
                keys.addEventListener("success", () =>
                  resolve(keys.result.some((k) => String(k).startsWith("plane-shopping-snapshot:")))
                );
                keys.addEventListener("error", () => resolve(false));
              });
            })
        )
      )
      .toBe(true);
    // The shell must be in the worker's cache: if setOffline did not reach the worker's own fetch, its
    // network fallback could pass this test while a phone in airplane mode gets nothing (phase 6 audit).
    expect(
      await page.evaluate(async () => {
        const hit = await caches.match("/shopping/");
        return hit ? (await hit.text()).includes('name="plane-shopping-shell"') : false;
      })
    ).toBe(true);
    await context.setOffline(true);
    const res = await page.reload();
    expect(res?.fromServiceWorker()).toBe(true);
    await expect(page.locator(MARKER)).toHaveCount(1);
    await expect(page.locator("[data-phase]")).toHaveCount(0);
    await expect(page.getByText(/No connection: this is the list from/)).toBeVisible();
    await page.getByRole("checkbox", { name: "Milk: bought" }).click();
    await expect(page.getByText("Waiting to be sent: 1")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText(/Waiting to be sent/)).toHaveCount(0, { timeout: 20_000 });
    await server(page, "Milk", "needed").toBe(false);
  });

  test("offline, creating an item is refused with a clear message and nothing is queued", async ({ page, context }) => {
    await openControlled(page);
    await page.goto("/shopping/#/capture");
    await context.setOffline(true);
    await page.getByLabel("Search or add an item").fill("QA e2e offline thing");
    await page.getByRole("button", { name: /^Create “QA e2e offline thing”/ }).click();
    await expect(page.getByText("This needs a connection.")).toBeVisible();
    await expect(page.getByText(/Waiting to be sent/)).toHaveCount(0);
  });
});
