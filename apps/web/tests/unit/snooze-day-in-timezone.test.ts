/**
 * L1: the intake snooze day is resolved in the PROJECT's timezone, not the browser's.
 *
 * Upstream #9944 floors a snooze to 00:00 of the picked day in the project timezone and a beat
 * task unsnoozes anything already past, so a day that has already started there lapses within
 * five minutes. The modal therefore offers tomorrow-in-the-project-zone as the first allowed day,
 * and that depends entirely on this helper. The hunk was dropped when the commit was ported (our
 * tree is pre-refactor, upstream's path had moved), which is what this test exists to notice.
 *
 * What this does NOT cover, deliberately and worth knowing: the modal's own rendering — that the
 * calendar really disables everything before `tomorrow`, and that closing clears the pick. Those
 * need a render test, and the E2E suite cannot reach the screen either because intake is off in
 * every project here. The day helper is the part that broke and the part that is pure.
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

  it("gives a day-granular floor, which is what the calendar's `before` compares against", () => {
    // the modal offers addDays(getDayInTimezone(now, zone), 1) as the first allowed day, and the
    // calendar disables everything `before` it — so every instant of "today in the project zone"
    // must fall below that boundary, and tomorrow must not
    const today = getDayInTimezone(INSTANT, "Asia/Tokyo");
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    expect(today < tomorrow).toBe(true);
    expect(getDayInTimezone(new Date(INSTANT.getTime() + 60_000), "Asia/Tokyo") >= tomorrow).toBe(false);
    // local midnight, so the comparison cannot be decided by a time-of-day component
    expect([today.getHours(), today.getMinutes(), today.getSeconds(), today.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  it("is the project's zone that decides, not the viewer's", () => {
    // the regression this pins: using the browser zone would put a Tokyo project's boundary a day
    // early for a European viewer, and the backend floors to the project zone either way
    expect(+getDayInTimezone(INSTANT, "Asia/Tokyo")).not.toBe(+getDayInTimezone(INSTANT, "UTC"));
  });
});
