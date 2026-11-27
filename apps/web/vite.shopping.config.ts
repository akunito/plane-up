// Second build of apps/web: the standalone shopping app (packages/shopping-app), into build/client/shopping/.
// It must run AFTER `react-router build`, which empties build/ first (cleanBuildDirectory, @react-router/dev
// 7.17.0). Served by the existing static server at /shopping/ (M1: /shopping answers 308 to /shopping/;
// a missing file under it answered 200 with the main app's HTML — still so outside /shopping/assets/, which
// is a 404 since APLANE-83 — so checks test content types).
// Any helper this imports must live in apps/web, never under a build/ directory (M1: TS6307, .gitignore).
import path from "node:path";
import { defineConfig } from "vite";

const root = path.resolve(__dirname, "../../packages/shopping-app");

export default defineConfig({
  root,
  base: "/shopping/",
  publicDir: path.join(root, "public"),
  build: {
    outDir: path.resolve(__dirname, "build/client/shopping"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
