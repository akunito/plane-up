/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { z } from "zod";

export type TValidationError = {
  path: string;
  message: string;
};

/**
 * Flatten a `ZodError` into the `{path, message}` list the 400 responses return (APLANE-30).
 *
 * Its own module, rather than three lines inline in the controller, for one reason: the controller
 * imports `@plane/decorators`, `@plane/logger` and express, so a test of it only runs once those
 * workspace packages have been built. This has no dependency but zod, so the contract below is
 * pinned by a test that runs anywhere — and that contract is exactly what broke.
 *
 * **Read `.issues`, never `.errors`.** Both exist on zod 3's `ZodError` (`.errors` is an alias),
 * and zod 4 removed `.errors` entirely: `error.errors.map(...)` throws a TypeError INSIDE the catch
 * block that handles validation failures, which turns a clean 400 into a crash on the error path —
 * the worst place for one, because it only fires once a client has already sent something invalid.
 * Measured against zod 3.25.76 and 4.6.6: `.issues` is present on both and yields the same shape.
 *
 * The message TEXT does differ between the majors (zod 3 "Required" vs zod 4 "Invalid input:
 * expected string, received undefined"). Nothing branches on it — it is forwarded to the client and
 * to the log — so it is a visible change in the 400 body, not a behavioural one.
 */
export const zodIssuesToValidationErrors = (error: z.ZodError): TValidationError[] =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
