/**
 * payouts.ts — importing a statement and settling it against local records.
 *
 * The one rule this file exists to enforce: **every sale traces to a deposit.**
 * A matched order gets its `platform_fees.payoutBatchId` set, which is what
 * turns "we think they owe us this" into "this specific order was paid in this
 * specific batch". An order with a null batch id has not been paid, and that
 * is now a queryable fact rather than an assumption.
 *
 * Importing is append-only. Re-importing a corrected statement creates a new
 * batch; it never edits the old one. The history of what a platform claimed,
 * and when, is often the only evidence available when disputing a shortfall.
 */

import { satang, type Satang } from "../money.js";
import { parseStatement, type ParsedStatement } from "../payout/parse.js";
import {
  matchStatement,
  type ExpectedPayout,
  type MatchResult,
  type PayoutException,
} from "../payout/match.js";
import {
  reconcileBatch,
  type BatchReconciliation,
  type ResolvedException,
} from "../payout/reconcile.js";
import {
  db,
  type PayoutBatchRecord,
  type PayoutExceptionRecord,
  type StatementRowRecord,
} from "./schema.js";

export class PayoutError extends Error {
  override readonly name = "PayoutError";
}

/**
 * Delivery sales on a channel that no batch has settled yet.
 *
 * Unsettled rather than date-ranged: an order the platform pays two cycles
 * late must still find its statement when it finally appears, and a date
 * window would have quietly written it off.
 */
export async function unsettledPayouts(channelId: string): Promise<ExpectedPayout[]> {
  const fees = await db.platform_fees.where("channelId").equals(channelId).toArray();
  const unsettled = fees.filter((fee) => fee.payoutBatchId === null);
  if (unsettled.length === 0) return [];

  const sales = await db.sales.bulkGet(unsettled.map((f) => f.saleId));
  const saleById = new Map(sales.filter((s) => s !== undefined).map((s) => [s!.id, s!]));
  const voidedSaleIds = new Set((await db.voids.toArray()).map((v) => v.saleId));

  return unsettled
    // A voided order was never really sold; expecting payment for it would
    // manufacture a MISSING_FROM_STATEMENT exception every single cycle.
    .filter((fee) => !voidedSaleIds.has(fee.saleId))
    .map((fee) => {
      const sale = saleById.get(fee.saleId);
      return {
        saleId: fee.saleId,
        receiptNo: sale?.receiptNo ?? fee.saleId,
        channelId: fee.channelId,
        platformOrderId: fee.platformOrderId,
        netPayout: satang(fee.netPayoutSatang),
        gpAmount: satang(fee.gpAmountSatang),
        createdAt: sale?.createdAt ?? "",
      };
    });
}

export interface ImportPreview {
  readonly parsed: ParsedStatement;
  readonly match: MatchResult;
}

/** Parse and match without writing anything, so the operator can look first. */
export async function previewStatement(
  channelId: string,
  text: string,
): Promise<ImportPreview> {
  const parsed = parseStatement(text);
  const expected = await unsettledPayouts(channelId);
  return { parsed, match: matchStatement(parsed.rows, expected) };
}

/**
 * Commit an import: the batch, its rows, its exceptions, and the settlement
 * links, all in one transaction.
 *
 * Partial application would be worse than no import at all — half-linked fees
 * would make a second attempt report the same orders as already settled.
 */
export async function importStatement(
  channelId: string,
  fileName: string,
  text: string,
): Promise<{ batchId: string; match: MatchResult }> {
  const { parsed, match } = await previewStatement(channelId, text);
  const batchId = crypto.randomUUID();
  const importedAt = new Date().toISOString();

  const batch: PayoutBatchRecord = {
    id: batchId,
    channelId,
    importedAt,
    fileName,
    rowCount: parsed.rows.length,
    statementTotalSatang: match.statementTotal,
    expectedTotalSatang: match.expectedTotal,
    depositSatang: null,
    note: "",
  };

  const rows: StatementRowRecord[] = parsed.rows.map((row) => ({
    id: crypto.randomUUID(),
    batchId,
    platformOrderId: row.platformOrderId,
    netPayoutSatang: row.netPayout,
    grossSatang: row.gross,
    commissionSatang: row.commission,
    platformFundedDiscountSatang: row.platformFundedDiscount,
    merchantFundedDiscountSatang: row.merchantFundedDiscount,
    orderDate: row.orderDate,
    status: row.status,
    lineNumber: row.lineNumber,
    raw: row.raw,
  }));

  const exceptions: PayoutExceptionRecord[] = match.exceptions.map((exception) => ({
    id: crypto.randomUUID(),
    batchId,
    kind: exception.kind,
    platformOrderId: exception.platformOrderId,
    varianceSatang: exception.variance,
    saleId: exception.expected?.saleId ?? null,
    detail: exception.detail,
    reason: null,
    note: "",
    resolvedAt: null,
  }));

  await db.transaction(
    "rw",
    [db.payout_batches, db.statement_rows, db.payout_exceptions, db.platform_fees],
    async () => {
      await db.payout_batches.add(batch);
      if (rows.length > 0) await db.statement_rows.bulkAdd(rows);
      if (exceptions.length > 0) await db.payout_exceptions.bulkAdd(exceptions);

      // This is the line that makes "every sale traces to a deposit" true.
      // Only clean matches settle: an amount mismatch is still owed something
      // and must stay open until someone decides what.
      for (const pair of match.matched) {
        const fee = await db.platform_fees.get(pair.expected.saleId);
        if (fee) await db.platform_fees.put({ ...fee, payoutBatchId: batchId });
      }
    },
  );

  return { batchId, match };
}

/**
 * Attach a reason to an exception.
 *
 * Never touches `varianceSatang`. The variance is the finding; the reason is
 * the explanation for it, and a reconciliation that reached zero by adjusting
 * the former would be worthless.
 */
export async function resolveException(
  exceptionId: string,
  reason: string,
  note = "",
): Promise<void> {
  const exception = await db.payout_exceptions.get(exceptionId);
  if (!exception) throw new PayoutError("Exception not found");
  await db.payout_exceptions.put({
    ...exception,
    reason,
    note,
    resolvedAt: new Date().toISOString(),
  });
}

/** Reopen an exception that was explained wrongly. Also append-only in spirit. */
export async function reopenException(exceptionId: string): Promise<void> {
  const exception = await db.payout_exceptions.get(exceptionId);
  if (!exception) throw new PayoutError("Exception not found");
  await db.payout_exceptions.put({ ...exception, reason: null, resolvedAt: null });
}

export async function recordDeposit(batchId: string, deposit: Satang): Promise<void> {
  const batch = await db.payout_batches.get(batchId);
  if (!batch) throw new PayoutError("Batch not found");
  await db.payout_batches.put({ ...batch, depositSatang: deposit });
}

export interface BatchView {
  readonly batch: PayoutBatchRecord;
  readonly exceptions: readonly PayoutExceptionRecord[];
  readonly reconciliation: BatchReconciliation;
  readonly matchedCount: number;
}

/** Everything the Payouts screen needs for one batch. */
export async function buildBatchView(batchId: string): Promise<BatchView> {
  const batch = await db.payout_batches.get(batchId);
  if (!batch) throw new PayoutError("Batch not found");

  const [exceptionRows, settledFees] = await Promise.all([
    db.payout_exceptions.where("batchId").equals(batchId).toArray(),
    db.platform_fees.where("payoutBatchId").equals(batchId).toArray(),
  ]);

  // Rebuilt from the stored rows rather than re-read from the file, which is
  // gone by now. The exceptions are the record of what the match found.
  const exceptions: PayoutException[] = exceptionRows.map((row) => ({
    kind: row.kind as PayoutException["kind"],
    platformOrderId: row.platformOrderId,
    variance: satang(row.varianceSatang),
    expected: null,
    statement: null,
    detail: row.detail,
  }));

  const storedMatch: MatchResult = {
    matched: [],
    exceptions,
    statementTotal: satang(batch.statementTotalSatang),
    expectedTotal: satang(batch.expectedTotalSatang),
    totalVariance: satang(batch.statementTotalSatang - batch.expectedTotalSatang),
  };

  const resolutions: ResolvedException[] = exceptionRows.map((row) => ({
    platformOrderId: row.platformOrderId,
    kind: row.kind as PayoutException["kind"],
    variance: satang(row.varianceSatang),
    reason: row.reason,
    note: row.note,
  }));

  return {
    batch,
    exceptions: [...exceptionRows].sort(
      (a, b) => Math.abs(b.varianceSatang) - Math.abs(a.varianceSatang),
    ),
    reconciliation: reconcileBatch(
      storedMatch,
      resolutions,
      batch.depositSatang === null ? null : satang(batch.depositSatang),
    ),
    // Orders this batch actually settled — the fees it stamped its id onto.
    matchedCount: settledFees.length,
  };
}

/** Batches for a channel, newest first. */
export async function batchesFor(channelId: string): Promise<PayoutBatchRecord[]> {
  const batches = await db.payout_batches.where("channelId").equals(channelId).toArray();
  return batches.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

export async function allBatches(): Promise<PayoutBatchRecord[]> {
  const batches = await db.payout_batches.toArray();
  return batches.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}
