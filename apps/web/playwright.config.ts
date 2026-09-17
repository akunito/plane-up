/**
 * E2E suite for the fork (APLANE-12, catalog L5). Runs against a deployed dev instance
 * seeded by plane-tests (`qa` workspace), never against a local dev server.
 *
 * Env (set by plane-tests' e2e runner):
 *   PT_BASE_URL       e.g. https://plane-dev.local.akunito.com
 *   PT_QA_PASSWORD    password of the qa-* users
 *   PT_MANIFEST       path to qa-manifest.json (ids of everything seeded)
 *   PLAYWRIGHT_BROWSERS_PATH  nixpkgs playwright-driver.browsers (same version as @playwright/test)
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PT_BASE_URL ?? "https://plane-dev.local.akunito.com";

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: ["**/.explore/**"], // throwaway DOM probes, never part of the suite
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // one worker: several specs change the same QA user's state (pins, preferences) on every device
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "Europe/Madrid",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      dependencies: ["setup"],
    },
    { name: "android", use: { ...devices["Pixel 7"] }, dependencies: ["setup"] },
    { name: "iphone", use: { ...devices["iPhone 14"] }, dependencies: ["setup"] },
  ],
});
