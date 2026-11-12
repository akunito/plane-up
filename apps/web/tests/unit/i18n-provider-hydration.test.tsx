/**
 * L1-27 — the i18n provider's FIRST render must be identical on the server and in the browser
 * (APLANE-48).
 *
 * `TranslationProvider` returns null until i18next has initialised. Seeding that state from
 * `i18nInstance.isInitialized` made the two sides disagree: apps/space is server-rendered
 * (`ssr: true`, the only one of the three apps) and its server is a long-running node process whose
 * `initPromise` resolved at startup, so the flag is TRUE there and the whole subtree was rendered.
 * A fresh browser is the opposite — measured 2026-11-12 on dev, `entry.client` finishes at 49 ms
 * and the chunks for the first two namespaces are not even requested until 176 ms, while
 * `entry.client.tsx` calls `hydrateRoot` immediately. So the client's first pass returned null where
 * the server had emitted markup: ~20 × React #418 and then #423, "the entire root will switch to
 * client rendering", on every anonymous load of /spaces/.
 *
 * **The ORDER of the two steps below is the whole test.** A server render on its own proves nothing
 * here: in a fresh module `isInitialized` is false anyway, so the assertion would pass against the
 * broken code too. NOTE that the subject here is `packages/i18n/dist`, not its src: the package
 * exports only `./dist/index.js`, so a bare `pnpm --filter web test` can go green against a stale
 * build in either direction — rebuild i18n first, or run it through `turbo test`, whose
 * `dependsOn: ["^build"]` guarantees it.
 *
 * Rendering on the client FIRST and waiting for the children drives the real
 * `initPromise` to resolve, and `i18nInstance` is a module-level singleton — so by the time the
 * server render runs, the flag is genuinely true and the assertion can only hold if the initial
 * state no longer reads it. Verified by watching it fail: against a `@plane/i18n` dist built before
 * the fix, step 2 returns `<p>child</p>` instead of "".
 */
import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "@plane/i18n";

describe("i18n provider hydration contract (L1-27)", () => {
  it("renders its children on the client once i18n is ready", async () => {
    // The control that keeps the real assertion honest: a provider that never rendered anything
    // would satisfy step 2 trivially.
    render(
      <TranslationProvider>
        <p>child</p>
      </TranslationProvider>
    );

    await waitFor(() => expect(screen.getByText("child")).toBeTruthy());
  });

  it("still emits NOTHING from a server render after i18n has finished initialising", async () => {
    render(
      <TranslationProvider>
        <p>child</p>
      </TranslationProvider>
    );
    await waitFor(() => expect(screen.getByText("child")).toBeTruthy());

    // i18nInstance.isInitialized is now true for the whole module. The server must still render
    // nothing, because the browser's first pass cannot do anything else.
    expect(
      renderToString(
        <TranslationProvider>
          <p>child</p>
        </TranslationProvider>
      )
    ).toBe("");
  });
});
