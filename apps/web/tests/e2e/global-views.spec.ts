/**
 * Global / workspace views (catalog L5-50…L5-57): B-18…B-26.
 */
import type { Page } from "@playwright/test";
import { authFile, closeDrawer, expect, isPhone, manifest, test } from "./helpers";

const VIEWS = manifest.workspaces.qa.views;
type Layout = "spreadsheet" | "kanban" | "calendar" | "list";

async function renderedLayout(page: Page): Promise<Layout | "none"> {
  return page.evaluate(() => {
    const has = (sel: string) => document.querySelector(sel) !== null;
    if (has("table thead")) return "spreadsheet";
    if (has("[class~='group/kanban-block']")) return "kanban";
    if (has("[class~='group/calendar-block']")) return "calendar";
    if (has("[class~='group/list-block']")) return "list";
    return "none";
  });
}
const onDevice = (layout: Layout, device: string): Layout =>
  isPhone(device) && layout === "spreadsheet" ? "list" : layout;

/** the view's "⋯" in the page header row — not the sidebar's, not a work item row's (hover) menu */
async function viewMenu(page: Page) {
  const all = page.locator(
    "xpath=//button[.//*[contains(@class,'lucide-ellipsis')] and not(ancestor::*[@role='complementary'])]"
  );
  const find = () =>
    all.evaluateAll((bs) => {
      let best = -1;
      let bestX = -1;
      bs.forEach((b, i) => {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.top >= 30 && r.top < 110 && r.left > bestX) [best, bestX] = [i, r.left];
      });
      return best;
    });
  await expect.poll(find, { message: "view menu button in the header" }).toBeGreaterThanOrEqual(0);
  return all.nth(await find());
}

async function openView(page: Page, device: string, viewId: string) {
  await page.goto(`/qa/workspace-views/${viewId}/`);
  await closeDrawer(page, device);
}

test.use({ storageState: authFile("qa-alice") });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(`${manifest.anchor}T10:00:00+02:00`) });
});

test.describe("seeded global views render cross-project (L5-50, L5-52, B-18/B-19/B-20)", () => {
  const CASES: Array<[string, Layout]> = [
    ["QA Table", "spreadsheet"],
    ["QA Board", "kanban"],
    ["QA Calendar", "calendar"],
    ["QA Locked", "spreadsheet"],
  ];
  for (const [name, layout] of CASES) {
    test(`${name} → ${layout}`, async ({ page }, info) => {
      await openView(page, info.project.name, VIEWS[name]);
      await expect.poll(() => renderedLayout(page), { timeout: 20_000 }).toBe(onDevice(layout, info.project.name));
      if (layout === "kanban") {
        // cards render lazily per column: the five column counts must add up to every seeded
        // non-archived item across the three projects (36 − 3 archived)
        const counts = page.locator("span.text-sm.font-semibold + span");
        await expect(counts).toHaveCount(5);
        await expect.poll(async () => (await counts.allInnerTexts()).reduce((a, t) => a + Number(t), 0)).toBe(33);
      } else if (layout === "spreadsheet" && !isPhone(info.project.name)) {
        for (const ident of ["QAA", "QAB", "QAG"])
          await expect(
            page
              .getByText(new RegExp(`\\b${ident}-\\d+\\b`))
              .filter({ visible: true })
              .first()
          ).toBeVisible();
      } else if (layout === "spreadsheet") {
        // phones render the Table as a virtualised List: check the cross-project total (36 seeded − 3 archived)
        await expect(
          page
            .getByText(/\b33\b/)
            .filter({ visible: true })
            .first()
        ).toBeVisible();
      }
    });
  }
});

test("Board: five state-group columns, read-only, a card opens the item (L5-53)", async ({ page }, info) => {
  await openView(page, info.project.name, VIEWS["QA Board"]);
  await expect.poll(() => renderedLayout(page)).toBe("kanban");
  const headers = page.locator("span.text-sm.font-semibold");
  await expect(headers).toHaveText(["Backlog", "Unstarted", "Started", "Completed", "Canceled"]);
  await expect(page.getByText("No status", { exact: true })).toHaveCount(0);
  await page
    .locator("[class~='group/kanban-block']")
    .filter({ hasText: "QAB case 01" })
    .getByText("QAB case 01", { exact: false })
    .first()
    .click();
  await expect(page.getByText("Properties", { exact: true }).last()).toBeVisible();
});

test("layout selector offers exactly Table, Board, Calendar (L5-51, B-21…B-24)", async ({ page }, info) => {
  await openView(page, info.project.name, "all-issues");
  if (isPhone(info.project.name)) {
    // B-23/B-24: on phones the switcher lives inside Display, with labels
    await page.getByRole("button", { name: "Display" }).first().click();
    const sheet = page
      .locator("div.rounded-t-xl")
      .filter({ has: page.getByRole("button", { name: "Done", exact: true }) });
    await expect(sheet.getByText("Layout", { exact: true })).toBeVisible();
    const buttons = sheet.getByRole("button", { name: /Layout$/ });
    // ISSUE_LAYOUTS order, filtered to GLOBAL_VIEW_LAYOUTS
    await expect(buttons).toHaveText(["Board Layout", "Calendar Layout", "Table Layout"]);
    await sheet.getByRole("button", { name: "Board Layout" }).click();
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
  } else {
    await expect(page.getByRole("button", { name: "Board Layout" })).toHaveCount(0); // labels are phone-only
    const switcher = page
      .locator("div.hidden.md\\:flex")
      .filter({ has: page.locator("button") })
      .first();
    await expect(switcher.locator("button")).toHaveCount(3);
    await switcher.locator("button").nth(0).click(); // Board (ISSUE_LAYOUTS order: Board, Calendar, Table)
  }
  await expect.poll(() => renderedLayout(page)).toBe("kanban");
});

test("locked view: no Display and no layout switching (L5-50/L5-51)", async ({ page }, info) => {
  await openView(page, info.project.name, VIEWS["QA Locked"]);
  await expect.poll(() => renderedLayout(page)).not.toBe("none");
  await expect(page.getByRole("button", { name: "Display" })).toHaveCount(0);
});

test("header stays on one line with every control reachable on phones (L5-55, B-25)", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone-only");
  for (const width of [320, 360, 390, 412]) {
    await page.setViewportSize({ width, height: 800 });
    await openView(page, info.project.name, VIEWS["QA Board"]);
    const display = page.getByRole("button", { name: "Display" }).first();
    const menu = await viewMenu(page);
    const crumb = page.getByRole("button", { name: "QA Board" }).first();
    for (const [what, el] of [
      ["Display", display],
      ["⋯", menu],
      ["breadcrumb", crumb],
    ] as const) {
      await expect(el, `${what} at ${width}px`).toBeVisible();
      const box = (await el.boundingBox())!;
      expect(box.x + box.width, `${what} inside ${width}px`).toBeLessThanOrEqual(width + 1);
      expect(box.y, `${what} in the header row at ${width}px`).toBeLessThan(110);
    }
  }
});

test("'⋯' menu: Add view inside it on phones, header button on desktop (L5-56, B-23/B-26)", async ({ page }, info) => {
  await openView(page, info.project.name, VIEWS["QA Board"]);
  const headerAdd = page.getByRole("button", { name: "Add view", exact: true }).filter({ visible: true });
  if (isPhone(info.project.name))
    await expect(headerAdd).toHaveCount(0); // checked before the menu adds its own item
  else await expect(headerAdd).toBeVisible();
  await (await viewMenu(page)).click();
  const menuAdd = page.getByRole("menuitem", { name: /Add view/ }).filter({ visible: true });
  if (isPhone(info.project.name)) {
    await expect(menuAdd).toBeVisible();
    await menuAdd.click();
    await expect(page.getByText("Create View", { exact: true }).first()).toBeVisible();
  } else {
    await expect(menuAdd).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
});

test.describe("view actions depend on ownership (L5-57)", () => {
  test.use({ storageState: authFile("qa-carol") });
  test("a member who does not own the view gets no Edit/Delete", async ({ page }, info) => {
    await openView(page, info.project.name, VIEWS["QA Table"]);
    await (await viewMenu(page)).click();
    await expect(page.getByRole("menuitem", { name: /Copy link/ }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Edit/ }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^Delete/ }).filter({ visible: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
