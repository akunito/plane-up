/**
 * Visual regression (catalog VR-01…VR-13). Baselines are generated and compared ON THE RUNNER
 * (plane-tests on the VPS): fonts and rendering differ between machines, so never commit
 * baselines made elsewhere. Fixed QA data, browser clock pinned to the seed anchor, animations
 * off, volatile bits masked. Re-approve baselines only for intentional UI changes:
 *   plane-tests run.sh e2e --update-snapshots -g @visual
 */
import type { Locator, Page } from "@playwright/test";
import { authFile, closeDrawer, expect, isPhone, manifest, test } from "./helpers";

const QAA = manifest.workspaces.qa.projects.QAA;
const VIEWS = manifest.workspaces.qa.views;

const shot = async (page: Page, name: string, mask: Locator[] = []) => {
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
    // relative times, avatars' initials colours and unread dots are not what these screens test
    mask: [page.locator("time"), page.locator("[class*='rounded-full'][class*='bg-danger']"), ...mask],
  });
};

test.describe("@visual", () => {
  test.use({ storageState: authFile("qa-alice") });
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date(`${manifest.anchor}T10:00:00+02:00`) });
  });

  test("VR-01 login page", async ({ browser }, info) => {
    test.skip(info.project.name === "android", "desktop + iPhone only");
    const context = await browser.newContext({ ...info.project.use, storageState: undefined });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Sign in with Pocket ID/ })).toBeVisible();
    await shot(page, "vr-01-login");
    await context.close();
  });

  test("VR-02/03 sidebar (desktop) and open drawer with scrim (iPhone)", async ({ page }, info) => {
    test.skip(info.project.name === "android", "desktop + iPhone only");
    await page.goto("/qa/projects/");
    await expect(
      page.getByRole("complementary", { name: "Main sidebar" }).getByRole("link", { name: "Home" })
    ).toBeVisible();
    await shot(page, isPhone(info.project.name) ? "vr-03-drawer" : "vr-02-sidebar");
  });

  test("VR-06 Display bottom sheet (iPhone)", async ({ page }, info) => {
    test.skip(info.project.name !== "iphone", "iPhone only");
    await page.goto(`/qa/workspace-views/${VIEWS["QA Board"]}/`);
    await closeDrawer(page, info.project.name);
    // The first baseline captured the board WITHOUT the sheet: "Board Layout" also matched hidden text,
    // and the tap could land while the drawer was still closing. Require the sheet itself, retrying the tap.
    // start from the VISIBLE Done button: hidden Done buttons elsewhere made a board wrapper match
    const done = page.getByRole("button", { name: "Done", exact: true }).filter({ visible: true });
    const sheet = done.locator("xpath=ancestor::div[contains(concat(' ', @class, ' '), ' rounded-t-xl ')][1]");
    await expect(async () => {
      if (!(await done.count())) await page.getByRole("button", { name: "Display" }).first().click();
      await expect(sheet.getByRole("button", { name: "Board Layout" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    // The sheet fades in (Headless UI Transition). `animations: "disabled"` froze it at its transparent
    // start state, so wait until it and every ancestor are fully opaque and capture with animations on.
    await expect
      .poll(() =>
        sheet.evaluate((el) => {
          for (let n: Element | null = el; n; n = n.parentElement)
            if (getComputedStyle(n).opacity !== "1") return false;
          return true;
        })
      )
      .toBe(true);
    await expect(sheet).toHaveScreenshot("vr-06-display-sheet.png", { maxDiffPixelRatio: 0.01 });
  });

  test("VR-08 global Board", async ({ page }, info) => {
    test.skip(info.project.name === "android", "desktop + iPhone only");
    await page.goto(`/qa/workspace-views/${VIEWS["QA Board"]}/`);
    await closeDrawer(page, info.project.name);
    await expect(page.locator("[class~='group/kanban-block']").first()).toBeVisible();
    await shot(page, "vr-08-global-board");
  });

  test("VR-09 global Calendar (month)", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop only");
    await page.goto(`/qa/workspace-views/${VIEWS["QA Calendar"]}/`);
    await expect(page.locator("[class~='group/calendar-block']").first()).toBeVisible();
    await shot(page, "vr-09-global-calendar");
  });

  test("VR-10/13 global Table and project Spreadsheet as List on iPhone", async ({ page }, info) => {
    test.skip(info.project.name !== "iphone", "iPhone only");
    await page.goto(`/qa/workspace-views/${VIEWS["QA Table"]}/`);
    await closeDrawer(page, info.project.name);
    await expect(page.locator("[class~='group/list-block']").first()).toBeVisible();
    await shot(page, "vr-10-global-table-as-list");
    await page.goto(`/qa/projects/${QAA.id}/views/${QAA.views!.spreadsheet}/`);
    await closeDrawer(page, info.project.name);
    await expect(page.locator("[class~='group/list-block']").first()).toBeVisible();
    await shot(page, "vr-13-project-spreadsheet-as-list");
  });

  test("VR-11 global view header at 320px", async ({ page }, info) => {
    test.skip(info.project.name !== "android", "Android only");
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/qa/workspace-views/${VIEWS["QA Board"]}/`);
    await closeDrawer(page, info.project.name);
    await expect(page.getByRole("button", { name: "Display" }).first()).toBeVisible();
    await expect(page.locator("div.h-11").first()).toHaveScreenshot("vr-11-header-320.png", { animations: "disabled" });
  });
});
