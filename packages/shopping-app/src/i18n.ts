// Translation for the shopping app: three dictionaries local to this package (plan: no keys in
// packages/i18n). The locale follows the browser; nothing is stored.

import { en } from "./locales/en";
import { es } from "./locales/es";
import { pl } from "./locales/pl";

export type Key = keyof typeof en;
export type Dictionary = Record<Key, string>;
export type Locale = "en" | "es" | "pl";

export const DICTIONARIES: Record<Locale, Dictionary> = { en, es, pl };

export function pickLocale(languages: readonly string[]): Locale {
  for (const l of languages) {
    const base = l.toLowerCase().split("-")[0];
    if (base === "es" || base === "pl" || base === "en") return base;
  }
  return "en";
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export function makeT(locale: Locale): T {
  const dict = DICTIONARIES[locale];
  return (key, vars) => {
    // A missing key shows as itself, which the raw-key test catches, rather than as "undefined".
    const text = dict[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4 days ago", "yesterday", "hace 3 h": short, in the viewer's language, from device time. */
export function ago(locale: Locale, iso: string | number, now: number): string {
  const then = typeof iso === "number" ? iso : Date.parse(iso);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const diff = Math.max(now - then, 0);
  if (diff < HOUR) return rtf.format(-Math.round(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), "hour");
  return rtf.format(-Math.round(diff / DAY), "day");
}

export function shortDate(locale: Locale, iso: string): string {
  // A date-only value is a calendar day, not an instant: read it as UTC so no time zone moves it.
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`)
  );
}

export function listNames(locale: Locale, names: readonly string[]): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
}
