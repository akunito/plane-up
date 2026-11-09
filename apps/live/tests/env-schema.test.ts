/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * The live server's environment contract (APLANE-30).
 *
 * This schema is the only thing in apps/live whose failure mode is "the server does not start":
 * `env.ts`'s `validateEnv()` calls `process.exit(1)` when it rejects. It had no coverage at all, and
 * the schema leans on three zod behaviours that a dependency bump can move underneath it — which
 * is exactly what the zod 3 -> 4 bump made worth pinning. Measured against zod 3.25.76 and 4.6.7:
 * every assertion below holds on both, so this is a contract test and not a zod-4 snapshot.
 *
 * The one thing that DID change between the majors is covered deliberately at the end.
 */

import { describe, expect, it } from "vitest";

import { envSchema } from "@/env-schema";

const MINIMUM = {
  API_BASE_URL: "https://plane.example.com",
  LIVE_SERVER_SECRET_KEY: "secret",
};

describe("the live server's env schema", () => {
  it("accepts the minimum real environment and applies every default", () => {
    const result = envSchema.safeParse(MINIMUM);
    if (!result.success) throw new Error(`the minimum env must parse: ${JSON.stringify(result.error.issues)}`);

    expect(result.data).toMatchObject({
      APP_VERSION: "1.0.0",
      PORT: "3000",
      CORS_ALLOWED_ORIGINS: "",
      LIVE_BASE_PATH: "/live",
      COMPRESSION_LEVEL: 6,
      COMPRESSION_THRESHOLD: 5000,
      REDIS_PORT: 6379,
    });
  });

  it("keeps PORT a string and the three numeric settings numbers", () => {
    const result = envSchema.safeParse(MINIMUM);
    if (!result.success) throw new Error("fixture must parse");

    // `server.ts` does `env.PORT || 3000` and `redis.ts` passes REDIS_PORT straight to the client,
    // so the TYPES matter as much as the values.
    expect(typeof result.data.PORT).toBe("string");
    expect(typeof result.data.COMPRESSION_LEVEL).toBe("number");
    expect(typeof result.data.COMPRESSION_THRESHOLD).toBe("number");
    expect(typeof result.data.REDIS_PORT).toBe("number");
  });

  it("runs the transform on a defaulted value, not around it", () => {
    // The ordering is load-bearing and zod 4 is the reason to say so: `.default()` there returns
    // the default WITHOUT running the inner schema. It is harmless here only because the chain is
    // `z.string().default("6").transform(Number)` — the default sits inside, so the transform still
    // sees "6". Written as `.transform(Number).default(6)` the majors would disagree.
    const defaulted = envSchema.safeParse(MINIMUM);
    const explicit = envSchema.safeParse({ ...MINIMUM, COMPRESSION_LEVEL: "9" });
    if (!defaulted.success || !explicit.success) throw new Error("fixtures must parse");

    expect(defaulted.data.COMPRESSION_LEVEL).toBe(6);
    expect(explicit.data.COMPRESSION_LEVEL).toBe(9);
  });

  it("rejects a missing secret and a malformed API_BASE_URL, and nothing else", () => {
    expect(envSchema.safeParse({ API_BASE_URL: "https://x.example" }).success).toBe(false);

    const bad = envSchema.safeParse({ ...MINIMUM, API_BASE_URL: "not-a-url" });
    if (bad.success) throw new Error("a malformed URL must be rejected");
    expect(bad.error.issues.map((i) => i.path.join("."))).toEqual(["API_BASE_URL"]);
  });

  it("accepts the hostnames this deployment actually uses", () => {
    // The regression this guards is a crash-loop, not a wrong value: API_BASE_URL is a docker
    // service name with no dot and no TLD. zod's url() takes a fast path straight to the WHATWG
    // URL parser as long as no `hostname`/`protocol`/`normalize` option is passed — and the only
    // argument env.ts gives it is a message string. Add an options object there and these break.
    for (const url of ["http://plane-api:8000", "http://localhost:3000", "http://api:8000"]) {
      expect(envSchema.safeParse({ ...MINIMUM, API_BASE_URL: url }).success).toBe(true);
    }
  });

  it("strips whitespace and control characters from API_BASE_URL", () => {
    // The one real behaviour change across the bump, and an improvement: zod 3's url() was a pure
    // refinement that returned the string untouched, so a stray newline in the environment rode
    // into every axios base URL. zod 4 rewrites the parsed value. Pinned so a later zod that drops
    // the rewrite is a test failure rather than a mystery.
    const result = envSchema.safeParse({ ...MINIMUM, API_BASE_URL: "  https://plane.example.com\n" });
    if (!result.success) throw new Error("a URL with surrounding whitespace must still parse");

    expect(result.data.API_BASE_URL).toBe("https://plane.example.com");
  });

  it("does NOT reject a non-numeric numeric setting — it yields NaN", () => {
    // Documented, not desired, and identical on zod 3 and 4: `.transform(Number)` does not
    // validate, so COMPRESSION_LEVEL="abc" passes validation as NaN and reaches the compression
    // middleware. Pre-existing and out of scope for a dependency bump; asserted so it is a known
    // wart rather than a surprise, and so that fixing it has to come here and change this test.
    const result = envSchema.safeParse({ ...MINIMUM, COMPRESSION_LEVEL: "abc" });
    if (!result.success) throw new Error("fixture parses today — if it stops, the wart was fixed");

    expect(Number.isNaN(result.data.COMPRESSION_LEVEL)).toBe(true);
  });
});
