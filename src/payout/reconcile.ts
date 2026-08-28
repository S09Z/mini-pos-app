/**
 * reconcile.ts — did the deposit match the statement, and does the statement
 * match what we sold?
 *
 * Phase 5 is done when "a full payout cycle reconciles to zero unexplained
 * variance", so *unexplained* has to be a number this module computes rather
 * than a feeling the operator arrives at. That means splitting the gap in two:
 *
 *  - **Explained** — an exception someone has looked at and written a reason
 *    against. A cancelled order that the platform correctly did not pay for is
 *    a real variance and a fully understood one.
 *  - **Unexplained** — everything nobody has accounted for yet. This is the
 *    number that has to reach zero, and the only way to move it is to actually
 *    work the queue.
 *
 * Resolving an exception never edits the figures. It attaches a reason to a
 * variance that stays exactly where it was — the same rule as a voided sale, a
 * stock count and a cash drawer. A reconciliation that reached zero by
 * adjusting the numbers would prove nothing at all.
 *
 * There are two gaps, not one, and conflating them hides the interesting case:
 * the statement can disagree with our sales *and* the bank can disagree with
 * the statement. A platform that publishes a correct statement and then
 * deposits a different amount is a specific, real problem.
 */

import { satang, sum, type Satang } from "../money.js";
import type { MatchResult, PayoutException, ExceptionKind } from "./match.js";

export class ReconcileError extends Error {
  override readonly name = "ReconcileError";
}

/** An exception with an operator's explanation attached, if it has one. */
export interface ResolvedException {
  readonly platformOrderId: string;
  readonly kind: ExceptionKind;
  readonly variance: Satang;
  /** Null while the exception is still open. */
  readonly reason: string | null;
  readonly note: string;
}

/** The standard explanations, so a queue can be worked with taps not typing. */
export const EXCEPTION_REASONS: readonly { key: string; label: string; appliesTo: readonly ExceptionKind[] }[] = [
  { key: "CANCELLED", label: "Order was cancelled", appliesTo: ["NO_SUCH_ORDER", "MISSING_FROM_STATEMENT"] },
  { key: "REFUNDED", label: "Customer refunded", appliesTo: ["NO_SUCH_ORDER", "AMOUNT_MISMATCH"] },
  { key: "NEXT_CYCLE", label: "Expected in the next payout", appliesTo: ["MISSING_FROM_STATEMENT"] },
  { key: "PROMO_FUNDING", label: "Promotion funded differently than assumed", appliesTo: ["AMOUNT_MISMATCH"] },
  { key: "ADJUSTMENT", label: "Platform adjustment or fee", appliesTo: ["NO_SUCH_ORDER", "AMOUNT_MISMATCH"] },
  { key: "RESTATEMENT", label: "Statement re-issued and imported twice", appliesTo: ["DUPLICATE_IN_STATEMENT"] },
  { key: "DISPUTED", label: "Raised with the platform — unresolved", appliesTo: ["NO_SUCH_ORDER", "MISSING_FROM_STATEMENT", "AMOUNT_MISMATCH", "DUPLICATE_IN_STATEMENT"] },
];

export interface BatchReconciliation {
  /** What our own records said the platform owed. */
  readonly expectedFromSales: Satang;
  /** What the statement says it is paying. */
  readonly statementTotal: Satang;
  /** What actually arrived in the bank. Null until the operator enters it. */
  readonly depositAmount: Satang | null;

  /** statement − our expectation. */
  readonly statementVariance: Satang;
  /** deposit − statement. Null until a deposit is entered. */
  readonly depositVariance: Satang | null;

  readonly explainedVariance: Satang;
  /** The number Phase 5 exists to drive to zero. */
  readonly unexplainedVariance: Satang;

  readonly openExceptions: number;
  readonly resolvedExceptions: number;
  /** True when every exception is accounted for and the bank agrees with the statement. */
  readonly reconciled: boolean;
}

/**
 * Reconcile a batch.
 *
 * `depositAmount` is deliberately separate from the statement total. A
 * platform that publishes a correct statement and deposits something else is a
 * real and specific failure, and folding the two together would make it
 * invisible.
 */
export function reconcileBatch(
  match: MatchResult,
  resolutions: readonly ResolvedException[],
  depositAmount: Satang | null,
): BatchReconciliation {
  const reasonByOrder = new Map(
    resolutions.filter((r) => r.reason !== null).map((r) => [r.platformOrderId, r]),
  );

  const explained: PayoutException[] = [];
  const open: PayoutException[] = [];
  for (const exception of match.exceptions) {
    if (reasonByOrder.has(exception.platformOrderId)) explained.push(exception);
    else open.push(exception);
  }

  const explainedVariance = sum(explained.map((e) => e.variance));
  const statementVariance = match.totalVariance;

  // Whatever the explained exceptions do not account for is still unexplained,
  // including any gap between the statement and the bank.
  const depositVariance =
    depositAmount === null ? null : satang(depositAmount - match.statementTotal);

  const unexplained = satang(
    statementVariance - explainedVariance + (depositVariance ?? 0),
  );

  return {
    expectedFromSales: match.expectedTotal,
    statementTotal: match.statementTotal,
    depositAmount,
    statementVariance,
    depositVariance,
    explainedVariance,
    unexplainedVariance: unexplained,
    openExceptions: open.length,
    resolvedExceptions: explained.length,
    // A deposit that has not been entered is not a reconciled cycle, however
    // tidy the exception queue looks.
    reconciled: unexplained === 0 && open.length === 0 && depositAmount !== null,
  };
}

/**
 * Plain-language summary, for the line the operator reads before closing a
 * cycle. Says what is wrong and by how much, or that nothing is.
 */
export function describeReconciliation(
  reconciliation: BatchReconciliation,
  format: (s: Satang) => string,
): string {
  if (reconciliation.reconciled) return "Reconciled — no unexplained variance";
  if (reconciliation.depositAmount === null) {
    return "Enter the deposit that reached the bank to finish this cycle";
  }
  if (reconciliation.openExceptions > 0) {
    return `${reconciliation.openExceptions} exception${
      reconciliation.openExceptions === 1 ? "" : "s"
    } still unexplained, worth ${format(satang(Math.abs(reconciliation.unexplainedVariance)))}`;
  }
  const magnitude = format(satang(Math.abs(reconciliation.unexplainedVariance)));
  return reconciliation.unexplainedVariance < 0
    ? `${magnitude} less than expected, unexplained`
    : `${magnitude} more than expected, unexplained`;
}

/** Which reasons make sense for an exception of this kind. */
export function reasonsFor(kind: ExceptionKind): readonly { key: string; label: string }[] {
  return EXCEPTION_REASONS.filter((r) => r.appliesTo.includes(kind)).map((r) => ({
    key: r.key,
    label: r.label,
  }));
}
