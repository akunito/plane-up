import { describe, expect, it } from "vitest";
import { isDevHost } from "../src/dev";
import shopDev from "../public/manifest.dev.json";
import shop from "../public/manifest.json";
import webDev from "../../../apps/web/public/manifest.dev.json";
import web from "../../../apps/web/public/manifest.json";
import siteDev from "../../../apps/web/public/site.webmanifest.dev.json";
import site from "../../../apps/web/public/site.webmanifest.json";

// APLANE-76: Caddy serves the *.dev.json manifests on plane-dev.*; they must stay the prod files with the name changed.
type M = Record<string, unknown>;
const PAIRS: [string, M, M, string][] = [
  ["shopping manifest.json", shop, shopDev, "Shopping-dev"],
  ["web manifest.json", web, webDev, "Plane-dev"],
  ["web site.webmanifest.json", site, siteDev, "Plane-dev"],
];

describe("APLANE-76: dev is told apart at runtime", () => {
  it("only plane-dev.* is dev", () => {
    expect(isDevHost("plane-dev.local.akunito.com")).toBe(true);
    expect(isDevHost("plane.akunito.com")).toBe(false);
    expect(isDevHost("plane.local.akunito.com")).toBe(false);
    expect(isDevHost("localhost")).toBe(false);
    expect(isDevHost("my-plane-dev.example.com")).toBe(false);
  });

  it.each(PAIRS)("%s and its dev copy differ only in the name", (_label, p, d, name) => {
    expect(d.name).toBe(name);
    expect(d.short_name).toBe(name);
    expect({ ...d, name: p.name, short_name: p.short_name }).toEqual(p);
  });
});
