/**
 * Shared E2E helpers: seeded ids, per-user sessions, and the guard every test runs under
 * (no error boundary, no uncaught page error, no horizontal overflow on phones).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

export const QA_USERS = ["qa-alice", "qa-bob", "qa-carol", "qa-guest"] as const;
export type QaUser = (typeof QA_USERS)[number];
const HERE = path.dirname(fileURLToPath(import.meta.url)); // ES module: no __dirname
export const authFile = (user: QaUser) => path.join(HERE, ".auth", `${user}.json`);

type Project = {
  id: string;
  identifier: string;
  issues: string[];
  views?: Record<string, string>;
  pages?: Record<string, string>;
  cycle?: string;
  module?: string;
  states?: Record<string, string>;
  archived_issue?: string;
};
export type Manifest = {
  anchor: string;
  users: Record<"alice" | "bob" | "carol" | "guest", { id: string; email: string }>;
  workspaces: {
    qa: { projects: Record<"QAA" | "QAB" | "QAG", Project>; views: Record<string, string> };
    "qa-2": { projects: Record<"QTW", Project> };
  };
};
export const manifest: Manifest = JSON.parse(fs.readFileSync(process.env.PT_MANIFEST ?? "qa-manifest.json", "utf8"));

/** Something the global or the per-layout error boundary renders. */
export async function expectNoErrorBoundary(page: Page) {
  await expect(page.getByText("Looks like something went wrong")).toHaveCount(0);
  const layoutFallback = page
    .getByText("Something went wrong", { exact: true })
    .locator("xpath=..")
    .getByRole("button", { name: "Retry" });
  await expect(layoutFallback).toHaveCount(0);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `page scrolls horizontally (${scroll} > ${client})`).toBeLessThanOrEqual(client + 1);
}

export const isPhone = (projectName: string) => projectName === "android" || projectName === "iphone";

/**
 * Phones start with the nav drawer open over the content. Tests about the content close it
 * the way a person does: tap the dimmed area to the right of the drawer (B-15 scrim).
 */
export async function closeDrawer(page: Page, projectName: string) {
  if (!isPhone(projectName)) return;
  await expect(page.getByRole("button", { name: "Open workspace switcher" })).toBeVisible();
  const scrim = page.locator(".fixed.inset-0.bg-black\\/50");
  // the drawer (and its scrim) render a moment after the header — don't decide too early
  await scrim.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await scrim.isVisible()) {
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width - 12, Math.round(vp.height * 0.6));
    await expect(scrim).toHaveCount(0);
  }
}

/** Call the API as the stored session (csrftoken from the storage state; no navigation needed). */
async function apiCall(page: Page, method: "patch" | "post" | "delete", url: string, data?: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === "csrftoken")?.value ?? "";
  const res = await page.request[method](url, {
    ...(data === undefined ? {} : { data }),
    headers: { "X-CSRFToken": csrf, Referer: `${process.env.PT_BASE_URL ?? "https://plane-dev.local.akunito.com"}/` },
  });
  expect(res.ok(), `${method.toUpperCase()} ${url} → ${res.status()}`).toBeTruthy();
  return res;
}

export const apiPatch = (page: Page, url: string, data: unknown) => apiCall(page, "patch", url, data);
export const apiPost = (page: Page, url: string, data?: unknown) => apiCall(page, "post", url, data);
export const apiDelete = (page: Page, url: string) => apiCall(page, "delete", url);

/**
 * `test` with an automatic guard: uncaught page errors fail the test, and after the body
 * the page must show no error boundary (and no horizontal overflow on phones).
 */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use, testInfo) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const hydrationNoise: string[] = [];
      page.on("pageerror", (e) => {
        const msg = `${e.name}: ${e.message}`;
        // React Router SPA mode hydrates the pre-rendered shell; React reports the mismatch as
        // recoverable errors #418/#423/#425 on every route and re-renders on the client. Known
        // upstream noise (2026-09-17) — attached for visibility, not a failure.
        if (/Minified React error #(418|423|425)\b/.test(msg)) hydrationNoise.push(msg);
        else pageErrors.push(msg);
      });
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      await use();
      if (consoleErrors.length) await testInfo.attach("console-errors", { body: consoleErrors.join("\n") });
      if (hydrationNoise.length)
        await testInfo.attach("hydration-noise", { body: `${hydrationNoise.length} recoverable hydration errors` });
      expect(pageErrors, "uncaught errors in the page").toEqual([]);
      if (!page.isClosed() && page.url().startsWith("http")) {
        await expectNoErrorBoundary(page);
        if (isPhone(testInfo.project.name)) await expectNoHorizontalOverflow(page);
      }
    },
    { auto: true },
  ],
});
export { expect };
