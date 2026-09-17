/**
 * Sorting (catalog L5-70…L5-74): B-27…B-31. Expected orders are computed from the API data by an
 * oracle in this file and compared with the order the rows are actually rendered in.
 */
import type { Page } from "@playwright/test";
import { apiPatch, authFile, closeDrawer, expect, isPhone, manifest, test } from "./helpers";

const QAA = manifest.workspaces.qa.projects.QAA;
const PROPS = `/api/workspaces/qa/projects/${QAA.id}/user-properties/`;
const MS_KEY = "plane_multi_sort_secondary_order_by";
const PRIORITY = ["urgent", "high", "medium", "low", "none"];

type Item = { id: string; sequence_id: number; priority: string; target_date: string | null; created_at: string };

async function loadItems(page: Page): Promise<Item[]> {
  const res = await page.request.get(`/api/v1/workspaces/qa/projects/${QAA.id}/issues/?per_page=100`, {
    headers: { Referer: `${process.env.PT_BASE_URL}/` },
  });
  if (res.ok()) return (await res.json()).results;
  // session auth on the internal API as a fallback (v1 needs an API key)
  const internal = await page.request.get(`/api/workspaces/qa/projects/${QAA.id}/issues/?per_page=100&cursor=100:0:0`);
  const body = await internal.json();
  return (body.results ?? body) as Item[];
}

/** -priority then target_date (empties last, asc or desc), then created_at desc */
function oracle(items: Item[], targetDir: "asc" | "desc") {
  return [...items]
    .sort((a, b) => {
      const p = PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority);
      if (p) return p;
      if (!a.target_date !== !b.target_date) return a.target_date ? -1 : 1;
      if (a.target_date !== b.target_date)
        return (a.target_date! < b.target_date! ? -1 : 1) * (targetDir === "asc" ? 1 : -1);
      return a.created_at < b.created_at ? 1 : -1;
    })
    .map((i) => `QAA-${i.sequence_id}`);
}

async function renderedIds(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[class~='group/list-block']")]
      .map((b) => (b.textContent ?? "").match(/QAA-\d+/)?.[0])
      .filter(Boolean)
  );
}

/**
 * Rendered rows must follow the oracle. Lists are virtualised on phones, so rows below the fold
 * may not exist yet: compare the rendered prefix (at least 8 of the 11 rows).
 */
async function expectOrder(page: Page, expected: string[]) {
  await expect
    .poll(async () => {
      const got = await renderedIds(page);
      return got.length >= 8 && JSON.stringify(got) === JSON.stringify(expected.slice(0, got.length))
        ? "ok"
        : got.join(",");
    })
    .toBe("ok");
}

async function openDisplay(page: Page) {
  await page.getByRole("button", { name: "Display" }).first().click();
  await expect(page.getByText("Then sort by", { exact: true }).filter({ visible: true })).toBeVisible();
}

test.use({ storageState: authFile("qa-alice") });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("pt-ms-cleared")) {
      localStorage.removeItem(key);
      sessionStorage.setItem("pt-ms-cleared", "1");
    }
  }, MS_KEY);
});

test("order-by options: State everywhere, Project only on global views (L5-70, B-30/B-31)", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "same component on phones; covered by L5-71");
  await apiPatch(page, PROPS, { display_filters: { layout: "list", group_by: null, order_by: "-created_at" } });
  await page.goto(`/qa/projects/${QAA.id}/issues/`);
  await openDisplay(page);
  const adders = page.getByRole("button", { name: /^\+ / }).filter({ visible: true });
  await expect(adders.filter({ hasText: "State" })).toHaveCount(1);
  await expect(adders.filter({ hasText: "Project" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/qa/workspace-views/${manifest.workspaces.qa.views["QA Table"]}/`);
  await openDisplay(page);
  await expect(adders.filter({ hasText: "State" })).toHaveCount(1);
  await expect(adders.filter({ hasText: "Project" })).toHaveCount(1);
});

test("rules 2–3: add, flip, reorder, remove — rendered order follows the oracle (L5-71/L5-72, B-27)", async ({
  page,
}, info) => {
  await apiPatch(page, PROPS, { display_filters: { layout: "list", group_by: null, order_by: "-priority" } });
  await page.goto(`/qa/projects/${QAA.id}/issues/`);
  await closeDrawer(page, info.project.name);
  const items = await loadItems(page);
  expect(items.length).toBe(11);

  await openDisplay(page);
  await page.getByRole("button", { name: "+ Due date" }).filter({ visible: true }).click();
  await expectOrder(page, oracle(items, "asc"));

  await page.getByRole("button", { name: "Toggle sort direction" }).filter({ visible: true }).first().click();
  await expectOrder(page, oracle(items, "desc"));

  // a third rule, move it up, then remove it: order must come back to the two-rule oracle
  await page.getByRole("button", { name: "+ Start date" }).filter({ visible: true }).click();
  const moveUp = page.getByRole("button", { name: "Move up" }).filter({ visible: true });
  await expect(moveUp.first()).toBeDisabled();
  await moveUp.nth(1).click();
  await page.getByRole("button", { name: "Remove sort rule" }).filter({ visible: true }).first().click();
  await expectOrder(page, oracle(items, "desc"));
});

test("rules persist across reload and apply without refetching (L5-73/L5-74, B-28)", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "storage + network behaviour is device-independent");
  await apiPatch(page, PROPS, { display_filters: { layout: "list", group_by: null, order_by: "-priority" } });
  await page.goto(`/qa/projects/${QAA.id}/issues/`);
  const items = await loadItems(page);
  // let the page's own initial list fetch finish before counting
  await expect.poll(async () => (await renderedIds(page)).length).toBe(11);
  await page.waitForLoadState("networkidle");

  let listFetches = 0;
  page.on("request", (r) => r.url().includes(`/projects/${QAA.id}/issues/`) && r.method() === "GET" && listFetches++);
  await openDisplay(page);
  await page.getByRole("button", { name: "+ Due date" }).filter({ visible: true }).click();
  await expectOrder(page, oracle(items, "asc"));
  expect(listFetches, "re-sorting must not refetch the list").toBe(0);

  await page.reload();
  await expectOrder(page, oracle(items, "asc"));
  expect(await page.evaluate((k) => localStorage.getItem(k), MS_KEY)).toBe(JSON.stringify(["target_date"]));
});
