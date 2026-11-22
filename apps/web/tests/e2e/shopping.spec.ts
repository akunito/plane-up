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
import type { Locator, Page } from "@playwright/test";
import { apiDelete, authFile, expect, expectNoHorizontalOverflow, test } from "./helpers";
import { INV, contextFor, item, restoreSeed, server } from "./inventory-helpers";

const items = INV?.inventory.items ?? {};

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

async function recount(page: Page, name: string, from: number, to: number) {
  await open(page, "#/inventory");
  await page.getByRole("button", { name: `${name}: type the count, now ${from}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("At home").fill(String(to));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: `${name}: type the count, now ${to}` })).toBeVisible();
  await settled(page);
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
    await page.getByRole("button", { name: `Create “${name}” and add it to the shopping list` }).click();
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
    // Earlier workflows toggle Salt too, so the history holds several such steps.
    await expect(page.getByText(/took it off the list/).first()).toBeVisible();
    const category = page.getByLabel("Category / aisle");
    await expect(category).toHaveValue("Pantry");
    await category.fill("Spices");
    await category.press("Enter");
    await server(page, "Salt", "category").toBe("Spices");
    await category.fill("Pantry");
    await category.press("Enter");
    await server(page, "Salt", "category").toBe("Pantry");
  });

  test("item photo: a phone-sized photo is shrunk, stored, shown, and removed (APLANE-66)", async ({
    page,
    browser,
  }, info) => {
    await open(page, `#/item/${items.Salt}`);
    // A touch screen gets the camera as its own button (Android's photo picker has none): the phone project
    // uploads through it, the desktop through the single file button.
    const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    // Pinned to the project: if touch emulation stopped matching, the phone would quietly test the desktop path.
    expect(touch).toBe(info.project.name === "android");
    const input = page.getByLabel(touch ? "Take photo" : "Add photo");
    await expect(input).toHaveCount(1);
    if (touch) {
      await expect(input).toHaveAttribute("capture", "environment");
      await expect(page.getByLabel("Gallery")).toHaveCount(1);
    }
    // A real JPEG larger than the 1600 px the app shrinks to, made by the browser itself, with an EXIF block
    // spliced in the way a phone writes one: orientation 6 (stored landscape, shown portrait). The stored
    // photo must come out upright (1200 × 1600) and without the EXIF block (phase 8 audit: both were assumed).
    await input.evaluate(async (el: HTMLInputElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400;
      canvas.height = 1800;
      const g = canvas.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 2400, 1800);
      grad.addColorStop(0, "#c33");
      grad.addColorStop(1, "#33c");
      g.fillStyle = grad;
      g.fillRect(0, 0, 2400, 1800);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.95));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      // APP1 "Exif\0\0" + little-endian TIFF, IFD0 with one entry: 0x0112 Orientation, SHORT, 1, value 6.
      const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
      const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
      const app1 = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
      const withExif = new Uint8Array(jpeg.length + app1.length);
      withExif.set(jpeg.subarray(0, 2));
      withExif.set(app1, 2);
      withExif.set(jpeg.subarray(2), 2 + app1.length);
      const files = new DataTransfer();
      files.items.add(new File([withExif], "IMG_20261121_090000.jpg", { type: "image/jpeg" }));
      el.files = files.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const photo = page.getByRole("img", { name: "Photo of Salt" });
    await expect(photo).toBeVisible({ timeout: 20_000 });
    // Loaded through the redirect to storage, shrunk and upright.
    await expect
      .poll(
        () =>
          photo.evaluate((img: HTMLImageElement) => (img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : "")),
        { timeout: 15_000 }
      )
      .toBe("1200x1600");
    await expect(page.getByText("Saved.")).toBeVisible();
    await server(page, "Salt", "photo").toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    // A workspace guest cannot read it, not even with its address.
    const src = await photo.getAttribute("src");
    expect(src).toMatch(/\/photo\/[0-9a-f-]{36}\/$/);
    // The stored bytes, through the same redirect: no EXIF block left.
    const stored = await (await page.request.get(src!)).body();
    expect(stored.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(stored.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    const gus = await contextFor(browser, info, "qa-inv-gus");
    try {
      expect((await gus.page.request.get(src!, { maxRedirects: 0 })).status()).toBe(403);
    } finally {
      await gus.context.close();
    }
    await page.getByRole("button", { name: "Remove photo" }).click();
    await expect(photo).toHaveCount(0);
    await server(page, "Salt", "photo").toBeNull();
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

/** `target`: capture only that element (a dialog), so the masks of what lies behind it are not drawn over it. */
const shot = async (page: Page, name: string, target?: Locator) => {
  await page.waitForLoadState("networkidle");
  const options = {
    animations: "disabled" as const,
    caret: "hide" as const,
    scale: "css" as const,
    // Relative times change from run to run; every one of them is a <time> element in this app.
    // Only those inside the target: a mask behind a dialog would be drawn over the dialog.
    mask: [(target ?? page).locator("time")],
  };
  const file = test.info().snapshotPath(`${name}.png`, { kind: "screenshot" });
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Two identical captures in a row, as toHaveScreenshot waits for, so a frame mid-render is never
    // taken as the reference (phase 4 audit).
    let previous = await (target ?? page).screenshot(options);
    let stable = false;
    for (let i = 0; i < 10 && !stable; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each capture is compared with the one before it
      const next = await (target ?? page).screenshot(options);
      stable = next.equals(previous);
      previous = next;
    }
    expect(stable, `${name}: the screen never held still for two captures; no baseline written`).toBe(true);
    fs.writeFileSync(file, previous);
    console.log(`BASELINE CREATED ${path.basename(file)} — look at it before trusting it`);
    test.info().annotations.push({ type: "baseline-created", description: file });
    return;
  }
  await expect(target ?? page).toHaveScreenshot(`${name}.png`, { ...options, maxDiffPixelRatio: 0.01 });
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
    // Renamed when pinned rows gained "bought … (by …)" (APLANE-67, S17): the new name creates its baseline.
    await shot(page, "vs-01-list-bought");
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
    // Renamed with each change to this screen (APLANE-66 photo field, then the camera button on touch screens):
    // the new name creates its baseline.
    await shot(page, "vs-05-item-camera");
  });

  test("VS-06 order dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Mark Protein as ordered" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-06-order", page.getByRole("dialog"));
  });

  test("VS-07 arrival dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Magnesium: the order arrived" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-07-arrival", page.getByRole("dialog"));
  });

  test("VS-08 waiting and unapplied", async ({ page }) => {
    await open(page, "#/pending");
    await expect(page.getByText("Nothing waiting.")).toBeVisible();
    await shot(page, "vs-08-pending");
  });
});
