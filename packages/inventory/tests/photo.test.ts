// Item photos (APLANE-66): the shrink before upload, and the three-step upload.
/* oxlint-disable no-await-in-loop -- cases run one after another, each with its own recorder */

import { describe, expect, it } from "vitest";

import { PHOTO_MAX_SIDE, fitSize, photoUrl, removePhoto, shrinkPhoto, uploadPhoto } from "../src/photo";
import type { Decoded, ImageEnv } from "../src/photo";

describe("fitSize", () => {
  it("keeps a photo that already fits and scales the longest side down to the maximum", () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(4000, 3000)).toEqual({ width: PHOTO_MAX_SIDE, height: 1200 });
    expect(fitSize(3000, 4000)).toEqual({ width: 1200, height: PHOTO_MAX_SIDE });
    expect(fitSize(100000, 10)).toEqual({ width: PHOTO_MAX_SIDE, height: 1 });
  });
});

function fakeEnv(sizes: number[], image = { width: 4032, height: 3024 }) {
  const calls: { width: number; height: number; quality: number }[] = [];
  let closed = 0;
  const env: ImageEnv<Decoded> = {
    decode: async () => ({ ...image, close: () => void closed++ }),
    encode: async (_img, width, height, quality) => {
      calls.push({ width, height, quality });
      return new Blob([new Uint8Array(sizes[calls.length - 1] ?? 0)], { type: "image/jpeg" });
    },
  };
  return { env, calls, closed: () => closed };
}

describe("shrinkPhoto", () => {
  it("re-encodes at the fitted size and stops at the first quality under the limit", async () => {
    const { env, calls, closed } = fakeEnv([900, 500]);
    const out = await shrinkPhoto(new Blob(["x"]), env, 600);
    expect(out?.size).toBe(500);
    expect(calls.map((c) => c.quality)).toEqual([0.82, 0.7]);
    expect(calls[0]).toMatchObject({ width: 1600, height: 1200 });
    expect(closed()).toBe(1);
  });

  it("answers null when no quality fits, and still releases the decoded image", async () => {
    const { env, closed } = fakeEnv([900, 900, 900, 900]);
    expect(await shrinkPhoto(new Blob(["x"]), env, 600)).toBeNull();
    expect(closed()).toBe(1);
  });

  it("never answers an empty blob", async () => {
    const { env } = fakeEnv([0, 0, 0, 0]);
    expect(await shrinkPhoto(new Blob(["x"]), env, 600)).toBeNull();
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(answers: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next as Response;
  }) as unknown as typeof fetch;
  return { seen, opts: { base: "", slug: "home", fetchImpl } };
}

const PHOTO = new Blob([new Uint8Array(2048)], { type: "image/jpeg" });
const BASE = "/api/workspaces/home/projects/p1/inventory/items/i1/photo/";

describe("uploadPhoto", () => {
  it("starts, sends the bytes to storage with the fields first and no cookies, then confirms", async () => {
    const { seen, opts } = recorder([
      json(200, { asset_id: "a1", upload_data: { url: "https://storage.test/b", fields: { key: "k", policy: "p" } } }),
      new Response(null, { status: 204 }),
      json(200, { id: "i1", photo: "a1" }),
    ]);
    const out = await uploadPhoto<{ photo: string }>(opts, "p1", "i1", PHOTO);
    expect(out).toMatchObject({ kind: "ok", body: { photo: "a1" } });
    expect(seen.map((s) => [s.init.method, s.url])).toEqual([
      ["POST", BASE],
      ["POST", "https://storage.test/b"],
      ["PATCH", `${BASE}a1/`],
    ]);
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ type: "image/jpeg", size: 2048 });
    expect(seen[1].init.credentials).toBe("omit");
    const form = seen[1].init.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
  });

  it("passes the server's refusal through and touches nothing else", async () => {
    const { seen, opts } = recorder([json(400, { error: "too_large", field: "size", limit: 1000 })]);
    const out = await uploadPhoto(opts, "p1", "i1", PHOTO);
    expect(out).toEqual({ kind: "refused", status: 400, error: "too_large" });
    expect(seen).toHaveLength(1);
  });

  it("is a failure, never a confirmation, when storage refuses or the network drops", async () => {
    const started = () => json(200, { asset_id: "a1", upload_data: { url: "https://storage.test/b", fields: {} } });
    for (const [answer, failure, status] of [
      [new Response("<Error/>", { status: 403 }), "server", 403],
      [new TypeError("network"), "offline", 0],
    ] as const) {
      const { seen, opts } = recorder([started(), answer]);
      expect(await uploadPhoto(opts, "p1", "i1", PHOTO)).toEqual({ kind: "failed", failure, status });
      expect(seen.filter((s) => s.init.method === "PATCH")).toHaveLength(0);
    }
  });
});

describe("photoUrl and removePhoto", () => {
  it("point at the item's photo", async () => {
    expect(photoUrl({ base: "", slug: "home" }, "p1", "i1", "a1")).toBe(`${BASE}a1/`);
    const { seen, opts } = recorder([json(200, { id: "i1", photo: null })]);
    expect(await removePhoto(opts, "p1", "i1")).toMatchObject({ kind: "ok", body: { photo: null } });
    expect([seen[0].init.method, seen[0].url]).toEqual(["DELETE", BASE]);
  });
});
