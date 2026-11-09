/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import path from "path";
import { defineConfig } from "vitest/config";

const at = (p: string) => `${path.resolve(__dirname, p)}/`;

export default defineConfig({
  test: {
    // `node`, not jsdom: `@tiptap/html`'s generateHTML serialises through zeed-dom, a DOM-less
    // implementation, so the extensions' renderHTML can be exercised without a browser. That is the
    // whole reason this package can have tests at all (APLANE-30).
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    // All FOUR of tsconfig.json's paths, as an ordered array because the order is load-bearing:
    // a bare `@/` alias listed first would swallow `@/plane-editor/...` and `@/styles/...` and
    // resolve them under src/core. Missing the `@/plane-editor` arm is not a subtle failure but it
    // is a misleading one — `unique-id/extension.ts` then dies with "Cannot find package
    // '@/plane-editor/constants/extensions'", which reads like an uninstalled dependency rather
    // than an unmapped alias, and every extension importing from src/ce looks untestable.
    alias: [
      { find: /^@\/plane-editor\//, replacement: at("./src/ce") },
      { find: /^@\/styles\//, replacement: at("./src/styles") },
      { find: /^@\//, replacement: at("./src/core") },
      { find: /^src\//, replacement: at("./src") },
    ],
  },
});
