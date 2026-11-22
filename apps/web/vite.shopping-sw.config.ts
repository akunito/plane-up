// Third build step of apps/web: the shopping app's service worker, into build/client/shopping/sw.js. Runs
// AFTER the app's build (vite.shopping.config.ts), whose output gives the precache list and the version.
// One classic script with its dependencies inlined: the queue code it shares with the app is bundled in,
// so the worker never imports an app chunk that a newer version may already have replaced.
import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { precacheFromBuild } from "./vite.shopping.worker";

const root = path.resolve(__dirname, "../../packages/shopping-app");
const outDir = path.resolve(__dirname, "build/client/shopping");

export default defineConfig((): UserConfig => {
  const { version, assets } = precacheFromBuild(outDir, "/shopping/", [
    path.join(root, "src"),
    path.resolve(__dirname, "../../packages/inventory/src"),
  ]);
  return {
    root,
    publicDir: false,
    define: { __SW_VERSION__: JSON.stringify(version), __SW_ASSETS__: JSON.stringify(assets) },
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      copyPublicDir: false,
      lib: {
        entry: path.join(root, "src/sw.ts"),
        formats: ["iife"],
        name: "planeShoppingWorker",
        fileName: () => "sw.js",
      },
    },
  };
});
