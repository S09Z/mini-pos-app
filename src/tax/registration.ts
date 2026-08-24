/**
 * registration.ts — am I VAT registered, since when, and how close am I?
 *
 * Registration is not a boolean setting. It is a *dated* fact, for exactly the
 * same reason the VAT rate is one: a sale rung last March must reprint under
 * the status that applied last March, not under today's. So this module models
 * registration as an append-only ledger of events, and `registrationAt()`
 * resolves the state in force at an instant — the same shape, and the same
 * half-open boundary rule, as `rateAt()` in rates.ts.
 *
 * The second job here is the watchdog. Registration becomes compulsory once
 * annual revenue passes 1,800,000 THB, and the duty arises within 30 days of
 * crossing. Nobody misses that line by being reckless; they miss it because
 * takings creep up a few hundred baht a month and nobody is summing them. So
 * we sum them, warn well before the line, and — once it is crossed — name the
 * instant it happened and the date the paperwork is due.
 *
 * Pure module: no Dexie, no React. See CLAUDE.md.
 */

import { satang, sum, type Satang, type BasisPoints } from "../money.js";
import { VAT_REGISTRATION_THRESHOLD, registrationStatus } from "./vat.js";

export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
}

/** Head office. Any other value is a branch and prints as one. */
export const HEAD_OFFICE_BRANCH = "00000";

/** Days from crossing the threshold to the registration deadline. */
export const REGISTRATION_DEADLINE_DAYS = 30;

export type RegistrationKind = "REGISTERED" | "DEREGISTERED";

/**
 * One event in the registration ledger. Append-only: correcting a mistake
 * means a new event, never an edit, because an edited effective date would
 * silently restate the VAT treatment of every sale in between.
 */
export interface RegistrationEvent {
  readonly id: string;
  readonly kind: RegistrationKind;
  /** Inclusive, as an ISO-8601 instant with an explicit offset. */
  readonly effectiveFrom: string;
  /** The 13-digit ผู้เสียภาษี number. Carried on the event, not on the device. */
  readonly taxId: string;
  readonly branchCode: string;
  /** The POS machine number approved by the Revenue Department. */
  readonly posMachineNumber: string;
  readonly note: string;
}

export interface RegistrationState {
  readonly registered: boolean;
  /** Null whenever `registered` is false — there is no identity to print. */
  readonly taxId: string | null;
  readonly branchCode: string | null;
  readonly posMachineNumber: string | null;
  /** The instant the current state took effect, or null if never registered. */
  readonly since: string | null;
}

const UNREGISTERED: RegistrationState = {
  registered: false,
  taxId: null,
  branchCode: null,
  posMachineNumber: null,
  since: null,
};

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RegistrationError(`Unparseable instant: ${iso}`);
  return t;
};

/**
 * Thai 13-digit taxpayer identification checksum.
 *
 * Weights run 13 down to 2 across the first twelve digits; the check digit is
 * `(11 − (sum mod 11)) mod 10`. Worth validating at the point of entry: a
 * transposed digit on a full tax invoice makes the invoice useless to the
 * customer, and they find out weeks later when their accountant rejects it.
 */
export function isValidThaiTaxId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let acc = 0;
  for (let i = 0; i < 12; i++) acc += Number(id[i]) * (13 - i);
  return (11 - (acc % 11)) % 10 === Number(id[12]);
}

export function assertThaiTaxId(id: string): void {
  if (!isValidThaiTaxId(id)) {
    throw new RegistrationError(`Not a valid 13-digit Thai tax ID: "${id}"`);
  }
}

/**
 * The branch designation that must appear on a tax invoice.
 *
 * Thai, verbatim, and never machine-translated — สำนักงานใหญ่ is the required
 * wording, not a description of one. See DESIGN.md on tax terms of art.
 */
export function formatBranch(branchCode: string): string {
  if (!/^\d{5}$/.test(branchCode)) {
    throw new RegistrationError(`Branch code must be five digits, got "${branchCode}"`);
  }
  return branchCode === HEAD_OFFICE_BRANCH ? "สำนักงานใหญ่" : `สาขาที่ ${branchCode}`;
}

/**
 * Validate a whole ledger. Call it before writing an event and at app boot,
 * so an ambiguous ledger fails loudly rather than at invoice time.
 */
export function validateRegistrationLedger(events: readonly RegistrationEvent[]): void {
  const seenIds = new Set<string>();
  const seenInstants = new Set<number>();

  for (const event of events) {
    if (seenIds.has(event.id)) throw new RegistrationError(`Duplicate event id "${event.id}"`);
    seenIds.add(event.id);

    const t = ms(event.effectiveFrom);
    // Two events at the same instant leave the state genuinely undefined, and
    // picking one by array order would make it depend on read order.
    if (seenInstants.has(t)) {
      throw new RegistrationError(`Two registration events at ${event.effectiveFrom}`);
    }
    seenInstants.add(t);

    if (event.kind === "REGISTERED") {
      assertThaiTaxId(event.taxId);
      formatBranch(event.branchCode);
      // An abbreviated tax invoice issued by a POS machine must carry the
      // machine's approved number. Without it we could register the business
      // and then be unable to legally issue the receipt it hands customers.
      if (event.posMachineNumber.trim() === "") {
        throw new RegistrationError(
          "A registration needs the Revenue Department POS machine number — an abbreviated tax invoice cannot be issued without it",
        );
      }
    }
  }
}

/**
 * The registration state in force at `at`.
 *
 * Half-open [effectiveFrom, next): a sale at exactly the effective instant is
 * inside the new state, matching `rateAt`. Because the events carry explicit
 * offsets, a sale at 00:30 ICT resolves against the Bangkok-local boundary
 * rather than the UTC one — the gotcha CLAUDE.md flags for decree dates
 * applies here identically.
 */
export function registrationAt(
  events: readonly RegistrationEvent[],
  at: Date,
): RegistrationState {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new RegistrationError("Invalid Date passed to registrationAt");

  const sorted = [...events].sort((a, b) => ms(a.effectiveFrom) - ms(b.effectiveFrom));

  let state = UNREGISTERED;
  for (const event of sorted) {
    if (ms(event.effectiveFrom) > t) break;
    state =
      event.kind === "REGISTERED"
        ? {
            registered: true,
            taxId: event.taxId,
            branchCode: event.branchCode,
            posMachineNumber: event.posMachineNumber,
            since: event.effectiveFrom,
          }
        : { ...UNREGISTERED, since: event.effectiveFrom };
  }
  return state;
}

/** A sale reduced to what the threshold cares about: when, and how much. */
export interface RevenuePoint {
  readonly id: string;
  readonly at: string;
  /** VAT-inclusive takings. Voided sales must be excluded before they get here. */
  readonly gross: Satang;
}

/**
 * The instant twelve months before `at`.
 *
 * Fixed-offset arithmetic on the *instant* is safe for the same reason
 * period.ts gives: Thailand has had no daylight saving and no offset change
 * since 1920, so shifting the UTC year keeps the Bangkok wall clock intact.
 * 29 February rolls to 1 March, which widens the window by a day once every
 * four years — in the conservative direction.
 */
export function twelveMonthsBefore(at: Date): Date {
  const d = new Date(at.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

/**
 * Revenue in the trailing twelve months, inclusive at both edges.
 *
 * Future-dated points are ignored rather than counted or rejected: a clock
 * skewed forward on one terminal should not be able to fake a threshold
 * crossing, and it should not crash the Day screen either.
 */
export function trailingRevenue(points: readonly RevenuePoint[], asOf: Date): Satang {
  const end = asOf.getTime();
  if (Number.isNaN(end)) throw new RegistrationError("Invalid Date passed to trailingRevenue");
  const start = twelveMonthsBefore(asOf).getTime();

  return sum(
    points.filter((p) => {
      const t = ms(p.at);
      return t >= start && t <= end;
    }).map((p) => p.gross),
  );
}

export interface Watchdog {
  readonly trailing12m: Satang;
  readonly threshold: Satang;
  /** Trailing revenue as a fraction of the threshold, in basis points. */
  readonly usedBp: BasisPoints;
  /** Over the line: registration is compulsory. */
  readonly required: boolean;
  /** Under the line but close enough that it needs saying now. */
  readonly approaching: boolean;
  /** Never negative — over the line it is zero and `required` carries the news. */
  readonly headroom: Satang;
  /** The instant the trailing window first exceeded the threshold, if it has. */
  readonly crossedAt: string | null;
  /** 30 days after `crossedAt`. Null until it is crossed. */
  readonly registerBy: string | null;
}

/**
 * Trailing-twelve-month watchdog.
 *
 * `crossedAt` is found by walking the history and recomputing the trailing
 * window at each sale, so it is the actual instant the business went over —
 * not the day someone happened to open this screen. That distinction is the
 * whole point: the 30-day clock started when the sale was rung, and the
 * deadline is already running by the time anyone looks.
 */
export function vatWatchdog(
  points: readonly RevenuePoint[],
  asOf: Date,
  opts: { readonly warnAtBp?: BasisPoints } = {},
): Watchdog {
  // Not configurable: 1.8M THB is statutory, and a threshold you can tune is a
  // threshold someone will quietly tune upward when the warning gets annoying.
  const threshold = VAT_REGISTRATION_THRESHOLD;

  const trailing12m = trailingRevenue(points, asOf);
  const status = registrationStatus(trailing12m, opts.warnAtBp);

  return {
    trailing12m,
    threshold,
    usedBp: status.usedBp,
    required: status.required,
    approaching: status.approaching,
    headroom: satang(Math.max(0, threshold - trailing12m)),
    ...crossing(points, asOf, threshold),
  };
}

/**
 * The first instant at which the trailing window exceeded the threshold.
 *
 * A sliding window rather than recomputing `trailingRevenue` at every sale:
 * that would be quadratic, and this runs on a year of a busy stall's receipts
 * every time the Day screen renders.
 *
 * Points sharing an instant are only tested once the whole group is inside the
 * window, so the answer matches what `trailingRevenue` would say at that
 * instant rather than depending on where the group happened to be cut.
 */
function crossing(
  points: readonly RevenuePoint[],
  asOf: Date,
  threshold: Satang,
): { crossedAt: string | null; registerBy: string | null } {
  const sorted = [...points]
    .map((p) => ({ at: p.at, t: ms(p.at), gross: p.gross }))
    .filter((p) => p.t <= asOf.getTime())
    .sort((a, b) => a.t - b.t);

  let left = 0;
  let running = 0;

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    running += point.gross;

    const windowStart = twelveMonthsBefore(new Date(point.t)).getTime();
    while (sorted[left]!.t < windowStart) {
      running -= sorted[left]!.gross;
      left += 1;
    }

    const lastOfInstant = i + 1 === sorted.length || sorted[i + 1]!.t !== point.t;
    if (lastOfInstant && running > threshold) {
      return {
        crossedAt: point.at,
        registerBy: new Date(point.t + REGISTRATION_DEADLINE_DAYS * 86_400_000).toISOString(),
      };
    }
  }

  return { crossedAt: null, registerBy: null };
}
