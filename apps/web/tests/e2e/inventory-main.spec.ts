/**
 * Inventory surfaces inside the main app (APLANE-63, plan phase 5), against dev seeded with qa-inv:
 * the project entry in both navigation modes, the sidebar entry and the Home widget (links that leave
 * for the shopping app, ticks and capture online, the widget first, counter = widget = list for two
 * viewers), and Project › Inventory. Chromium only, like the app's own spec: WebKit is not a target.
 *
 * Every test puts back what it changed (restoreSeed plus the flags below): shopping.spec.ts and the
 * android project run against the same seed.
 */
import type { Page } from "@playwright/test";
import { apiDelete, apiPatch, apiPost, authFile, closeDrawer, expect, isPhone, test } from "./helpers";
import { INV, contextFor, restoreSeed, server } from "./inventory-helpers";

const projects = INV?.projects;
const MARKER = 'meta[name="plane-shopping-shell"]';

/** The viewer's to-buy count as the server derives it (S20: the counter and the widget must equal it). */
async function listCount(page: Page): Promise<number> {
  const res = await page.request.get("/api/workspaces/qa-inv/inventory/shopping-list/");
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { count: number }).count;
}

/** A main-app page as a person sees it: on phones the nav drawer starts open over the content. */
async function visit(page: Page, url: string) {
  await page.goto(url);
  await closeDrawer(page, test.info().project.name);
}

/** The main sidebar only: a second, hidden copy lives in the "peek" sidebar. */
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Main sidebar" });

async function home(page: Page) {
  await visit(page, "/qa-inv/");
  await expect(page.getByTestId("shopping-widget")).toBeVisible();
  await expect(page.getByTestId("shopping-widget-count")).toBeVisible();
}

const setNavigationMode = (page: Page, mode: "ACCORDION" | "TABBED") =>
  apiPatch(page, "/api/workspaces/qa-inv/user-properties/", { navigation_control_preference: mode });

const setInventory = (page: Page, projectId: string, on: boolean) =>
  apiPatch(page, `/api/workspaces/qa-inv/projects/${projectId}/`, { inventory_view: on });

/** Opens "New list" in a fresh one-member project (deleted afterwards) and says whether it warns. */
async function firstListWarns(page: Page, network: 0 | 2): Promise<boolean> {
  const created = await apiPost(page, "/api/workspaces/qa-inv/projects/", {
    name: `QA e2e ${network} ${Date.now()}`,
    identifier: `QE${network}${Date.now() % 10000}`,
    network,
  });
  const pid = ((await created.json()) as { id: string }).id;
  try {
    await setInventory(page, pid, true);
    await visit(page, `/qa-inv/projects/${pid}/inventory/`);
    await page.getByTestId("project-inventory").getByRole("button", { name: "New list" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Name")).toBeVisible();
    const warns = (await dialog.getByText("This project is public").count()) > 0;
    await dialog.getByRole("button", { name: "Cancel" }).click();
    return warns;
  } finally {
    await apiDelete(page, `/api/workspaces/qa-inv/projects/${pid}/`);
  }
}

/** One crawled route, as shell.spec's crawl does it; the guard fixture fails the test on an error screen. */
async function crawl(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle");
  await expect(page).not.toHaveURL(/\/sign-in|\/login|\/accounts/);
}

// Gate additions (plan, phase 6): the inventory routes crawled as a member and as a guest. A guest has no
// access to inventory: each screen must say so, never break (the guard fixture fails on an error boundary).
test.describe("inventory crawl, member and guest @inventory-main", () => {
  test.skip(!INV, "the image under test has no inventory (seed-qa.sh decides from the image tag)");
  test.skip(({ browserName }) => browserName === "webkit", "Chromium only, like the shopping app's spec");

  test("a member: Home, the project page, the feature settings, the shopping app", async ({ browser }, info) => {
    const ana = await contextFor(browser, info, "qa-inv-ana");
    try {
      await crawl(ana.page, "/qa-inv/");
      await crawl(ana.page, `/qa-inv/projects/${projects!.HOME.id}/inventory/`);
      await crawl(ana.page, `/qa-inv/settings/projects/${projects!.HOME.id}/features/inventory/`);
      await ana.page.goto("/shopping/");
      await expect(ana.page.locator(MARKER)).toHaveCount(1);
      await expect(ana.page.locator("[data-phase]")).toHaveCount(0);
    } finally {
      await ana.context.close();
    }
  });

  test("a guest: the project page and the shopping app say there is no access", async ({ browser }, info) => {
    const gus = await contextFor(browser, info, "qa-inv-gus");
    try {
      await gus.page.goto(`/qa-inv/projects/${projects!.HOME.id}/inventory/`);
      await expect(gus.page.getByText("You have no access to this project's inventory.")).toBeVisible();
      await gus.page.goto("/shopping/");
      await expect(gus.page.locator('[data-phase="no_access"]')).toBeVisible();
    } finally {
      await gus.context.close();
    }
  });
});

test.describe("inventory in the main app @inventory-main", () => {
  test.skip(!INV, "the image under test has no inventory (seed-qa.sh decides from the image tag)");
  test.use({ storageState: authFile("qa-inv-ana") });
  test.skip(({ browserName }) => browserName === "webkit", "Chromium only, like the shopping app's spec");
  test.afterEach(async ({ page }) => {
    await page.goto("about:blank");
    // A test stopped by its timeout skips its own finally's request: projects it made are removed here.
    const all = await (await page.request.get("/api/workspaces/qa-inv/projects/")).json();
    for (const p of all as { id: string; name: string }[])
      // oxlint-disable-next-line no-await-in-loop -- rarely more than one
      if (p.name.startsWith("QA e2e ")) await apiDelete(page, `/api/workspaces/qa-inv/projects/${p.id}/`);
    await setNavigationMode(page, "ACCORDION");
    await setInventory(page, projects!.OPEN.id, true);
    await restoreSeed(page);
  });

  test("counter, widget and list agree for two viewers; a needed pinned row counts (S20, APLANE-77)", async ({
    page,
    browser,
  }, info) => {
    const bo = await contextFor(browser, info, "qa-inv-bo");
    try {
      const check = async (who: string, p: Page, expected: number) => {
        expect(await listCount(p), `${who}: list`).toBe(expected);
        await home(p);
        await expect(p.getByTestId("shopping-widget-count"), `${who}: widget`).toHaveText(`${expected} to buy`);
        if (!isPhone(info.project.name))
          await expect(sidebar(p).getByTestId("sidebar-shopping-count"), `${who}: counter`).toHaveText(
            String(expected)
          );
      };
      // Ana sees Home, Mine and Open; Bo sees Home only.
      // Bread (pinned, needed) counts since APLANE-77; Eggs (pinned, not needed) is not on the list.
      await check("ana", page, 7);
      await check("bo", bo.page, 5);
    } finally {
      await bo.context.close();
    }
  });

  test("the widget is the first widget on Home", async ({ page }) => {
    await home(page);
    // Home renders each enabled widget in its own wrapper, in order; the widget's must be the first one.
    const position = await page.getByTestId("shopping-widget").evaluate((el) => {
      const wrapper = el.parentElement!;
      return {
        index: [...wrapper.parentElement!.children].indexOf(wrapper),
        count: wrapper.parentElement!.children.length,
      };
    });
    expect(position.count).toBeGreaterThan(1);
    expect(position.index).toBe(0);
  });

  test("the sidebar entry and the widget link leave the main app for the shopping app (S51)", async ({
    page,
  }, info) => {
    test.skip(isPhone(info.project.name), "the sidebar is a drawer on phones; the widget link is covered below");
    await home(page);
    await expect(sidebar(page).getByTestId("sidebar-shopping")).toHaveAttribute("href", "/shopping/?ws=qa-inv");
    await sidebar(page).getByTestId("sidebar-shopping").click();
    await expect(page.locator(MARKER)).toHaveCount(1);
    // The app read the workspace and dropped it from the address (a reload keeps its own choice).
    await expect(page).toHaveURL(/\/shopping\/$/);
    await expect(page.locator("[data-phase]")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await home(page);
    await page.getByTestId("shopping-widget").getByRole("link", { name: "Open shopping app" }).click();
    await expect(page.locator(MARKER)).toHaveCount(1);
  });

  test("a tick and a capture from the widget apply on the server at once (S42)", async ({ page }) => {
    await home(page);
    const widget = page.getByTestId("shopping-widget");
    await widget.getByRole("checkbox", { name: "Milk: bought" }).click();
    await expect(widget.getByText("Milk: bought.")).toBeVisible();
    await server(page, "Milk", "needed").toBe(false);
    await expect(widget.getByRole("checkbox", { name: "Milk: bought" })).toHaveCount(0);

    await widget.getByLabel("Add or search…").fill("salt");
    await widget.getByRole("button", { name: "Salt: Needed" }).click();
    await expect(widget.getByText("Salt: on the shopping list.")).toBeVisible();
    await server(page, "Salt", "needed").toBe(true);
  });

  test("the widget with the network cut: a clear error, nothing kept (S42)", async ({ page }) => {
    await home(page);
    await page.route("**/inventory/ops/", (route) => route.abort());
    const widget = page.getByTestId("shopping-widget");
    await widget.getByRole("checkbox", { name: "Milk: bought" }).click();
    await expect(widget.getByText("No connection: nothing was changed.")).toBeVisible();
    await page.unroute("**/inventory/ops/");
    await page.reload();
    await expect(page.getByTestId("shopping-widget").getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await server(page, "Milk", "needed").toBe(true);
  });

  test("the project entry follows the feature in both navigation modes", async ({ page }, info) => {
    test.skip(isPhone(info.project.name), "the accordion sidebar is a drawer on phones");
    const open = projects!.OPEN.id;
    const link = page.locator(`a[href="/qa-inv/projects/${open}/inventory/"]`);

    await setNavigationMode(page, "ACCORDION");
    await setInventory(page, open, false);
    await page.goto(`/qa-inv/projects/${open}/issues/`);
    await expect(page.locator(`a[href="/qa-inv/projects/${open}/issues/"]`).first()).toBeVisible();
    await expect(link).toHaveCount(0);

    // Turned on from its settings page, as a project admin would.
    await page.goto(`/qa-inv/settings/projects/${open}/features/inventory/`);
    await page.getByRole("switch").click();
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/workspaces/qa-inv/projects/${open}/`);
        return ((await res.json()) as { inventory_view: boolean }).inventory_view;
      })
      .toBe(true);
    await page.goto(`/qa-inv/projects/${open}/issues/`);
    await expect(link.first()).toBeVisible();

    await setNavigationMode(page, "TABBED");
    await page.goto(`/qa-inv/projects/${open}/issues/`);
    await expect(page.getByRole("link", { name: "Inventory", exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Inventory", exact: true }).first().click();
    await expect(page.getByTestId("project-inventory")).toBeVisible();
  });

  test("Project › Inventory: lists, a row edited inline, the item sheet, who can see it", async ({ page }) => {
    await visit(page, `/qa-inv/projects/${projects!.HOME.id}/inventory/`);
    const table = page.getByTestId("project-inventory");
    await expect(table.getByRole("tab", { name: "Groceries" })).toHaveAttribute("aria-selected", "true");
    await expect(table.getByText("Shared with qa-inv-bo.")).toBeVisible();
    await expect(table.locator('[data-testid="inventory-row"][data-item="Milk"]')).toBeVisible();
    // A state change from the table: Salt needed (a statement, compared on its revision).
    await table.getByRole("button", { name: "Salt: Needed" }).click();
    await server(page, "Salt", "needed").toBe(true);
    // A data change: Salt's category, saved when the field is left.
    const category = table.getByLabel("Salt: Category / aisle");
    await category.fill("Spices");
    await category.press("Tab");
    await server(page, "Salt", "category").toBe("Spices");
    await table.getByRole("tab", { name: "Baby" }).click();
    await expect(table.locator('[data-testid="inventory-row"][data-item="Wipes"]')).toBeVisible();
    await table
      .locator('[data-testid="inventory-row"][data-item="Wipes"]')
      .getByRole("button", { name: "Details" })
      .click();
    await expect(page.getByRole("dialog").getByText("History")).toBeVisible();
  });

  test("the item sheet's photo: a camera button on touch screens, upload and remove (APLANE-66)", async ({
    page,
  }, info) => {
    await visit(page, `/qa-inv/projects/${projects!.HOME.id}/inventory/`);
    const table = page.getByTestId("project-inventory");
    await table
      .locator('[data-testid="inventory-row"][data-item="Detergent"]')
      .getByRole("button", { name: "Details" })
      .click();
    const dialog = page.getByRole("dialog");
    // Android's photo picker has no camera: a touch screen gets "Take photo" (a capture input) and "Gallery".
    // Pinned to the project, so a lost touch emulation cannot quietly test the desktop path on the phone.
    const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    expect(touch).toBe(info.project.name === "android");
    const input = dialog.getByLabel(touch ? "Detergent: Take photo" : "Detergent: Add photo");
    await expect(input).toHaveCount(1);
    // In the accessibility tree (a screen reader hears the item; the keyboard reaches it), not display:none.
    await expect(input).not.toHaveAttribute("hidden");
    if (touch) {
      await expect(input).toHaveAttribute("capture", "environment");
      await expect(dialog.getByLabel("Detergent: Gallery")).toHaveCount(1);
    } else await expect(dialog.getByLabel("Detergent: Take photo")).toHaveCount(0);
    await input.evaluate(async (el: HTMLInputElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 2000;
      canvas.height = 1500;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#2a7";
      g.fillRect(0, 0, 2000, 1500);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9));
      const files = new DataTransfer();
      files.items.add(new File([blob], "IMG_20261123_080000.jpg", { type: "image/jpeg" }));
      el.files = files.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const photo = dialog.getByRole("img", { name: "Photo of Detergent" });
    await expect(photo).toBeVisible({ timeout: 20_000 });
    // Shrunk on the device to the 1600 px the server expects.
    await expect
      .poll(() => photo.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), {
        timeout: 15_000,
      })
      .toBe(1600);
    await server(page, "Detergent", "photo").toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    await dialog.getByRole("button", { name: "Detergent: Remove photo" }).click();
    await expect(photo).toHaveCount(0);
    await server(page, "Detergent", "photo").toBeNull();
  });

  test("the first list of a public project with one member warns; a secret one does not (S21)", async ({ page }) => {
    expect(await firstListWarns(page, 2)).toBe(true);
    expect(await firstListWarns(page, 0)).toBe(false);
  });

  test("a guest sees neither the sidebar entry nor the widget", async ({ browser }, info) => {
    const gus = await contextFor(browser, info, "qa-inv-gus");
    try {
      await gus.page.goto("/qa-inv/");
      await expect(gus.page.getByText("QA Inventory").first()).toBeVisible();
      // Absence proves something only once the projects are in: wait for the guest's own project in the sidebar
      // (phase 9 review: the check could run before the project store loaded).
      await expect(
        gus.page.getByRole("complementary", { name: "Main sidebar" }).getByText("Home", { exact: true }).first()
      ).toBeVisible();
      await expect(gus.page.getByTestId("shopping-widget")).toHaveCount(0);
      await expect(gus.page.getByTestId("sidebar-shopping")).toHaveCount(0);
      const res = await gus.page.request.get("/api/workspaces/qa-inv/home-preferences/");
      expect(((await res.json()) as { key: string }[]).map((r) => r.key)).not.toContain("shopping_list");
    } finally {
      await gus.context.close();
    }
  });
});
