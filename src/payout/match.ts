/**
 * match.ts — tying a statement to what we actually sold.
 *
 * PLAN.md names the risk for this phase exactly: "Treating unmatched rows as
 * noise. They are the finding, not the mess." So this module has no concept of
 * discarding a row. Every statement row and every delivery sale ends up in
 * exactly one typed outcome, and the outcomes that are not clean matches are
 * the output people are supposed to look at.
 *
 * The four ways a payout cycle goes wrong, all of which cost money and none of
 * which look like an error at the time:
 *
 *  - **NO_SUCH_ORDER** — they paid for something we never rang. Usually an
 *    order we cancelled, occasionally a genuine mismatch of references.
 *  - **MISSING_FROM_STATEMENT** — we sold it and they have not paid. This is
 *    the one that silently loses money, because nothing anywhere complains.
 *  - **AMOUNT_MISMATCH** — paid, but not what was owed. Often a promotion
 *    funded differently from what we assumed, which is why the funded-discount
 *    split matters.
 *  - **DUPLICATE_IN_STATEMENT** — the same order twice. Either a real
 *    double-payment or, more often, a re-issued statement being imported on
 *    top of an old one.
 *
 * The comparison is always against our *frozen* expectation from the sale, not
 * a recomputation. That is the whole point of freezing commission at checkout
 * in Phase 4: it makes the statement checkable against what we believed at the
 * time, rather than against a number that moves whenever a contract changes.
 */

import { satang, sum, type Satang } from "../money.js";
import type { StatementRow } from "./parse.js";

export class MatchError extends Error {
  override readonly name = "MatchError";
}

/** What we expect a platform to pay us for one order, frozen at checkout. */
export interface ExpectedPayout {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly channelId: string;
  readonly platformOrderId: string;
  readonly netPayout: Satang;
  readonly gpAmount: Satang;
  readonly createdAt: string;
}

export type ExceptionKind =
  | "NO_SUCH_ORDER"
  | "MISSING_FROM_STATEMENT"
  | "AMOUNT_MISMATCH"
  | "DUPLICATE_IN_STATEMENT";

export interface MatchedPair {
  readonly platformOrderId: string;
  readonly expected: ExpectedPayout;
  readonly statement: StatementRow;
  /** statement − expected. Zero on a clean match. */
  readonly variance: Satang;
}

export interface PayoutException {
  readonly kind: ExceptionKind;
  readonly platformOrderId: string;
  /** Signed effect on the payout relative to what we expected. */
  readonly variance: Satang;
  readonly expected: ExpectedPayout | null;
  readonly statement: StatementRow | null;
  /** Plain sentence for the operator working the queue. */
  readonly detail: string;
}

export interface MatchResult {
  readonly matched: readonly MatchedPair[];
  readonly exceptions: readonly PayoutException[];
  readonly statementTotal: Satang;
  readonly expectedTotal: Satang;
  /** statementTotal − expectedTotal, the gap the exceptions have to account for. */
  readonly totalVariance: Satang;
}

/** References differ in case and padding between exports; compare them normalised. */
export function normaliseOrderId(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Match a parsed statement against our frozen expectations.
 *
 * `expected` should be the delivery sales in the statement's period that are
 * not already settled by an earlier batch. Passing sales from outside the
 * period would report them all as MISSING_FROM_STATEMENT, which is true but
 * useless.
 */
export function matchStatement(
  statementRows: readonly StatementRow[],
  expected: readonly ExpectedPayout[],
): MatchResult {
  const expectedByRef = new Map<string, ExpectedPayout>();
  for (const item of expected) {
    const key = normaliseOrderId(item.platformOrderId);
    if (key === "") continue;
    expectedByRef.set(key, item);
  }

  const matched: MatchedPair[] = [];
  const exceptions: PayoutException[] = [];
  const seen = new Map<string, StatementRow>();
  const consumed = new Set<string>();

  for (const row of statementRows) {
    const key = normaliseOrderId(row.platformOrderId);

    const alreadySeen = seen.get(key);
    if (alreadySeen) {
      exceptions.push({
        kind: "DUPLICATE_IN_STATEMENT",
        platformOrderId: row.platformOrderId,
        // The duplicate's own amount is the overstatement it introduces.
        variance: row.netPayout,
        expected: expectedByRef.get(key) ?? null,
        statement: row,
        detail:
          `Order ${row.platformOrderId} appears twice (lines ${alreadySeen.lineNumber} and ` +
          `${row.lineNumber}). Either a double payment or a re-issued statement imported twice.`,
      });
      continue;
    }
    seen.set(key, row);

    const match = expectedByRef.get(key);
    if (!match) {
      exceptions.push({
        kind: "NO_SUCH_ORDER",
        platformOrderId: row.platformOrderId,
        variance: row.netPayout,
        expected: null,
        statement: row,
        detail:
          `Statement pays for order ${row.platformOrderId}, which was never rung up here` +
          `${row.status === null ? "" : ` (status: ${row.status})`}. ` +
          `Usually a cancellation or an adjustment.`,
      });
      continue;
    }

    consumed.add(key);
    const variance = satang(row.netPayout - match.netPayout);

    if (variance === 0) {
      matched.push({ platformOrderId: row.platformOrderId, expected: match, statement: row, variance });
    } else {
      exceptions.push({
        kind: "AMOUNT_MISMATCH",
        platformOrderId: row.platformOrderId,
        variance,
        expected: match,
        statement: row,
        detail:
          `Order ${row.platformOrderId} (${match.receiptNo}) was expected to pay ` +
          `${match.netPayout} satang but the statement pays ${row.netPayout}. ` +
          `Check whether a promotion was funded differently than assumed.`,
      });
    }
  }

  // Everything we sold that the statement never mentioned. This is the
  // expensive one: nothing else in the system would ever complain about it.
  for (const [key, item] of expectedByRef) {
    if (consumed.has(key)) continue;
    exceptions.push({
      kind: "MISSING_FROM_STATEMENT",
      platformOrderId: item.platformOrderId,
      variance: satang(-item.netPayout),
      expected: item,
      statement: null,
      detail:
        `Order ${item.platformOrderId} (${item.receiptNo}) was sold but does not appear on this ` +
        `statement. Expected ${item.netPayout} satang. It may land in the next cycle — or not at all.`,
    });
  }

  const statementTotal = sum(statementRows.map((r) => r.netPayout));
  const expectedTotal = sum(expected.map((e) => e.netPayout));

  return {
    matched,
    exceptions: sortExceptions(exceptions),
    statementTotal,
    expectedTotal,
    totalVariance: satang(statementTotal - expectedTotal),
  };
}

/**
 * Worst first, by absolute money at stake.
 *
 * A queue ordered by import order buries a ฿500 missing payout under thirty
 * ฿1 rounding differences, and a queue nobody finishes is a queue that does
 * not work.
 */
function sortExceptions(exceptions: readonly PayoutException[]): PayoutException[] {
  return [...exceptions].sort(
    (a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.platformOrderId.localeCompare(b.platformOrderId),
  );
}

/**
 * Check that the exceptions actually account for the gap.
 *
 * If this ever fails, the matcher has lost money somewhere between the two
 * totals, and no amount of working the queue would reconcile the batch.
 */
export function exceptionsExplainVariance(result: MatchResult): boolean {
  const fromExceptions = sum(result.exceptions.map((e) => e.variance));
  return fromExceptions === result.totalVariance;
}
