/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { i18nInstance, initPromise } from "../core";

interface TranslationProviderProps {
  children: React.ReactNode;
}

export const TranslationProvider: React.FC<TranslationProviderProps> = ({ children }) => {
  // `false`, NOT `i18nInstance.isInitialized` — the first render has to be identical on the server
  // and in the browser, and that flag is not (APLANE-48).
  //
  // apps/space is server-rendered (`ssr: true`, the only one of the three apps). Its server is a
  // long-running node process whose `initPromise` resolved at startup, so `isInitialized` is TRUE
  // there and this provider rendered the whole subtree. A fresh browser is the opposite: measured
  // 2026-11-12 on dev, `entry.client` finishes at 49 ms and the chunks for the first two namespaces
  // (`accessibility`, `auth`) are not even REQUESTED until 176 ms, while `entry.client.tsx` calls
  // `hydrateRoot` immediately. So the client's first pass returned null where the server had
  // emitted markup — a structural mismatch, logged as ~20 × React #418 followed by #423, "the
  // entire root will switch to client rendering", on every anonymous load of /spaces/.
  //
  // Seeding from the flag can only ever be right by luck, and that is the load-bearing argument
  // rather than the timings above: `entry.client.tsx` wraps `hydrateRoot` in `startTransition`, so
  // the hydration render is schedulable rather than synchronous with module evaluation. The old
  // seed was a RACE, and 49 ms/176 ms only records which side of it dev happened to land on.
  //
  // For apps/web and apps/admin this changes nothing, but NOT for the reason it is tempting to give.
  // `ssr: false` does not mean "no server render": react-router's SPA mode still renders once at
  // BUILD time (`handleSpaMode` issues a request with `X-React-Router-SPA-Mode: yes` and writes the
  // result to index.html), and that render wraps the root route's `Layout` around its
  // `HydrateFallback`. The real reasons are narrower — apps/web mounts this provider in
  // `app/provider.tsx`, which `Root()` renders BELOW that boundary, so it is not in the build-time
  // render at all; and apps/admin never mounts it (a repo-wide grep for TranslationProvider finds
  // only space, web and the test). Restructure either app to put its providers inside `Layout`, the
  // way apps/admin already does, and the build-time render WOULD reach this line.
  //
  // Rejected alternative, recorded so it is not re-derived: `await initPromise` in space's
  // `entry.client.tsx` before `hydrateRoot`, keeping the seed. That also removes the mismatch and
  // would PRESERVE server-rendered content — the right fix if space ever gains any. Today it has
  // none (its subtree is gated on an instance fetch SSR never performs) and the cost is ~130 ms of
  // delayed hydration on every load, so it is not worth it yet.
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    initPromise
      .then(() => setIsReady(true))
      .catch((err) => {
        console.error("Failed to initialize i18n:", err);
        setIsReady(true);
      });
  }, []);

  if (!isReady) return null;
  return <I18nextProvider i18n={i18nInstance}>{children}</I18nextProvider>;
};
