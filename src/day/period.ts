/**
 * period.ts — a trading day is a Bangkok day, not a UTC day.
 *
 * The same gotcha `rates.ts` documents for decree boundaries applies to every
 * report in this phase, and it bites harder here because it happens nightly
 * rather than once a year: a sale rung at 00:30 ICT on 19 August is 17:30 UTC
 * on 18 August. Grouping on the UTC date would push the last half-hour of
 * every late shift into the previous day's Z-report, so the drawer would
 * never reconcile and the cause would be invisible.
 *
 * Fixed +07:00 arithmetic is safe here specifically because Thailand has no
 * daylight saving and has not changed offset since 1920. This is the one
 * assumption in this module; anywhere else it would need a real tz database.
 */

export class PeriodError extends Error {
  override readonly name = "PeriodError";
}

/** Indochina Time, in minutes. Fixed — no DST. */
export const ICT_OFFSET_MINUTES = 7 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const parse = (instant: string): number => {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) throw new PeriodError(`Unparseable instant: ${instant}`);
  return t;
};

/** `YYYY-MM-DD` of the Bangkok-local day an instant falls in. */
export function bangkokDayOf(instant: string): string {
  const shifted = new Date(parse(instant) + ICT_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.toISOString().slice(0, 10);
}

/** Hour of the Bangkok-local day, 0–23. The `by hour` axis of the Z-report. */
export function bangkokHourOf(instant: string): number {
  const shifted = new Date(parse(instant) + ICT_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.getUTCHours();
}

export interface DayBounds {
  /** Inclusive start, as a UTC instant. */
  readonly startISO: string;
  /** Exclusive end, as a UTC instant. */
  readonly endISO: string;
  readonly day: string;
}

/**
 * The UTC instants bounding a Bangkok-local day.
 *
 * Half-open [start, end) so a sale at exactly local midnight belongs to the
 * new day, matching how `rateAt` treats a decree boundary.
 */
export function bangkokDayBounds(day: string): DayBounds {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new PeriodError(`Expected a YYYY-MM-DD day, got "${day}"`);
  }
  const localMidnightAsUtc = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(localMidnightAsUtc)) throw new PeriodError(`Not a real date: ${day}`);

  const start = localMidnightAsUtc - ICT_OFFSET_MINUTES * MS_PER_MINUTE;
  return {
    startISO: new Date(start).toISOString(),
    endISO: new Date(start + MS_PER_DAY).toISOString(),
    day,
  };
}

/** Is this instant inside the given Bangkok-local day? */
export function isInDay(instant: string, bounds: DayBounds): boolean {
  const t = parse(instant);
  return t >= parse(bounds.startISO) && t < parse(bounds.endISO);
}

/** Today's Bangkok-local date, for defaulting the Day screen. */
export function bangkokToday(now: Date = new Date()): string {
  return bangkokDayOf(now.toISOString());
}
