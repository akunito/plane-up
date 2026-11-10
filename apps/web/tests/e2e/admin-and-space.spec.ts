/**
 * L5-80 /god-mode (apps/admin) · L5-81 /spaces (apps/space) — the two shipped apps nothing opened.
 *
 * Both are copied into the AIO image this fork deploys (deployments/aio/community/Dockerfile:37-39)
 * and until 2026-11-10 no layer exercised either at runtime: L3-08 only asserts the routes answer
 * 200 + text/html, L7-02b/L7-02c only that the bundles' assets load, and no E2E spec opened them
 * (APLANE-45). All of that passes on a shell that renders an error boundary, because the error page
 * ships the same assets. These tests are what makes a white screen in either app a failure.
 *
 * Most of the assertion is the suite's automatic guard in helpers.ts — uncaught page errors fail
 * the test and `expectNoErrorBoundary` runs after the body — so the explicit checks below only have
 * to prove the app really MOUNTED rather than served an empty shell. That guard matched only
 * apps/web's boundary copy until these tests were written; it now matches admin's and space's too,
 * because otherwise the sentence above would have been false for exactly the two routes it is
 * written about.
 *
 * `unauthenticated: true` is required, not convenient: measured on dev 2026-11-10, both routes log
 * legitimate 401s while anonymous (/god-mode probes instance-admin state, /spaces probes the viewer)
 * and the guard's session tripwire would fail every test here. Opted out per describe, like the
 * login-page test in shell.spec.ts, rather than exempting those URLs globally.
 *
 * Both suites here depend on runtime instance state, which is worth knowing when one goes red:
 * the OAuth slot renders only while `is_gitea_enabled` is on (an InstanceConfiguration row an admin
 * can flip in /god-mode), and apps/admin sets the same route title on all four branches of its home
 * page, so `toHaveTitle(/Admin/)` also passes when the instance fetch FAILS — only the
 * "Manage your Plane instance" assertion proves the healthy sign-in branch. A red here is as likely
 * to be instance state as an app regression.
 *
 * Measured the same day in a real browser on Chromium AND WebKit before any of this was asserted:
 * both routes render, no uncaught errors, no error boundary. /spaces does log a minified React #418
 * (a hydration mismatch — it is server-rendered by react-router-serve) and on WebKit that does NOT
 * become a `pageerror`, so these pass; APLANE-48 tracks the mismatch itself.
 */
import { expect, test } from "./helpers";

test.describe("god-mode shell (L5-80)", () => {
  test.use({ unauthenticated: true });

  test("renders the instance admin sign-in rather than an empty shell", async ({ page }) => {
    await page.goto("/god-mode/");
    await page.waitForLoadState("networkidle");

    // Measured title: "Admin – Instance Setup & Sign-In". Asserted loosely on "Admin" so a copy
    // change does not fail the suite, but asserted at all because the web app's title is different
    // and serving web's index.html here is precisely the half-copied-bundle failure mode.
    await expect(page).toHaveTitle(/Admin/);
    await expect(page.getByText(/Manage your Plane instance/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sign in$/ })).toBeVisible();
    await expect(page).toHaveURL(/\/god-mode\//);
  });
});

test.describe("spaces shell (L5-81)", () => {
  test.use({ unauthenticated: true });

  test("renders Plane Publish's sign-in rather than an empty shell", async ({ page }) => {
    await page.goto("/spaces/");
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveTitle(/Plane Publish/);
    await expect(page.getByText(/Sign up or log in to work with Plane/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Continue$/ })).toBeVisible();
  });

  test("offers Pocket ID, not Gitea (B-32 was applied to apps/web only)", async ({ page }) => {
    // The bug these tests found. The "gitea" OAuth slot is repurposed to Pocket ID OIDC and
    // apps/web was relabelled when that happened; apps/space was missed, so a published board
    // asked visitors to "Sign up with Gitea" for a provider that is not Gitea. Measured in a real
    // browser on dev 2026-11-10 — the button read "Sign up with Gitea" — then fixed in
    // apps/space/hooks/oauth/core.tsx. Same shape as the web assertion in shell.spec.ts, which is
    // what should have caught this and could not, because nothing opened this app.
    await page.goto("/spaces/");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /with Pocket ID/ })).toBeVisible();
    // Accessible name, not text: the bug had TWO halves, the label and `<img alt="Gitea Logo">`,
    // and `getByText` reads text nodes only — so a revert of the icon alone would have kept this
    // green while a visitor still saw the Gitea logo. The role matcher folds `alt` into the name.
    await expect(page.getByRole("button", { name: /Gitea/i })).toHaveCount(0);
    await expect(page.getByText(/with Gitea/)).toHaveCount(0);
  });
});
