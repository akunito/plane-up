/**
 * Project-level layouts (catalog L5-30…L5-35): B-12, B-13, B-16.
 * Saved layout × context, rendered on desktop and phones (Spreadsheet/Gantt → List below 768px).
 */
import type { Page } from "@playwright/test";
import { apiPatch, authFile, closeDrawer, expect, isPhone, manifest, test } from "./helpers";

const QAA = manifest.workspaces.qa.projects.QAA;
const LAYOUTS = ["list", "kanban", "calendar", "spreadsheet", "gantt_chart"] as const;
type Layout = (typeof LAYOUTS)[number];

/** What is on screen, from DOM fingerprints measured on v1.4.1 (2026-09-17). */
async function renderedLayout(page: Page): Promise<Layout | "none"> {
  return page.evaluate(() => {
    const has = (sel: string) => document.querySelector(sel) !== null;
    if (has("#gantt-container")) return "gantt_chart";
    if (has("table thead")) return "spreadsheet";
    if (has("[class~='group/kanban-block']")) return "kanban";
    if (has("[class~='group/calendar-block']")) return "calendar";
    if (has("[class~='group/list-block']")) return "list";
    return "none";
  });
}

const expected = (saved: Layout, device: string): Layout =>
  isPhone(device) && (saved === "spreadsheet" || saved === "gantt_chart") ? "list" : saved;

const CONTEXTS = {
  project: { url: `/qa/projects/${QAA.id}/issues/`, props: `/api/workspaces/qa/projects/${QAA.id}/user-properties/` },
  cycle: {
    url: `/qa/projects/${QAA.id}/cycles/${QAA.cycle}/`,
    props: `/api/workspaces/qa/projects/${QAA.id}/cycles/${QAA.cycle}/user-properties/`,
  },
  module: {
    url: `/qa/projects/${QAA.id}/modules/${QAA.module}/`,
    props: `/api/workspaces/qa/projects/${QAA.id}/modules/${QAA.module}/user-properties/`,
  },
};

async function saveLayout(page: Page, propsUrl: string, layout: Layout) {
  await apiPatch(page, propsUrl, { display_filters: { layout } });
}

test.use({ storageState: authFile("qa-alice") });

// Seed dates are anchored to 2026-10-01; show the app that month so calendars have items.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(`${manifest.anchor}T10:00:00+02:00`) });
});

test.describe("saved layout × context (L5-30, B-13)", () => {
  for (const [name, ctx] of Object.entries(CONTEXTS)) {
    for (const layout of LAYOUTS) {
      test(`${name} saved as ${layout}`, async ({ page }, info) => {
        await saveLayout(page, ctx.props, layout);
        await page.goto(ctx.url);
        await expect.poll(() => renderedLayout(page), { timeout: 20_000 }).toBe(expected(layout, info.project.name));
      });
    }
  }
  for (const layout of LAYOUTS) {
    test(`project view saved as ${layout}`, async ({ page }, info) => {
      await page.goto(`/qa/projects/${QAA.id}/views/${QAA.views![layout]}/`);
      await expect.poll(() => renderedLayout(page), { timeout: 20_000 }).toBe(expected(layout, info.project.name));
    });
  }
});

test("visiting on a phone does not change the saved layout (L5-31)", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone-only");
  await saveLayout(page, CONTEXTS.project.props, "spreadsheet");
  await page.goto(CONTEXTS.project.url);
  await expect.poll(() => renderedLayout(page)).toBe("list");
  const saved = await (await page.request.get(CONTEXTS.project.props)).json();
  expect(saved.display_filters?.layout).toBe("spreadsheet");
});

test("Display opens as a bottom sheet on phones and a popover on desktop (L5-33, B-16)", async ({ page }, info) => {
  await saveLayout(page, CONTEXTS.project.props, "list");
  await page.goto(CONTEXTS.project.url);
  await expect.poll(() => renderedLayout(page)).toBe("list");
  await closeDrawer(page, info.project.name);
  await page.getByRole("button", { name: "Display" }).first().click();
  // the sheet: a bottom-docked panel titled "Display" with a Done button (FilterMobileSheet)
  const sheet = page
    .locator("div.rounded-t-xl")
    .filter({ hasText: "Display" })
    .filter({ has: page.getByRole("button", { name: "Done", exact: true }) });
  if (isPhone(info.project.name)) {
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.y + box.height, "sheet is docked to the bottom").toBeGreaterThan(vp.height - 60);
    expect(box.width, "sheet spans the screen").toBeGreaterThan(vp.width * 0.85);
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  } else {
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("Display Properties", { exact: false }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("peek overview layout (L5-35, B-12)", async ({ page }, info) => {
  await saveLayout(page, CONTEXTS.project.props, "list");
  await page.goto(CONTEXTS.project.url);
  await expect.poll(() => renderedLayout(page)).toBe("list");
  await closeDrawer(page, info.project.name);
  const row = page.getByRole("link", { name: /^QAA-1 QAA case 01/ }).first();

  if (isPhone(info.project.name)) {
    // tap the title: on phones the row's property chips (dates, labels) sit inside the same link
    await row.getByText("QAA case 01", { exact: false }).click();
    // iOS is "mobile" to usePlatformOS (full work item page), Android is not (side peek) — and the
    // outcome also depends on whether the tap lands before hydration. Accept either, then check
    // what B-12 is about: the work item fills the phone width (overflow is asserted by the guard).
    await expect(page.getByText("Properties", { exact: true }).last()).toBeVisible();
    const vp = page.viewportSize()!;
    const box = (await page.getByText("Properties", { exact: true }).last().boundingBox())!;
    expect(box.x, "work item content starts inside the screen").toBeLessThan(vp.width * 0.3);
    return; // the guard asserts no horizontal overflow either way
  }

  await row.click();
  // side-peek and modal are single-column; B-12 is about the two-column Full-screen peek
  await page.locator("xpath=//a[.//*[contains(@class,'lucide-move-diagonal')]]/following::button[1]").click();
  await page.getByRole("option", { name: /Full screen/i }).click();
  const panel = page.locator("[class*='md:!w-[400px]']").first();
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.width), "desktop side panel").toBe(400);

  // a narrow desktop window keeps the peek but stacks properties below the content
  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeGreaterThan(400);
  const content = page.locator("[class*='md:h-full'][class*='space-y-6']").first();
  const [pBox, cBox] = [(await panel.boundingBox())!, (await content.boundingBox())!];
  expect(pBox.y, "properties below the content").toBeGreaterThanOrEqual(cBox.y + cBox.height - 2);
});
