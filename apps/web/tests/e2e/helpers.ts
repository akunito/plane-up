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

export const BASE_URL = process.env.PT_BASE_URL ?? "https://plane-dev.local.akunito.com";
const APP_ORIGIN = new URL(BASE_URL).origin;

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
    headers: { "X-CSRFToken": csrf, Referer: `${BASE_URL}/` },
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
 * **Verified mechanism**, read from the playwright-core that actually runs the suite (1.64.1,
 * `node_modules/.pnpm/playwright-core@1.64.1/.../lib/coreBundle.js:48591`): the WebKit backend
 * turns EVERY console message with `level === "error" && source === "javascript"` into a page
 * error. So a `pageerror` on WebKit is not "an uncaught exception" as the docs say — a plain
 * console error qualifies, and `XMLHttpRequest::didFail` logs one for any load it abandons.
 * Chromium's page errors come only from `Runtime.exceptionThrown`, which is why this is
 * iphone-only: structural, not timing.
 *
 * That also explains the mangled text. `splitErrorMessage` (`coreBundle.js:9359`) splits on the
 * FIRST colon — here the one in `https:` — and takes `substring(idx + 2)`, eating a slash. So the
 * guard sees `XMLHttpRequest cannot load https: /host/path …`, which matches the string in the
 * failing report exactly. `abortedLoadOrigin` below undoes that before parsing.
 *
 * Navigating away from a page that is still fetching is ordinary user behaviour, so failing a test
 * on it is a false positive by construction, and `waitForLoadState("networkidle")` does not help
 * because the detail page starts more fetches after it resolves and SWR retries them.
 *
 * **This is gated on evidence, not on wording**, because the wording alone proves nothing: WebKit
 * emits this same sentence for a genuine CORS fault, a failed preflight and a blocked
 * cross-origin redirect. A message is only treated as noise when BOTH hold:
 *   - the request's origin is our own app origin — every request in this deployment is same-origin
 *     (the Caddyfile proxies even presigned MinIO uploads through the app host, APLANE-15), so a
 *     cross-origin failure here is real and must fail. That turns a deployment fact into an
 *     enforced invariant: point assets at a real S3 host and its CORS faults fail the suite again.
 *   - it arrived within NAVIGATION_GRACE_MS of a main-frame navigation, which is what makes it an
 *     *abandoned* load rather than a *failed* one.
 *
 * No count threshold on purpose: a page genuinely fetching on every navigation can legitimately
 * abandon dozens of requests, so a number would just invent a new flake.
 *
 * What this does NOT rest on, because I got it wrong first: "background() is deployed and this
 * still fires, so it is not a rejection". The URL in the error is `retrieveWithIdentifier`, the
 * PRIMARY awaited fetch at issue.store.ts:277, which background() never wrapped — so that proved
 * nothing about it. The conclusion holds for two better reasons: that fetch's only caller is a
 * useSWR fetcher, which captures rejections, and WebKit words an actual unhandled rejection
 * "Unhandled Promise Rejection: …", not this.
 */
const ABORTED_LOAD = /XMLHttpRequest cannot load .* due to access control checks/i;
const NAVIGATION_GRACE_MS = 3_000;

/** The origin of the request named in a WebKit load error, undoing splitErrorMessage's damage. */
const abortedLoadOrigin = (msg: string): string | null => {
  const match = /cannot load (https?):\s*\/*([^\s]+)/i.exec(msg);
  if (!match) return null;
  try {
    return new URL(`${match[1]}://${match[2]}`).origin;
  } catch {
    return null;
  }
};

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
      const unauthorized: string[] = [];
      let lastNavigation = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) lastNavigation = Date.now();
      });
      // A 401 on an authenticated run means the session was lost, and no test in this suite
      // expects one. Asserted directly because the burst of page errors that used to reveal it
      // (the 401 interceptor's window.location.replace abandons every in-flight XHR at once) is
      // now classified as noise above — so without this, a mid-run session loss would surface as
      // some unrelated assertion failing later.
      page.on("response", (response) => {
        if (response.status() === 401) unauthorized.push(`${response.request().method()} ${response.url()}`);
      });
      page.on("pageerror", (e) => {
        const msg = `${e.name}: ${e.message}`;
        // React Router SPA mode hydrates the pre-rendered shell; React reports the mismatch as
        // recoverable errors #418/#423/#425 on every route and re-renders on the client. Known
        // upstream noise (2026-09-17) — attached for visibility, not a failure.
        if (/Minified React error #(418|423|425)\b/.test(msg)) hydrationNoise.push(msg);
        else if (
          ABORTED_LOAD.test(msg) &&
          abortedLoadOrigin(msg) === APP_ORIGIN &&
          Date.now() - lastNavigation < NAVIGATION_GRACE_MS
        )
          abortedLoads.push(msg);
        else pageErrors.push(msg);
      });
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      await use();
      if (consoleErrors.length) await testInfo.attach("console-errors", { body: consoleErrors.join("\n") });
      if (hydrationNoise.length)
        await testInfo.attach("hydration-noise", { body: `${hydrationNoise.length} recoverable hydration errors` });
      if (abortedLoads.length) await testInfo.attach("aborted-loads", { body: abortedLoads.join("\n") });
      expect(unauthorized, "the session was lost mid-test (401)").toEqual([]);
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
