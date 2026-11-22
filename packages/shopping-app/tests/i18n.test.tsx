// Every locale has every key, every placeholder of English, and no screen shows a raw key in any of
// the three languages (plan, phase 4 tests).

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createQueue, makeLock, newUuid } from "@plane/inventory";
import { App } from "../src/app";
import { Controller } from "../src/controller";
import { DICTIONARIES, ago, pickLocale } from "../src/i18n";
import type { Locale } from "../src/i18n";
import { memoryStore } from "../src/store";
import { BABY, FakeApi, GROCERIES, SUPPLEMENTS, state, uid } from "./fake-api";

const LOCALES: Locale[] = ["en", "es", "pl"];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).toSorted();

afterEach(() => cleanup());

describe("dictionaries", () => {
  it("have the same keys and the same placeholders as English", () => {
    const keys = Object.keys(DICTIONARIES.en).toSorted();
    for (const l of LOCALES) {
      expect(Object.keys(DICTIONARIES[l]).toSorted(), l).toEqual(keys);
      for (const k of keys)
        expect(placeholders(DICTIONARIES[l][k as keyof typeof DICTIONARIES.en]), `${l}.${k}`).toEqual(
          placeholders(DICTIONARIES.en[k as keyof typeof DICTIONARIES.en])
        );
    }
  });

  it("pick the browser's language, falling back to English", () => {
    expect(pickLocale(["pl-PL", "en"])).toBe("pl");
    expect(pickLocale(["es-419"])).toBe("es");
    expect(pickLocale(["de-DE"])).toBe("en");
  });

  it("say relative times in each language", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(ago("es", now - 4 * 86_400_000, now)).toBe("hace 4 d");
    expect(ago("en", now - 86_400_000, now)).toBe("yesterday");
  });
});

/** Something that looks like a key or a leftover placeholder: snake_case words, or "{name}". */
const RAW = /\b[a-z]+(?:_[a-z0-9]+)+\b|\{\w+\}/;

describe("every screen in every language", () => {
  for (const locale of LOCALES) {
    for (const hash of ["#/", "#/shop", "#/capture", "#/inventory", "#/pending", `#/item/ITEM`]) {
      it(`${locale} ${hash} shows no raw key`, async () => {
        const id = uid();
        const api = new FakeApi([
          { state: state(id, "units", { quantity: -1, min_quantity: 2 }), data: { name: "Wipes", list: BABY } },
          { state: state(uid(), "level", { level: "out" }), data: { name: "Soap", list: GROCERIES } },
          { state: state(uid(), "pinned"), data: { name: "Bread", list: GROCERIES } },
          {
            state: state(uid(), "on_demand", { needed: true }),
            data: { name: "Fish oil", list: SUPPLEMENTS, buy_online: true },
          },
        ]);
        window.location.hash = hash.replace("ITEM", id);
        const c = new Controller({
          base: "",
          fetchImpl: api.fetch,
          lock: makeLock(undefined),
          openStore: async (userId) => memoryStore(createQueue(userId, newUuid())),
        });
        await c.start();
        const { container } = render(<App controller={c} locale={locale} />);
        await act(async () => {
          await new Promise((r) => setTimeout(r, 30));
        });
        // Each text node on its own: glued together ("Breadbadge_pinned") a key has no word boundary.
        const texts: string[] = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? "");
        for (const el of container.querySelectorAll("[aria-label]")) texts.push(el.getAttribute("aria-label")!);
        for (const text of texts) {
          expect(text.match(RAW)?.[0] ?? null, `${locale} ${hash}: ${text}`).toBeNull();
          expect(text, `${locale} ${hash}`).not.toMatch(/\bundefined\b|\bnull\b|NaN/);
        }
      });
    }
  }
});
