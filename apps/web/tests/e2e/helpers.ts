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
 * `page.reload()` that retries a WebKit load abort.
 *
 * Measured on the iphone project 2026-11-05 in a deploy gate: `page.reload: Frame load
 * interrupted` / `waiting for navigation until "load"` on the first attempt, green on Playwright's
 * own test-level retry. Chromium did not reproduce it. The failing trace was wiped by the next
 * gate run before it could be read, so **the cause is not established** — only the symptom.
 *
 * What is NOT the cause, so nobody re-derives it (the first version of this comment claimed it and
 * was wrong): a React Router client-side navigation. Those go through `history.pushState` (see
 * app/compat/next/navigation.ts), which does not abort a document load in any engine.
 * `Frame load interrupted` needs a competing DOCUMENT-level navigation, or a cancelled provisional
 * load.
 *
 * The only document-level navigation the app itself can make on an authenticated route is the 401
 * interceptor in core/services/api.service.ts, which does `window.location.replace("/")`. That is
 * the leading suspect — a session failure mid-test would abort the reload — which is what the URL
 * guard below is for: if the abort was the app bailing out to the login page, this has to fail
 * loudly, not retry into a successfully reloaded "/" and leave the caller to fail somewhere
 * unrelated.
 *
 * There is no `waitForLoadState` here on purpose. It resolves against the already-committed
 * document and does NOT wait for a pending navigation to commit, so in this exact race it returns
 * immediately and buys nothing. The backoff is what makes the retry different from the attempt
 * that just failed: after an abort the old document is still current and already
 * `domcontentloaded`, so a bare retry fires within microseconds and lands in the same window.
 *
 * Retrying is a harness measure, not a fix, and it does not close the flake. If this appears next
 * to a real symptom — a redirect loop, a route that never finishes loading, a burst of 401s — the
 * app is the thing to look at.
 *
 * To capture the next occurrence: the gate wipes apps/web/test-results on its next run, and the
 * VPS has no `unzip` — read trace.zip with python's zipfile, and copy the directory before
 * re-running anything.
 */
export async function resilientReload(page: Page, attempts = 3) {
  const before = new URL(page.url()).pathname;
  for (let attempt = 1; ; attempt++) {
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      const aborted = /Frame load interrupted|interrupted by another navigation/i.test(String(error));
      if (!aborted || attempt >= attempts) throw error;
      await page.waitForTimeout(250 * attempt);
      const now = new URL(page.url()).pathname;
      if (now !== before)
        throw new Error(
          `resilientReload: reloading ${before} was aborted and the page is now at ${now}. ` +
            `The app navigated away rather than losing a race — a lost session (the 401 ` +
            `interceptor redirects to "/") is the first thing to check. Original: ${error}`
        );
    }
  }
}

/**
 * WebKit reports a resource load it abandoned as a page error, which is NOT a defect (APLANE-29).
 *
 * Measured 2026-11-05 from a saved trace of the L5-17 permalink test on the iphone project: the
 * request named in the error has **no network record at all** among the run's 1276 resource
 * snapshots — it was started and never completed, i.e. killed when the test navigated away. And
 * the decisive part: the `background()` fix that wraps every one of those fetches in a `.catch`
 * is deployed, and this still fires — so it is not an unhandled promise rejection and no amount
 * of catching in app code can suppress it. WebKit is reporting the abandoned load itself.
 *
 * Navigating away from a page that is still fetching is ordinary user behaviour, so failing a test
 * on it is a false positive by construction. Chromium says nothing here.
 *
 * "due to access control checks" reads like CORS and is not: every request in this app is
 * same-origin and sends no `Origin`, and no response in the trace carries
 * `access-control-allow-origin` — not even the 200s. It is WebKit's generic wording for any load
 * it would not complete, so the message carries no CORS signal for us and nothing is lost by
 * classifying it.
 *
 * This is a deliberate narrowing of the guard, not a disabling of it: the messages are still
 * attached to the report as `aborted-loads`, every other uncaught error still fails, and the
 * guard's whole point — catching a genuine uncaught error in our fork's code — is untouched. If a
 * real CORS problem ever appears it will come with a completed response that lacks the header,
 * which this pattern does not match.
 */
const ABORTED_LOAD = /XMLHttpRequest cannot load .* due to access control checks/i;

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
      const abortedLoads: string[] = [];
      page.on("pageerror", (e) => {
        const msg = `${e.name}: ${e.message}`;
        // React Router SPA mode hydrates the pre-rendered shell; React reports the mismatch as
        // recoverable errors #418/#423/#425 on every route and re-renders on the client. Known
        // upstream noise (2026-09-17) — attached for visibility, not a failure.
        if (/Minified React error #(418|423|425)\b/.test(msg)) hydrationNoise.push(msg);
        else if (ABORTED_LOAD.test(msg)) abortedLoads.push(msg);
        else pageErrors.push(msg);
      });
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      await use();
      if (consoleErrors.length) await testInfo.attach("console-errors", { body: consoleErrors.join("\n") });
      if (hydrationNoise.length)
        await testInfo.attach("hydration-noise", { body: `${hydrationNoise.length} recoverable hydration errors` });
      if (abortedLoads.length) await testInfo.attach("aborted-loads", { body: abortedLoads.join("\n") });
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
