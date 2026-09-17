/** L5-01 login page · L5-02 route crawl as a signed-in QA admin. */
import { authFile, expect, manifest, test } from "./helpers";

const QAA = manifest.workspaces.qa.projects.QAA;

test.describe("login page (L5-01)", () => {
  test("offers Sign in with Pocket ID and sends the browser to Pocket ID", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("button", { name: /Sign in with Pocket ID/ });
    await expect(button).toBeVisible();
    await expect(page.getByText(/with Gitea/)).toHaveCount(0);
    // Intercept Plane's own /auth/gitea/ navigation, perform it without following the redirect,
    // and read where it sends the browser. Redirects are not re-routable in Chromium, and Pocket ID
    // itself is not under test, so the browser never loads it.
    let authorizeUrl = "";
    await page.route(/\/auth\/gitea\/(\?.*)?$/, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      authorizeUrl = response.headers()["location"] ?? `status ${response.status()}`;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" });
    });
    await button.click();
    await expect.poll(() => authorizeUrl).toMatch(/^https:\/\/auth\.akunito\.com\/authorize\?/);
    const params = new URL(authorizeUrl).searchParams;
    const base = process.env.PT_BASE_URL ?? "https://plane-dev.local.akunito.com";
    expect(params.get("redirect_uri")).toBe(`${base}/auth/gitea/callback/`);
    expect(params.get("client_id")).toBeTruthy();
    await page.goto("about:blank");
  });
});

test.describe("route crawl (L5-02)", () => {
  test.use({ storageState: authFile("qa-alice") });
  const routes = [
    "/qa/",
    "/qa/projects/",
    `/qa/projects/${QAA.id}/issues/`,
    `/qa/projects/${QAA.id}/cycles/`,
    `/qa/projects/${QAA.id}/cycles/${QAA.cycle}/`,
    `/qa/projects/${QAA.id}/modules/`,
    `/qa/projects/${QAA.id}/modules/${QAA.module}/`,
    `/qa/projects/${QAA.id}/views/`,
    `/qa/projects/${QAA.id}/views/${QAA.views!.kanban}/`,
    `/qa/projects/${QAA.id}/pages/${QAA.pages!["QA page to pin"]}/`,
    "/qa/browse/QAA-1/",
    "/qa/workspace-views/",
    "/qa/workspace-views/all-issues/",
    `/qa/workspace-views/${manifest.workspaces.qa.views["QA Board"]}/`,
    "/qa/analytics/overview/",
    "/qa/projects/archives/",
    "/qa/notifications/",
    "/qa/drafts/",
    `/qa/profile/${manifest.users.alice.id}/`,
  ];
  for (const route of routes) {
    test(route.replace(/[0-9a-f-]{36}/g, ":id"), async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page).not.toHaveURL(/\/sign-in|\/login|\/accounts/);
    });
  }
});
