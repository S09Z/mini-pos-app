/**
 * day.ts — assembling a trading day out of local storage.
 *
 * Sales are range-queried on `createdAt` using Bangkok-local day bounds, so
 * the late-shift sale rung at 00:30 ICT lands in the right report. Voids are
 * loaded without a date filter and matched by `saleId`: a sale voided
 * tomorrow still has to come out of today's takings.
 */

import { satang, type Satang } from "../money.js";
import { bangkokDayBounds, bangkokDayOf, type DayBounds } from "../day/period.js";
import { buildZReport, type ZReport } from "../day/zreport.js";
import { auditVoids, type AuditableVoid, type VoidAudit } from "../day/voidaudit.js";
import { reconcileDrawer, type Reconciliation } from "../day/drawer.js";
import { db, type CashCountRecord, type SaleRecord, type SaleLineRecord } from "./schema.js";

export class DayError extends Error {
  override readonly name = "DayError";
}

export interface DayData {
  readonly bounds: DayBounds;
  readonly sales: readonly SaleRecord[];
  readonly lines: readonly SaleLineRecord[];
  readonly cashCount: CashCountRecord | null;
}

export async function loadDayData(day: string): Promise<DayData> {
  const bounds = bangkokDayBounds(day);

  const sales = await db.sales
    .where("createdAt")
    .between(bounds.startISO, bounds.endISO, true, false)
    .toArray();

  const saleIds = new Set(sales.map((s) => s.id));
  const allLines = await db.sale_lines.toArray();
  const lines = allLines.filter((l) => saleIds.has(l.saleId));

  const counts = await db.cash_counts.where("day").equals(day).toArray();
  const cashCount =
    counts.length === 0
      ? null
      : // The last count wins for display, but earlier ones stay in the table.
        [...counts].sort((a, b) => (a.countedAt < b.countedAt ? 1 : -1))[0]!;

  return { bounds, sales, lines, cashCount };
}

export interface DayView {
  readonly report: ZReport;
  readonly audit: VoidAudit;
  readonly reconciliation: Reconciliation | null;
  readonly cashCount: CashCountRecord | null;
}

/** Everything the Day screen renders, in one read. */
export async function buildDayView(day: string): Promise<DayView> {
  const { bounds, sales, lines, cashCount } = await loadDayData(day);

  // Voids are not date-filtered: one written tomorrow still removes today's sale.
  const allVoids = await db.voids.toArray();
  const report = buildZReport(bounds, sales, lines, allVoids);

  const saleById = new Map(sales.map((s) => [s.id, s]));
  const auditable: AuditableVoid[] = report.voids.map((v) => ({
    saleId: v.saleId,
    receiptNo: v.receiptNo,
    createdAt: v.createdAt,
    actor: v.actor,
    valueSatang: saleById.get(v.saleId)?.grossSatang ?? 0,
  }));

  // Rate is against every sale rung, voided ones included — the denominator is
  // what was put through the till, not what survived.
  const salesRung = report.totals.saleCount + report.totals.voidCount;
  const audit = auditVoids(auditable, salesRung, report.totals.gross);

  return {
    report,
    audit,
    reconciliation:
      cashCount === null
        ? null
        : reconcileDrawer(report.expectedCash, satang(cashCount.declaredSatang)),
    cashCount,
  };
}

/**
 * Record a drawer count.
 *
 * Always an insert. Counting twice leaves two rows, because the fact that a
 * count was redone is itself worth knowing — a second count that suddenly
 * agrees is a different story from a first one that did.
 */
export async function recordCashCount(
  day: string,
  expected: Satang,
  declared: Satang,
  note = "",
): Promise<CashCountRecord> {
  const reconciliation = reconcileDrawer(expected, declared);
  const record: CashCountRecord = {
    id: crypto.randomUUID(),
    day,
    countedAt: new Date().toISOString(),
    expectedSatang: expected,
    declaredSatang: declared,
    varianceSatang: reconciliation.variance,
    note,
  };
  await db.cash_counts.add(record);
  return record;
}

/** Every count taken for a day, newest first. */
export async function cashCountHistory(day: string): Promise<CashCountRecord[]> {
  const counts = await db.cash_counts.where("day").equals(day).toArray();
  return counts.sort((a, b) => (a.countedAt < b.countedAt ? 1 : -1));
}

/** Days that have any sales, newest first — for the day picker. */
export async function tradingDays(): Promise<string[]> {
  const sales = await db.sales.toArray();
  const days = new Set(sales.map((sale) => bangkokDayOf(sale.createdAt)));
  return [...days].sort().reverse();
}
