/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * The 400 path of the live server's convert-document endpoint (APLANE-30).
 *
 * This exists because of a real break found while preparing the zod 3 -> 4 bump: the controller read
 * `error.errors`, which zod 4 removed, so `error.errors.map(...)` would have thrown a TypeError
 * inside the catch block that handles validation failures. `apps/live` is in NO gate stage — L0
 * builds and typechecks only `web`, L1 runs only `apps/web`'s tests, L2 is the Python suite — so
 * nothing would have said a word.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodIssuesToValidationErrors } from "@/lib/zod-validation-errors";

const schema = z.object({
  description_html: z.string(),
  variant: z.enum(["rich", "document"]),
});

const errorFrom = (body: unknown): z.ZodError => {
  const result = schema.safeParse(body);
  if (result.success) throw new Error("the fixture must fail validation, or this test proves nothing");
  return result.error;
};

describe("zodIssuesToValidationErrors", () => {
  it("flattens every issue to a dotted path and a message", () => {
    const errors = zodIssuesToValidationErrors(errorFrom({}));

    // A Set, not `.sort()`: order is irrelevant here, `.sort()` mutates (oxlint says so), and
    // `.toSorted()` is ES2023 — outside this app's lib, which has caught a change out before.
    expect(new Set(errors.map((e) => e.path))).toEqual(new Set(["description_html", "variant"]));
    for (const e of errors) expect(e.message).toBeTruthy();
  });

  it("reads .issues and not .errors, which zod 4 removed", () => {
    const error = errorFrom({});

    // The guard: on zod 4 this property is gone, so a helper that read it would throw here rather
    // than return a list. Asserting on the helper's OUTPUT is what makes that a failure instead of
    // a silent change.
    expect(() => zodIssuesToValidationErrors(error)).not.toThrow();
    expect(zodIssuesToValidationErrors(error).length).toBe(error.issues.length);
  });

  it("joins a nested path with dots", () => {
    const nested = z.object({ outer: z.object({ inner: z.string() }) });
    const result = nested.safeParse({ outer: {} });
    if (result.success) throw new Error("fixture must fail");

    expect(zodIssuesToValidationErrors(result.error)[0].path).toBe("outer.inner");
  });

  it("returns an empty list for an error with no issues rather than throwing", () => {
    expect(zodIssuesToValidationErrors({ issues: [] } as unknown as z.ZodError)).toEqual([]);
  });
});
