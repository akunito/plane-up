/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import path from "path";
import { defineConfig } from "vitest/config";

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
    // Mirrors tsconfig.json's "@/*" -> "./src/core/*".
    alias: { "@": path.resolve(__dirname, "./src/core") },
  },
});
