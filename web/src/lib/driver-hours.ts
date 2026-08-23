/**
 * EU driving time and rest rules — Regulation (EC) No 561/2006.
 *
 * These are hard legal limits, not guidance. A dispatch plan that puts a driver
 * past them is illegal for the operator and the driver both, and is what
 * roadside enforcement checks the tachograph against.
 *
 * Retained in UK and NI law post-Brexit with the same numbers, so one
 * implementation covers Ireland, Northern Ireland, Great Britain and the EU.
 *
 * Pure functions over a driver row — no fixtures, no clock of their own — so
 * these are unchanged when the data starts coming from the tachograph feed.
 */

import type { Driver } from "./types";

const H = 3_600;

/** Art. 7 — a 45 min break after 4h30 of accumulated driving. */
export const CONTINUOUS_DRIVING_LIMIT_S = 4.5 * H;
export const REQUIRED_BREAK_S = 45 * 60;

/** Art. 6(1) — 9h daily, extendable to 10h at most twice a week. */
export const DAILY_DRIVING_LIMIT_S = 9 * H;
export const EXTENDED_DAILY_LIMIT_S = 10 * H;
export const MAX_EXTENDED_DAYS_PER_WEEK = 2;

/** Art. 6(2) — 56h in a fixed week. */
export const WEEKLY_DRIVING_LIMIT_S = 56 * H;

/** Art. 8 — 11h regular daily rest, reducible to 9h. */
export const DAILY_REST_S = 11 * H;

/** How close to a limit counts as "plan around this now". */
const WARNING_MARGIN_S = 30 * 60;

export type HoursLevel = "ok" | "warning" | "break_due" | "limit_reached";

export interface DriverHours {
  level: HoursLevel;
  /** Seconds of driving left before the 45 min break becomes mandatory. */
  secondsUntilBreak: number;
  /** Seconds of driving left today, against this driver's daily ceiling. */
  secondsUntilDailyLimit: number;
  /** 9h normally; 10h if this driver still has an extension left this week. */
  dailyLimitSeconds: number;
  secondsUntilWeeklyLimit: number;
  /** The binding constraint — the smallest of the three. */
  secondsOfDrivingLeft: number;
  /** Whether a 10h day is still available under Art. 6(1). */
  extensionAvailable: boolean;
  headline: string;
}

/**
 * The daily ceiling for *this* driver right now. A driver who has already used
 * both weekly extensions is capped at 9h; one who has not may run to 10h.
 */
export function dailyLimitFor(driver: Driver): number {
  return driver.extended_days_this_week < MAX_EXTENDED_DAYS_PER_WEEK
    ? EXTENDED_DAILY_LIMIT_S
    : DAILY_DRIVING_LIMIT_S;
}

export function driverHours(driver: Driver): DriverHours {
  const dailyLimitSeconds = dailyLimitFor(driver);

  const secondsUntilBreak = Math.max(
    0,
    CONTINUOUS_DRIVING_LIMIT_S - driver.driving_seconds_since_break,
  );
  const secondsUntilDailyLimit = Math.max(
    0,
    dailyLimitSeconds - driver.driving_seconds_today,
  );
  const secondsUntilWeeklyLimit = Math.max(
    0,
    WEEKLY_DRIVING_LIMIT_S - driver.driving_seconds_this_week,
  );

  const secondsOfDrivingLeft = Math.min(
    secondsUntilBreak,
    secondsUntilDailyLimit,
    secondsUntilWeeklyLimit,
  );

  let level: HoursLevel;
  let headline: string;

  if (secondsUntilDailyLimit === 0 || secondsUntilWeeklyLimit === 0) {
    level = "limit_reached";
    headline =
      secondsUntilWeeklyLimit === 0
        ? "Weekly 56 h driving limit reached"
        : "Daily driving limit reached — needs a daily rest";
  } else if (secondsUntilBreak === 0) {
    level = "break_due";
    headline = "45 min break due now";
  } else if (secondsOfDrivingLeft <= WARNING_MARGIN_S) {
    level = "warning";
    headline =
      secondsUntilBreak <= WARNING_MARGIN_S
        ? "Break due within the half hour"
        : "Approaching the daily driving limit";
  } else {
    level = "ok";
    headline = "Within driving time";
  }

  return {
    level,
    secondsUntilBreak,
    secondsUntilDailyLimit,
    dailyLimitSeconds,
    secondsUntilWeeklyLimit,
    secondsOfDrivingLeft,
    extensionAvailable:
      driver.extended_days_this_week < MAX_EXTENDED_DAYS_PER_WEEK,
    headline,
  };
}

/**
 * Whether a driver can legally still drive `minutes` more — the question the
 * dispatch board is really asking when it shows an ETA to the next stop.
 *
 * `estimateMinutes()` is a crude speed assumption, so this is a planning aid,
 * not a compliance record: the tachograph is the legal evidence.
 */
export function canDriveFor(
  hours: DriverHours,
  minutes: number | null,
): { ok: boolean; reason: string | null } {
  if (minutes === null) return { ok: true, reason: null };
  const needed = minutes * 60;

  if (needed > hours.secondsUntilDailyLimit) {
    return { ok: false, reason: "Beyond the daily driving limit" };
  }
  if (needed > hours.secondsUntilBreak) {
    return { ok: false, reason: "A 45 min break falls before this stop" };
  }
  return { ok: true, reason: null };
}

/** "4h 30m" / "45m" — compact enough for a table cell. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export const DUTY_STATUS_LABEL: Record<Driver["duty_status"], string> = {
  driving: "Driving",
  break: "On break",
  rest: "Daily rest",
  other_work: "Other work",
  available: "Available",
  off_duty: "Off duty",
};
