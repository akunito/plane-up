// PHASE 0 SPIKE (APLANE-58). Second build of apps/web: the standalone shopping app, into build/client/shopping/.
// It must run AFTER `react-router build`, which empties build/ first (cleanBuildDirectory, @react-router/dev 7.17.0).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { workerSource } from "./vite.shopping.worker";

const root = path.resolve(__dirname, "../../packages/shopping-app");
const base = "/shopping/";

// Emits sw.js with the list of every file this build wrote. A worker that guesses file names cannot
// precache hashed assets, and one that caches on first use has nothing on the first offline launch.
function serviceWorker(): Plugin {
  return {
    name: "shopping-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle);
      const dir = path.join(root, "public");
      for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
        if (f.isFile()) files.push(path.relative(dir, path.join(f.parentPath, f.name)).split(path.sep).join("/"));
      const html = bundle["index.html"];
      const shell =
        html && html.type === "asset" ? String(html.source) : readFileSync(path.join(root, "index.html"), "utf8");
      const built = workerSource(readFileSync(path.join(root, "src/sw.template.js"), "utf8"), base, files, shell);
      this.emitFile({ type: "asset", fileName: "sw.js", source: built.source });
      this.info(`sw.js ${built.version}: ${built.assets.length} precached, shell from ${html ? "bundle" : "source"}`);
    },
  };
}

export default defineConfig({
  root,
  base,
  publicDir: path.join(root, "public"),
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  plugins: [serviceWorker()],
  build: {
    outDir: path.resolve(__dirname, "build/client/shopping"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
