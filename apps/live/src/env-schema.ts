/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";

/**
 * The live server's environment contract.
 *
 * Its own module so it can be tested: `env.ts` runs `validateEnv()` at import time and calls
 * `process.exit(1)` when this rejects, so importing that file from a test would kill the test
 * process. It was the only file in apps/live with no coverage and a failure mode of "the server
 * does not start" (APLANE-30).
 *
 * Three things here are sensitive to a zod version and are pinned by tests/env-schema.test.ts:
 *
 * - `.string().default("x").transform(Number)` — the ORDER matters. zod 4's `.default()` returns
 *   the default without running the inner schema, so this works only because the default sits
 *   inside the chain and the transform still sees the string. `.transform(Number).default(6)`
 *   would behave differently across the majors.
 * - `.url()` with a plain message argument takes a fast path straight to the WHATWG URL parser, so
 *   a dotless docker service name like `http://plane-api:8000` is accepted. Passing an OPTIONS
 *   object instead (`{error, protocol}` or `normalize: true`) leaves that path and adds a hostname
 *   regex, which would reject our own API_BASE_URL and crash-loop the container at boot.
 * - `.transform(Number)` does NOT validate, so a non-numeric COMPRESSION_LEVEL becomes NaN and
 *   passes. Pre-existing on both majors; asserted in the test so it stays a known wart.
 */
export const envSchema = z.object({
  APP_VERSION: z.string().default("1.0.0"),
  HOSTNAME: z.string().optional(),
  PORT: z.string().default("3000"),
  API_BASE_URL: z.string().url("API_BASE_URL must be a valid URL"),
  // CORS configuration
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  // Live running location
  LIVE_BASE_PATH: z.string().default("/live"),
  // Compression options
  COMPRESSION_LEVEL: z.string().default("6").transform(Number),
  COMPRESSION_THRESHOLD: z.string().default("5000").transform(Number),
  // secret
  LIVE_SERVER_SECRET_KEY: z.string(),
  // Redis configuration
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().default("6379").transform(Number),
  REDIS_URL: z.string().optional(),
});
