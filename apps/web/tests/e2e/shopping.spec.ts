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
import { apiDelete, apiPost, authFile, expect, expectNoHorizontalOverflow, test } from "./helpers";
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

  test("the to-buy list: rows, counter with the needed pinned row, On the way with the overdue order", async ({
    page,
  }) => {
    await open(page);
    // The sentence is for screen readers; the bar shows the number beside a cart (APLANE-73). Since APLANE-77 a
    // pinned item is on the list only when needed, and then it counts: Bread yes, Eggs (not needed) no.
    await expect(page.getByText("7 missing", { exact: true })).toHaveClass(/\bvisually-hidden\b/);
    await expect(page.locator(".topbar .count")).toHaveText(["7"]);
    await Promise.all(
      ["Milk", "Detergent", "Wipes", "Nappies", "Mulch", "Bread"].map((name) =>
        expect(page.getByRole("checkbox", { name: `${name}: bought` })).toBeVisible()
      )
    );
    await expect(page.getByRole("checkbox", { name: "Salt: bought" })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Eggs: bought" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Protein: Mark ordered" })).toBeVisible();
    const onTheWay = page.getByRole("region", { name: "On the way · 2" });
    await expect(onTheWay.getByText("Overdue")).toHaveCount(1);
    await expect(onTheWay.getByText("Magnesium")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("APLANE-77: pinned items are gathered at the top, stay in their list, and are marked needed like any other", async ({
    page,
  }) => {
    await open(page, `#/inventory/${INV!.inventory.lists["Groceries"]}`);
    const pinnedSection = page.getByRole("region", { name: "Pinned" });
    const groceries = page.getByRole("region", { name: "Groceries" });
    const names = groceries.locator(".row .name");
    // Bread and Eggs are pinned: at the top, and again in Groceries, which is alphabetical (owner, 2026-11-26).
    await expect(pinnedSection.locator(".row .name")).toHaveText(["Bread", "Eggs"]);
    const before = await names.allTextContents();
    // es2022 lib (L0-02 typecheck): no toSorted.
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy
    expect(before).toEqual([...before].sort((a, b) => a.localeCompare(b)));
    await expect(groceries.getByRole("button", { name: "Eggs: unpin" })).toHaveAttribute("aria-pressed", "true");
    const needed = groceries.getByRole("button", { name: "Eggs: needed" });
    await expect(needed).toHaveAttribute("aria-pressed", "false");
    await needed.click();
    await server(page, "Eggs", "needed").toBe(true);
    await open(page);
    await expect(page.getByRole("checkbox", { name: "Eggs: bought" })).toBeVisible();
    await expect(page.locator(".topbar .count")).toHaveText(["8"]);
    // Unpinning keeps it needed, takes it out of the Pinned section, and leaves its Groceries row where it was.
    await open(page, `#/inventory/${INV!.inventory.lists["Groceries"]}`);
    await groceries.getByRole("button", { name: "Eggs: unpin" }).click();
    await server(page, "Eggs", "needed").toBe(true);
    await expect(pinnedSection.locator(".row .name")).toHaveText(["Bread"]);
    await expect(names).toHaveText(before);
    await expect(groceries.getByRole("button", { name: "Eggs: pin" })).toHaveAttribute("aria-pressed", "false");
    await groceries.getByRole("button", { name: "Eggs: pin" }).click();
    await expect(pinnedSection.locator(".row .name")).toHaveText(["Bread", "Eggs"]);
    await expect(names).toHaveText(before);
    // On the screen too: a short phone, scrolled so Groceries sits under the Pinned section; pinning Salt adds a row
    // above it, and the tapped row stays where it was (the app moves the scroll by the new row's height).
    await page.setViewportSize({ width: 360, height: 520 });
    // Every list, so Salt is not the last row: at the very end of the scroll a box growing back (the status line
    // leaving) clamps scrollTop and shifts the rows, which is the browser's doing (5 px on android, 2026-11-26).
    await open(page, "#/inventory");
    const salt = groceries.locator(".row", { has: page.getByRole("button", { name: "Salt: pin" }) });
    const scrolled = await page.locator("main.scroll").evaluate((m) => {
      m.scrollTop = 120;
      return m.scrollTop;
    });
    expect(scrolled, "main must scroll at this size, or the check below proves nothing").toBeGreaterThan(40);
    // Fully in view first: Playwright scrolls a partly hidden target into view before clicking, and that scroll is
    // not the app's to undo.
    await salt.scrollIntoViewIfNeeded();
    expect(await page.locator("main.scroll").evaluate((m) => m.scrollTop)).toBeGreaterThan(40);
    const top = (await salt.boundingBox())!.y;
    await salt.getByRole("button", { name: "Salt: pin" }).click();
    await expect(pinnedSection.locator(".row .name")).toHaveText(["Bread", "Eggs", "Salt"]);
    const pinnedSalt = groceries.locator(".row", { has: page.getByRole("button", { name: "Salt: unpin" }) });
    // Answered first: while the tap waits, the queue's status line sits above the list and shifts it ~16 px (flaked
    // once on desktop, 2026-11-26), which is not the pin's doing.
    await settled(page);
    expect(Math.abs((await pinnedSalt.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
    await pinnedSalt.getByRole("button", { name: "Salt: unpin" }).click();
    await expect(pinnedSection.locator(".row .name")).toHaveText(["Bread", "Eggs"]);
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

  test("APLANE-81: an item is deleted from its sheet after a confirmation", async ({ page }) => {
    const name = `QA e2e delete ${Date.now()}`;
    const res = await apiPost(
      page,
      `/api/workspaces/qa-inv/projects/${INV!.projects.HOME.id}/inventory/lists/${INV!.inventory.lists["Groceries"]}/items/`,
      { name }
    );
    const { id } = (await res.json()) as { id: string };
    await open(page, `#/item/${id}`);
    await page.getByRole("button", { name: "Delete item" }).click();
    await page
      .getByRole("dialog", { name: `Delete “${name}”?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText(`${name}: deleted.`)).toBeVisible();
    await expect(page).toHaveURL(/#\/inventory$/);
    const left = await (
      await page.request.get(`/api/workspaces/qa-inv/inventory/suggestions/?q=${encodeURIComponent(name)}`)
    ).json();
    expect((left.items as { name: string }[]).some((i) => i.name === name)).toBe(false);
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
      await page.getByRole("button", { name: "Protein: Mark ordered" }).click();
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
    await page.getByRole("dialog").getByRole("button", { name: "Protein: Cancel order" }).click();
    await expect(page.getByRole("region", { name: "On the way · 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Protein: Mark ordered" })).toBeVisible();
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
    const input = page.getByLabel(touch ? "Salt: Take photo" : "Salt: Add photo");
    await expect(input).toHaveCount(1);
    if (touch) {
      await expect(input).toHaveAttribute("capture", "environment");
      await expect(page.getByLabel("Salt: Gallery")).toHaveCount(1);
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
    await page.getByRole("button", { name: "Salt: Remove photo" }).click();
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

  test("S34: with text at 130 % and 200 % on a 360 px phone, no row squeezes, covers or pushes out", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/shopping/");
    await expect(page.getByRole("checkbox", { name: "Nappies: bought" })).toBeVisible();
    const { out: result, scale: fontScale } = await page.evaluate(async () => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Android's font scale multiplies every font size. Since APLANE-78 the app's sizes are calc(px × --font-scale)
      // except the 16px inputs: the variable and the px rules are scaled (scaling elements instead compounds through
      // nesting). Original values read once.
      const root = document.documentElement;
      const scale = parseFloat(getComputedStyle(root).getPropertyValue("--font-scale")) || 1;
      const base: [CSSStyleRule, number][] = [];
      // Inside evaluate: it runs in the page, so it cannot move out.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const walk = (rules: CSSRuleList) => {
        for (const r of Array.from(rules)) {
          if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
          const style = (r as CSSStyleRule).style;
          if (style?.fontSize?.endsWith("px")) base.push([r as CSSStyleRule, parseFloat(style.fontSize)]);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
      // The worst row the seed lacks: a long name, a long list name and a badge (measured on the Realme: the
      // list name covered the item name by 40 px at 130 % and the badge left the row at 200 %).
      const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((b) =>
        /Nappies/.test(b.getAttribute("aria-label") ?? "")
      )!;
      const row = box.closest("label.row")!;
      const name = row.querySelector(":scope > .name")!;
      const meta = row.querySelector(":scope > .sub.inline")!;
      name.firstChild!.textContent = "Washing-up liquid concentrate lemon";
      meta.firstChild!.textContent = "Groceries and household";
      const badge = row.querySelector(":scope > .badge")!;
      const out: Record<
        string,
        { name: number; overlap: number; out: number; sideways: number; edge: number; badgeShort: number }
      > = {};
      for (const k of [1, 1.3, 2]) {
        for (const [r, px] of base) r.style.fontSize = `${px * k}px`;
        root.style.setProperty("--font-scale", String(scale * k));
        // Sequential on purpose: each scale is measured after the previous one is replaced.
        // oxlint-disable-next-line no-await-in-loop
        await wait(200);
        const nr = name.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(meta);
        let overlap = 0;
        for (const rect of Array.from(range.getClientRects()))
          if (
            rect.width &&
            rect.left < nr.right - 1 &&
            rect.right > nr.left &&
            rect.top < nr.bottom &&
            rect.bottom > nr.top
          )
            overlap = Math.max(overlap, nr.right - rect.left);
        const labelled = Array.from(document.querySelectorAll("label.row"));
        const rows = Array.from(document.querySelectorAll(".row"));
        out[String(k)] = {
          name: Math.round(nr.width),
          overlap: Math.round(overlap),
          out: labelled.filter(
            (x) => x.lastElementChild!.getBoundingClientRect().right > x.getBoundingClientRect().right + 1
          ).length,
          sideways:
            rows.filter((x) => x.scrollWidth > x.clientWidth + 1).length +
            (document.scrollingElement!.scrollWidth > innerWidth ? 1 : 0),
          // At normal size the badge stays on one line: compared by height with a one-line copy, not by rounded
          // widths (a fraction of a pixel less already wraps it, and Math.round hid that).
          badgeShort: (() => {
            const clone = badge.cloneNode(true) as HTMLElement;
            clone.style.cssText = "position:absolute;visibility:hidden;width:max-content;white-space:nowrap";
            row.append(clone);
            const oneLine = clone.getBoundingClientRect().height;
            clone.remove();
            return badge.getBoundingClientRect().height > oneLine + 1 ? 1 : 0;
          })(),
          // The top bar's counter and the workspace picker stay inside the screen (both widened the page at 200 %).
          edge: Array.from(document.querySelectorAll(".topbar > *, .select.workspace")).filter(
            (e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1
          ).length,
        };
      }
      return { out, scale };
    });
    // The floor was 60 px for 15 px text; it scales with the text (APLANE-78: × 0.9 → 54 px, the same letters).
    const floor = 60 * fontScale;
    expect(result["1"]!.badgeShort, "badge wrapped at 100 %").toBe(0);
    for (const k of ["1", "1.3", "2"]) {
      expect(result[k]!.name, `name width at ${k}`).toBeGreaterThan(floor);
      expect(result[k]!.overlap, `list name over the item name at ${k}`).toBe(0);
      expect(result[k]!.out, `badges off the row at ${k}`).toBe(0);
      expect(result[k]!.sideways, `rows scrolling sideways at ${k}`).toBe(0);
      expect(result[k]!.edge, `top bar or workspace picker past the edge at ${k}`).toBe(0);
    }
  });

  test("inventory list chips keep their names whole and apart when they do not fit (prod 2026-11-23)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/shopping/#/inventory");
    const chips = page.getByRole("navigation", { name: "List" }).locator(".chip");
    await expect(chips.first()).toBeVisible();
    const result = await chips.evaluateAll((els) => {
      // The real HOME lists: longer than the seed's, more than fit on the row.
      const names = ["Supermercado", "Suplementos", "Botiquín y suplementos", "Casa", "Bebé"];
      els.slice(1).forEach((e, i) => (e.textContent = names[i % names.length]!));
      const rects = els.map((e) => e.getBoundingClientRect());
      return {
        cut: els.filter((e) => e.scrollWidth > e.clientWidth + 1).length,
        overlapping: rects.slice(1).filter((r, i) => r.left < rects[i]!.right - 1).length,
      };
    });
    expect(result).toEqual({ cut: 0, overlapping: 0 });
  });

  test("S51: /shopping without the slash lands on the app", async ({ page }) => {
    await page.goto("/shopping");
    await expect(page).toHaveURL(/\/shopping\/(#.*)?$/);
    await expect(page.locator('meta[name="plane-shopping-shell"]')).toHaveCount(1);
  });

  test("S62: the same person on two devices: the tick shows on both, Done only where it was ticked", async ({
    browser,
  }, info) => {
    const phone = await contextFor(browser, info, "qa-inv-ana");
    const desk = await contextFor(browser, info, "qa-inv-ana");
    try {
      await open(phone.page);
      await open(desk.page);
      await phone.page.getByRole("checkbox", { name: "Milk: bought" }).click();
      await settled(phone.page);
      await server(phone.page, "Milk", "needed").toBe(false);
      await expect(phone.page.getByRole("checkbox", { name: "Milk: not bought after all" })).toBeVisible();
      await desk.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(desk.page.getByRole("checkbox", { name: "Milk: bought" })).toHaveCount(0);
      await expect(desk.page.getByRole("checkbox", { name: "Milk: not bought after all" })).toHaveCount(0);
    } finally {
      await phone.context.close();
      await desk.context.close();
    }
  });

  test("APLANE-73: Plane's menu: back shuts it; a project's work items open in Plane and back returns here", async ({
    page,
  }) => {
    await open(page);
    const toggle = page.getByRole("button", { name: "Open the Plane menu" });
    const nav = page.getByRole("dialog", { name: "Plane" });
    // Back with the menu open shuts the menu and stays on the list (it does not leave the screen).
    await toggle.click();
    await expect(nav).toBeVisible();
    await page.goBack();
    await expect(nav).toHaveCount(0);
    await expect(page).toHaveURL(/\/shopping\/(#\/?)?$/);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await toggle.click();
    await expect(nav.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/qa-inv/notifications/");
    await nav.getByRole("button", { name: /Home$/ }).click();
    await nav.getByRole("link", { name: "Work items" }).click();
    await expect(page).toHaveURL(new RegExp(`/qa-inv/projects/${INV!.projects.HOME.id}/issues`));
    await page.goBack();
    await expect(page).toHaveURL(/\/shopping\/(#\/?)?$/);
    await expect(page.locator("[data-phase]")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await expect(nav).toHaveCount(0);
  });

  test("APLANE-73: at 360 px the menu toggle, the tabs and the counter share one row, with two-digit counts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);
    // Rendered first, so the widening below really has two numbers to widen.
    await expect(page.locator(".topbar .count")).toHaveText(["7"]);
    const row = await page.evaluate(() => {
      // Two digits: the widest a household list reaches in practice.
      for (const c of Array.from(document.querySelectorAll(".topbar .count"))) c.lastChild!.textContent = "12";
      const [toggle, tabs, counts] = [".nav-toggle", ".tabs", ".topbar .counts"].map((sel) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      });
      return { toggle, tabs, counts };
    });
    expect(Math.abs(row.counts - row.tabs), JSON.stringify(row)).toBeLessThanOrEqual(2);
    expect(Math.abs(row.toggle - row.tabs), JSON.stringify(row)).toBeLessThanOrEqual(2);
  });

  test("the top bar and the bottom bar are both in view and the page itself never scrolls, even when 100dvh is too tall", async ({
    page,
  }) => {
    // Diego's Pixel (installed app, nav bar shown, 2026-11-24): the document scrolled ~53 px, so one of the two
    // bars was always cut. A browser cannot be made to serve a wrong 100dvh, so the shell is forced 53 px taller
    // than 100dvh: the cap must still hold it to the viewport.
    await page.setViewportSize({ width: 360, height: 740 });
    const fits = async (hash: string) => {
      await open(page, hash);
      await expect(page.locator(".bottombar")).toBeVisible();
      const m = await page.evaluate(() =>
        ["", "calc(100dvh + 53px)"].map((height) => {
          document.getElementById("app")!.style.height = height;
          const se = document.scrollingElement!;
          const top = document.querySelector(".topbar")!.getBoundingClientRect().top;
          const bottom = document.querySelector(".bottombar")!.getBoundingClientRect().bottom;
          return { height, scroll: se.scrollHeight - se.clientHeight, top, bottom, view: se.clientHeight };
        })
      );
      for (const r of m) {
        const what = `${hash} ${JSON.stringify(r)}`;
        expect(r.scroll, what).toBe(0);
        expect(r.top, what).toBeGreaterThanOrEqual(0);
        expect(r.bottom, what).toBeLessThanOrEqual(r.view + 1);
      }
    };
    await fits("#/");
    await fits("#/inventory");
  });

  test("APLANE-73: a double tap on the menu's scrim goes back once and never leaves the screen", async ({ page }) => {
    // jsdom coalesces two history.back() calls; only a real browser shows the second one leaving the list.
    await open(page, "#/inventory");
    await page.getByRole("link", { name: "Shopping", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await page.getByRole("button", { name: "Open the Plane menu" }).click();
    await expect(page.getByRole("dialog", { name: "Plane" })).toBeVisible();
    // Both taps in one task, before the first back()'s popstate: separate CDP clicks let it land in between,
    // and the unguarded code then passed (re-review).
    await page.locator(".nav-scrim").evaluate((el: HTMLElement) => {
      el.click();
      el.click();
    });
    await expect(page.getByRole("dialog", { name: "Plane" })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/shopping\/#\/$/);
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
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

// Every baseline renamed "-a77" at once (APLANE-77/78/81, 2026-11-25): text 20 % smaller, the pin counter gone,
// pinned rows first in the inventory, the sheet's Delete item. The new names create their baselines.
// Renamed again "-a78": the fields follow the smaller text too (16px kept on iOS only).
// Renamed "-b26" (2026-11-26): text back to × 0.9, controls × 0.85, the Pinned section in the inventory.
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
    // Renamed again with the Plane menu toggle and the counter as icons in the top bar (APLANE-73; again when
    // the pin became the filled one: an earlier dev run had made a baseline with the outline pin).
    await shot(page, "vs-01-list-b26");
  });

  test("VS-02 shopping mode", async ({ page }) => {
    await open(page, "#/shop");
    await expect(page.getByRole("checkbox", { name: "Milk: bought" })).toBeVisible();
    await shot(page, "vs-02-shop-b26");
  });

  test("VS-03 quick capture", async ({ page }) => {
    await open(page, "#/capture");
    await page.getByRole("searchbox").fill("nap");
    await expect(page.getByRole("button", { name: "Nappies: Running low" })).toBeVisible();
    await shot(page, "vs-03-capture-b26");
  });

  test("VS-04 inventory", async ({ page }) => {
    await open(page, "#/inventory");
    await expect(page.getByRole("link", { name: "Open Mulch" })).toBeVisible();
    // Renamed with the Plane menu toggle in the top bar (APLANE-73; renamed again for its final margins).
    await shot(page, "vs-04-inventory-b26");
  });

  test("VS-05 item sheet", async ({ page }) => {
    // Nappy cream: no workflow above touches it, so its history is the same on every project.
    await open(page, `#/item/${items["Nappy cream"]}`);
    await expect(page.getByText(/set it to: In stock/)).toBeVisible();
    // Renamed with each change to this screen (APLANE-66 photo field, then the camera button on touch screens):
    // the new name creates its baseline.
    await shot(page, "vs-05-item-b26");
  });

  test("VS-06 order dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Protein: Mark ordered" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-06-order-b26", page.getByRole("dialog"));
  });

  test("VS-07 arrival dialog", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Magnesium: the order arrived" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "vs-07-arrival-b26", page.getByRole("dialog"));
  });

  test("VS-09 Plane's menu (APLANE-73)", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Open the Plane menu" }).click();
    const nav = page.getByRole("dialog", { name: "Plane" });
    await expect(nav.getByRole("button", { name: /Home$/ })).toBeVisible();
    // Renamed when the entries gained Plane's icons, and for the filled pin in the counter behind the scrim.
    await shot(page, "vs-09-menu-b26");
  });

  test("VS-08 waiting and unapplied", async ({ page }) => {
    await open(page, "#/pending");
    await expect(page.getByText("Nothing waiting.")).toBeVisible();
    await shot(page, "vs-08-pending-b26");
  });
});
