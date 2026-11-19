import { describe, expect, it } from "vitest";
import { workerSource } from "../../../apps/web/vite.shopping.worker";

const TEMPLATE = 'const VERSION = "__SW_VERSION__"; const ASSETS = "__SW_ASSETS__"; const SCOPE = "__SW_SCOPE__";';

describe("workerSource", () => {
  it("precaches the scope URL and every emitted file, never itself, a map or index.html", () => {
    const r = workerSource(
      TEMPLATE,
      "/shopping/",
      ["assets/b.js", "sw.js", "index.html", "assets/a.css", "assets/b.js.map"],
      "<html>"
    );
    expect(r.assets).toEqual(["/shopping/", "/shopping/assets/a.css", "/shopping/assets/b.js"]);
    expect(r.source).toContain('const ASSETS = ["/shopping/","/shopping/assets/a.css","/shopping/assets/b.js"]');
    expect(r.source).toContain('const SCOPE = "/shopping/"');
    expect(r.source).not.toContain("__SW_");
  });

  it("changes the version when only the shell changes", () => {
    const a = workerSource(TEMPLATE, "/shopping/", ["assets/a.js"], "<html>one");
    const b = workerSource(TEMPLATE, "/shopping/", ["assets/a.js"], "<html>two");
    const c = workerSource(TEMPLATE, "/shopping/", ["assets/a.js"], "<html>one");
    expect(a.version).not.toBe(b.version);
    expect(a.version).toBe(c.version);
  });

  it("does not depend on the order the bundler lists files in", () => {
    const a = workerSource(TEMPLATE, "/shopping/", ["x.js", "a.css"], "s");
    const b = workerSource(TEMPLATE, "/shopping/", ["a.css", "x.js", "x.js"], "s");
    expect(a.source).toBe(b.source);
  });

  it("refuses a template that lost a placeholder", () => {
    expect(() => workerSource("const VERSION = 1;", "/shopping/", [], "s")).toThrow(/placeholder/);
  });
});
