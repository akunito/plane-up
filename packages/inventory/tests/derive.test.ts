// The to-buy rule against the fixture the API tests read too (apps/api/plane/tests/unit/inventory/test_derive.py).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { counts, toBuy } from "../src/derive";
import type { DeriveInput } from "../src/derive";

const FIXTURE = fileURLToPath(
  new URL("../../../apps/api/plane/tests/fixtures/inventory/derivation.json", import.meta.url)
);
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  cases: (DeriveInput & { name: string; to_buy: number })[];
};

describe("toBuy, shared fixture", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(10));
  for (const c of cases) it(c.name, () => expect(toBuy(c)).toBe(c.to_buy));
});

it("pinned rows never count", () => {
  expect(counts("pinned")).toBe(false);
  expect(["on_demand", "level", "units"].every((m) => counts(m as DeriveInput["mode"]))).toBe(true);
});
