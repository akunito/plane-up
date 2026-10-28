/**
 * L1: the intake snooze day is resolved in the PROJECT's timezone, not the browser's.
 *
 * Upstream #9944 floors a snooze to 00:00 of the picked day in the project timezone and a beat
 * task unsnoozes anything already past, so a day that has already started there lapses within
 * five minutes. The modal therefore offers tomorrow-in-the-project-zone as the first allowed day,
 * and that depends entirely on this helper. The hunk was dropped when the commit was ported (our
 * tree is pre-refactor, upstream's path had moved), which is what this test exists to notice.
 */
import { describe, expect, it } from "vitest";

import { getDayInTimezone } from "@/components/inbox/modals/snooze-issue-modal";

/** 2026-10-28T23:30:00Z — already the 29th in Tokyo, still the 28th in Los Angeles. */
const INSTANT = new Date("2026-10-28T23:30:00.000Z");

const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join("-");

describe("getDayInTimezone", () => {
  it("takes the calendar day of the project's zone, not UTC", () => {
    expect(ymd(getDayInTimezone(INSTANT, "Asia/Tokyo"))).toBe("2026-10-29");
    expect(ymd(getDayInTimezone(INSTANT, "America/Los_Angeles"))).toBe("2026-10-28");
    expect(ymd(getDayInTimezone(INSTANT, "UTC"))).toBe("2026-10-28");
  });

  it("returns local midnight, so the calendar's `before` comparison is day-granular", () => {
    const day = getDayInTimezone(INSTANT, "Europe/Madrid");
    expect([day.getHours(), day.getMinutes(), day.getSeconds(), day.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  it("falls back to the browser zone when the project has none", () => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(ymd(getDayInTimezone(INSTANT, undefined))).toBe(ymd(getDayInTimezone(INSTANT, browserZone)));
  });
});
