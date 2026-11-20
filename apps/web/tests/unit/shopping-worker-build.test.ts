/**
 * APLANE-64 (inventory phase 6): the shopping app worker's precache list and version, from the files the
 * app's build wrote (vite.shopping.worker.ts).
 */
import { describe, expect, it } from "vitest";
import { precacheList } from "../../vite.shopping.worker";

describe("precacheList (the build)", () => {
  it("precaches the scope URL and every emitted file, never itself, a map or index.html", () => {
    const r = precacheList(
      "/shopping/",
      ["assets/b.js", "sw.js", "index.html", "assets/a.css", "assets/b.js.map"],
      "<html>"
    );
    expect(r.assets).toEqual(["/shopping/", "/shopping/assets/a.css", "/shopping/assets/b.js"]);
  });

  it("changes the version when only the shell changes, not with the order of files", () => {
    const a = precacheList("/shopping/", ["a.js", "b.css"], "one");
    expect(precacheList("/shopping/", ["a.js", "b.css"], "two").version).not.toBe(a.version);
    expect(precacheList("/shopping/", ["b.css", "a.js", "a.js"], "one").version).toBe(a.version);
  });
});
