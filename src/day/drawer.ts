/**
 * drawer.ts — is the cash all there?
 *
 * The rule, which is the same rule as the Phase 2 stock count: **the variance
 * is recorded as its own event and never silently corrected.** A till that
 * quietly adjusts itself to agree with whatever was counted cannot tell you
 * anything, and a stall where small shortfalls disappear on their own is a
 * stall where a large one will also disappear.
 *
 * So there is no "fix the drawer" operation. There is a count, an expectation,
 * and the difference between them — kept.
 *
 * Counting is by denomination rather than by typing a total. An operator
 * counting notes into piles and keying "8 × ฿100" makes different mistakes
 * than one doing the arithmetic in their head at closing time, and the tally
 * survives for anyone re-checking the count later.
 */

import { satang, type Satang } from "../money.js";

export class DrawerError extends Error {
  override readonly name = "DrawerError";
}

/**
 * Thai currency in circulation, in satang, largest first.
 *
 * The 25 and 50 satang coins are legal tender and still turn up, so they are
 * here even though most stalls round past them.
 */
export const THB_DENOMINATIONS: readonly Satang[] = [
  satang(100_000), // ฿1000
  satang(50_000), // ฿500
  satang(10_000), // ฿100
  satang(5_000), // ฿50
  satang(2_000), // ฿20
  satang(1_000), // ฿10 coin
  satang(500), // ฿5
  satang(200), // ฿2
  satang(100), // ฿1
  satang(50), // 50 satang
  satang(25), // 25 satang
];

/** How many of each denomination were counted. Keyed by satang value. */
export type DenominationTally = Readonly<Record<number, number>>;

/** Total a denomination tally. */
export function tallyTotal(tally: DenominationTally): Satang {
  let total = 0;
  for (const [denomination, count] of Object.entries(tally)) {
    const value = Number(denomination);
    if (!Number.isInteger(value) || value <= 0) {
      throw new DrawerError(`Not a valid denomination: ${denomination}`);
    }
    if (!Number.isInteger(count) || count < 0) {
      throw new DrawerError(`Denomination count must be a non-negative integer, got ${count}`);
    }
    total += value * count;
  }
  return satang(total);
}

export type DrawerStatus = "BALANCED" | "OVER" | "SHORT";

export interface Reconciliation {
  readonly expected: Satang;
  readonly declared: Satang;
  /** declared − expected. Negative is short. */
  readonly variance: Satang;
  readonly status: DrawerStatus;
}

/**
 * Compare the count to the expectation.
 *
 * There is deliberately no tolerance parameter. A ฿20 discrepancy that the
 * system calls "balanced" is a ฿20 discrepancy nobody will ever investigate,
 * and materiality is a judgement for the person reading the report, not a
 * constant to be buried in a reconciliation function.
 */
export function reconcileDrawer(expected: Satang, declared: Satang): Reconciliation {
  if (declared < 0) throw new DrawerError("A drawer count cannot be negative");
  const variance = satang(declared - expected);
  return {
    expected,
    declared,
    variance,
    status: variance === 0 ? "BALANCED" : variance > 0 ? "OVER" : "SHORT",
  };
}

/**
 * Plain-language variance, for a line the operator reads at closing time.
 *
 * DESIGN.md asks for the variance "stated plainly", and plainly means saying
 * short or over rather than rendering a signed number and leaving the reader
 * to work out which direction is the bad one.
 */
export function describeVariance(reconciliation: Reconciliation, format: (s: Satang) => string): string {
  const magnitude = format(satang(Math.abs(reconciliation.variance)));
  if (reconciliation.status === "BALANCED") return "Drawer balances";
  return reconciliation.status === "SHORT" ? `${magnitude} short` : `${magnitude} over`;
}
