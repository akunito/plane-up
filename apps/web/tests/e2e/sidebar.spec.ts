/**
 * Sidebar & navigation (catalog L5-10…L5-19): B-02…B-11, B-15, B-33.
 * Runs on desktop, Android and iPhone; phone-only / desktop-only cases skip themselves.
 */
import type { Page } from "@playwright/test";
import { authFile, expect, isPhone, manifest, test } from "./helpers";

const { QAA, QAB } = manifest.workspaces.qa.projects;
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Main sidebar" });

/**
 * Make sure the nav is on screen. Desktop: always. Phones: the drawer remembers being closed
 * (e.g. after B-33 closed it on navigation, or a dialog's outside-tap closed it), so reopen it
 * with the page header's panel toggle — an icon button with no accessible name (upstream).
 */
async function openNav(page: Page, project: string) {
  await expect(page.getByRole("button", { name: "Open workspace switcher" })).toBeVisible();
  const home = sidebar(page).getByRole("link", { name: "Home" });
  if (isPhone(project) && !(await home.isVisible())) {
    await page.waitForTimeout(500); // drawer transition
    // the page header's toggle — not the sidebar's own (and not the off-screen peek copy)
    const toggle = page.locator(
      "xpath=//button[.//*[contains(@class,'lucide-panel-left')] and not(ancestor::*[@role='complementary'])]"
    );
    if (!(await home.isVisible())) await toggle.first().click();
  }
  await expect(home, `nav not visible on ${project}`).toBeVisible();
}

/**
 * Section header icons are hover-gated on desktop (B-05) and always shown on touch (B-06):
 * hover the section's disclosure button first where hover exists, then click the icon.
 * `index` picks the section among the sidebar's same-named icons (0 Workspace, 1 Projects).
 */
async function clickHeaderIcon(page: Page, project: string, section: RegExp | string, icon: string, index = 0) {
  await openNav(page, project);
  if (!isPhone(project)) await sidebar(page).getByRole("button", { name: section }).first().hover();
  // hidden icons are not in the accessibility tree: on desktop only the hovered section's icon is visible
  const target = sidebar(page)
    .getByRole("button", { name: icon })
    .nth(isPhone(project) ? index : 0);
  await expect(target).toBeVisible();
  await target.click();
}

test.describe("workspace nav defaults (L5-10, B-02)", () => {
  test.use({ storageState: authFile("qa-carol") });
  test("a user who never touched preferences sees Views and Analytics", async ({ page }, info) => {
    test.fail(
      true,
      "APLANE-22: v1.4.1 seeds sidebar preference rows with views/analytics unpinned, so the fork default never applies"
    );
    await page.goto(`/qa/projects/${QAA.id}/issues/`);
    await openNav(page, info.project.name);
    await expect(sidebar(page).getByRole("link", { name: "Views" })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Analytics" })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Archives" })).toHaveCount(0);
  });
});

test.describe("section header icons (L5-11, B-05/B-06)", () => {
  test.use({ storageState: authFile("qa-alice") });
  test("hidden until hover on desktop, always visible on touch", async ({ page }, info) => {
    await page.goto("/qa/projects/");
    await openNav(page, info.project.name);
    const manage = sidebar(page).getByRole("button", { name: "Manage pinned items" });
    if (isPhone(info.project.name)) {
      await expect(manage).toBeVisible();
    } else {
      await expect(manage).toBeHidden();
      await sidebar(page).getByRole("button", { name: "Pins", exact: true }).hover();
      await expect(manage).toBeVisible();
    }
  });
});

test.describe("pin dialogs (L5-12/L5-13, B-03/B-04)", () => {
  test.use({ storageState: authFile("qa-alice") });

  test("Projects pin opens a project list; clicking a project opens it and closes the dialog", async ({
    page,
  }, info) => {
    await page.goto("/qa/projects/");
    await openNav(page, info.project.name);
    await clickHeaderIcon(page, info.project.name, "Close projects menu", "Customize navigation", 1);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Projects", level: 2 })).toBeVisible();
    await expect(dialog.getByText("Personal", { exact: true })).toHaveCount(0);
    for (const name of ["QA Alpha", "QA Beta", "QA Gamma"])
      await expect(dialog.getByRole("button", { name })).toBeVisible();
    await dialog.getByRole("button", { name: "QA Beta" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${QAB.id}/issues/?$`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Workspace pin opens the dialog scoped to the Workspace section", async ({ page }, info) => {
    await page.goto("/qa/projects/");
    await openNav(page, info.project.name);
    await clickHeaderIcon(page, info.project.name, "Workspace", "Customize navigation", 0);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(/workspace/i);
    await expect(dialog.getByText("Personal", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("project row (L5-14, B-07)", () => {
  test.use({ storageState: authFile("qa-alice") });
  test("name opens Work Items; the chevron only expands", async ({ page }, info) => {
    await page.goto("/qa/projects/");
    await openNav(page, info.project.name);
    const url = page.url();
    const chevron = sidebar(page)
      .getByRole("link", { name: "QA Gamma" })
      .locator("xpath=..")
      .getByRole("button", { name: /project menu/ });
    if (await chevron.count()) {
      await chevron.first().click();
      await expect(page).toHaveURL(url);
    }
    await openNav(page, info.project.name);
    await sidebar(page).getByRole("link", { name: "QA Gamma" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${manifest.workspaces.qa.projects.QAG.id}/issues/?$`));
  });
});

async function clearPins(page: Page, project: string) {
  await clickHeaderIcon(page, project, /^Pins$/, "Manage pinned items");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Manage pinned items" })).toBeVisible();
  for (let i = 0; i < 20 && (await dialog.getByRole("button", { name: "Remove" }).count()); i++) {
    const before = await dialog.getByRole("button", { name: "Remove" }).count();
    await dialog.getByRole("button", { name: "Remove" }).first().click();
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(before - 1);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("Pins (L5-17/L5-18, B-08…B-11)", () => {
  test.use({ storageState: authFile("qa-alice") });

  test("pin a page and a ticket, they persist, the ticket opens its permalink, then unpin", async ({ page }, info) => {
    test.setTimeout(180_000); // several dialogs, a reload and a navigation, plus cleanup
    const device = info.project.name;
    await page.goto("/qa/projects/");
    await openNav(page, device);
    await clearPins(page, device); // a previous failed run may have left pins behind
    await openNav(page, device);
    const pins = sidebar(page);
    await expect(pins.getByRole("button", { name: /Pin pages or tickets/ })).toBeVisible();

    await clickHeaderIcon(page, device, /^Pins$/, "Manage pinned items");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Search pages to pin…").fill("QA page to pin");
    await dialog.getByRole("button", { name: "QA page to pin" }).click();
    await dialog.getByPlaceholder("Search tickets to pin…").fill("QAB case 02");
    await dialog.getByRole("button", { name: /QAB-2 QAB case 02/ }).click();
    await expect(dialog.getByText("QA page to pin")).toBeVisible();
    await expect(dialog.getByText(/QAB-2 QAB case 02/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    try {
      await page.reload();
      await openNav(page, device);
      await expect(pins.getByRole("button", { name: "QA page to pin" })).toBeVisible();
      // B-11: a pinned page is listed under Pins only, never duplicated in Favorites
      await expect(pins.getByText("QA page to pin", { exact: true })).toHaveCount(1);
      const ticket = pins.getByRole("button", { name: /QAB-2 QAB case 02/ });
      await expect(ticket).toBeVisible();
      await ticket.click();
      await expect(page).toHaveURL(/\/qa\/browse\/QAB-2\/?$/);
      await expect(page.getByText("QAB case 02", { exact: false }).first()).toBeVisible();
    } finally {
      await page.goto("/qa/projects/");
      await openNav(page, device);
      await clearPins(page, device);
    }
    await openNav(page, device);
    await expect(sidebar(page).getByRole("button", { name: /Pin pages or tickets/ })).toBeVisible();
  });
});

test.describe("mobile drawer (L5-19, B-15/B-33)", () => {
  test.use({ storageState: authFile("qa-alice") });

  test("closes after navigating from the sidebar, stays for non-navigating taps", async ({ page }, info) => {
    test.skip(!isPhone(info.project.name), "phone-only behaviour");
    await page.goto("/qa/projects/");
    await openNav(page, info.project.name);
    await expect(page.locator(".fixed.inset-0.bg-black\\/50")).toBeVisible();
    // a non-navigating tap (collapse / expand the Projects section) keeps the drawer open
    await sidebar(page)
      .getByRole("button", { name: /projects menu/ })
      .first()
      .click();
    await expect(sidebar(page).getByRole("link", { name: "Home" })).toBeVisible();
    await sidebar(page)
      .getByRole("button", { name: /projects menu/ })
      .first()
      .click();
    await sidebar(page).getByRole("link", { name: "QA Alpha" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${QAA.id}/issues/?$`));
    await expect(sidebar(page).getByRole("link", { name: "Home" })).toBeHidden();
    await expect(page.locator(".fixed.inset-0.bg-black\\/50")).toHaveCount(0);
  });

  test("desktop sidebar stays open when navigating", async ({ page }, info) => {
    test.skip(isPhone(info.project.name), "desktop-only behaviour");
    await page.goto("/qa/projects/");
    await sidebar(page).getByRole("link", { name: "QA Alpha" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${QAA.id}/issues/?$`));
    await expect(sidebar(page).getByRole("link", { name: "Home" })).toBeVisible();
  });
});
