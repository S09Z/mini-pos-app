/**
 * zreport.ts — did the day make money?
 *
 * PLAN.md names the risk for this phase precisely: "Reporting revenue instead
 * of contribution. Revenue is the number that feels good and tells you least."
 * So this module is built so that contribution is the thing that falls out of
 * it most naturally, and revenue is available but subordinate. The UI ordering
 * follows the type: `contribution` sits above `gross` in `DayTotals`.
 *
 * Two honesty rules run through it:
 *
 *  1. **A voided sale is excluded from takings but not from the record.** It
 *     still appears in the void section with its value. Netting voids silently
 *     into revenue would hide the exact pattern the void audit is looking for.
 *
 *  2. **Unknown cost is never treated as zero cost.** A line with no frozen
 *     COGS makes contribution *unknown for that line*, and the report says how
 *     many lines were affected. Zero cost reads as 100% margin, which is the
 *     most flattering possible lie a POS can tell you about your own day.
 */

import { satang, sum, type Satang } from "../money.js";
import { bangkokHourOf, isInDay, type DayBounds } from "./period.js";

export class ZReportError extends Error {
  override readonly name = "ZReportError";
}

/** The subset of a sale record this module needs. */
export interface ReportableSale {
  readonly id: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly grossSatang: number;
  readonly netSatang: number;
  readonly vatSatang: number;
  readonly tenderedSatang: number;
  readonly changeSatang: number;
}

export interface ReportableSaleLine {
  readonly saleId: string;
  readonly menuItemId: string;
  readonly name: string;
  readonly qty: number;
  readonly grossSatang: number;
  /**
   * Optional *and* nullable, deliberately. A row written before this field
   * existed has no key at all, so a `=== null` check misses it and hands
   * `undefined` to `satang()` — which throws and takes the whole report down.
   * Storage can always hand back a shape older than the current type.
   */
  readonly cogsSatang?: number | null;
}

/** Normalise the two flavours of "we do not know what this cost". */
function knownCost(line: ReportableSaleLine): number | null {
  return line.cogsSatang == null ? null : line.cogsSatang;
}

export interface ReportableVoid {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly actor: string;
}

export interface DayTotals {
  /**
   * Revenue less cost of goods. Deliberately the first field: this is the
   * number the day should be judged on.
   */
  readonly contribution: Satang;
  /** Contribution as basis points of net revenue. `null` when cost is unknown. */
  readonly contributionMarginBp: number | null;
  readonly costOfGoods: Satang;
  /** True when every sold line carried a frozen cost. */
  readonly costComplete: boolean;
  /** Lines with no frozen cost — contribution understates margin by their cost. */
  readonly uncostedLines: number;

  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;

  readonly saleCount: number;
  readonly itemCount: number;
  /** Gross ÷ sale count. The number that tells you whether to change the menu. */
  readonly averageSale: Satang;

  readonly voidCount: number;
  readonly voidedValue: Satang;

  /** No UI produces a discount yet; present so the shape does not change later. */
  readonly discounts: Satang;
}

export interface HourBucket {
  readonly hour: number;
  readonly saleCount: number;
  readonly gross: Satang;
  readonly contribution: Satang;
}

export interface ItemLine {
  readonly menuItemId: string;
  readonly name: string;
  readonly qty: number;
  readonly gross: Satang;
  readonly costOfGoods: Satang;
  readonly contribution: Satang;
  readonly costComplete: boolean;
}

export interface ZReport {
  readonly day: string;
  readonly totals: DayTotals;
  readonly byHour: readonly HourBucket[];
  /** Sorted by contribution, never by revenue — see PLAN.md Phase 4's risk. */
  readonly byItem: readonly ItemLine[];
  readonly voids: readonly ReportableVoid[];
  /** Cash that should be in the drawer: gross of non-voided sales. */
  readonly expectedCash: Satang;
}

const ZERO = satang(0);

/**
 * Build the day's report.
 *
 * `voids` are matched by `saleId`, so a sale voided on a *later* day still
 * removes its takings from the day it was rung. That is the correct treatment
 * for stock and for cash, and it means a Z-report can change after the fact —
 * which is precisely why the void list is printed alongside it.
 */
export function buildZReport(
  bounds: DayBounds,
  sales: readonly ReportableSale[],
  lines: readonly ReportableSaleLine[],
  voids: readonly ReportableVoid[],
): ZReport {
  const daySales = sales.filter((s) => isInDay(s.createdAt, bounds));
  const voidedSaleIds = new Set(voids.map((v) => v.saleId));

  const liveSales = daySales.filter((s) => !voidedSaleIds.has(s.id));
  const liveSaleIds = new Set(liveSales.map((s) => s.id));
  const liveLines = lines.filter((l) => liveSaleIds.has(l.saleId));

  const voidedSales = daySales.filter((s) => voidedSaleIds.has(s.id));
  const dayVoids = voids.filter((v) => daySales.some((s) => s.id === v.saleId));

  const gross = sum(liveSales.map((s) => satang(s.grossSatang)));
  const net = sum(liveSales.map((s) => satang(s.netSatang)));
  const vat = sum(liveSales.map((s) => satang(s.vatSatang)));

  const uncostedLines = liveLines.filter((l) => knownCost(l) === null).length;
  const costOfGoods = sum(
    liveLines.map(knownCost).filter((c): c is number => c !== null).map(satang),
  );
  const costComplete = uncostedLines === 0;

  // Contribution is against net revenue: the VAT was never yours to keep.
  const contribution = satang(net - costOfGoods);
  const contributionMarginBp =
    !costComplete || net === 0 ? null : Math.round((contribution * 10_000) / net);

  const itemCount = liveLines.reduce((acc, l) => acc + l.qty, 0);
  const saleCount = liveSales.length;

  return {
    day: bounds.day,
    totals: {
      contribution,
      contributionMarginBp,
      costOfGoods,
      costComplete,
      uncostedLines,
      gross,
      net,
      vat,
      saleCount,
      itemCount,
      averageSale: saleCount === 0 ? ZERO : satang(Math.round(gross / saleCount)),
      voidCount: dayVoids.length,
      voidedValue: sum(voidedSales.map((s) => satang(s.grossSatang))),
      discounts: ZERO,
    },
    byHour: bucketByHour(liveSales, liveLines),
    byItem: rollUpByItem(liveLines),
    voids: [...dayVoids].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    expectedCash: gross,
  };
}

/** Only hours that actually traded — an empty row per closed hour is noise. */
function bucketByHour(
  sales: readonly ReportableSale[],
  lines: readonly ReportableSaleLine[],
): readonly HourBucket[] {
  const byHour = new Map<number, { saleCount: number; gross: number; contribution: number }>();

  for (const sale of sales) {
    const hour = bangkokHourOf(sale.createdAt);
    const bucket = byHour.get(hour) ?? { saleCount: 0, gross: 0, contribution: 0 };
    bucket.saleCount += 1;
    bucket.gross += sale.grossSatang;
    // Contribution per hour uses net, consistent with the day total.
    bucket.contribution += sale.netSatang;
    byHour.set(hour, bucket);

    for (const line of lines) {
      if (line.saleId !== sale.id) continue;
      const cost = knownCost(line);
      if (cost !== null) bucket.contribution -= cost;
    }
  }

  return [...byHour]
    .map(([hour, b]) => ({
      hour,
      saleCount: b.saleCount,
      gross: satang(b.gross),
      contribution: satang(b.contribution),
    }))
    .sort((a, b) => a.hour - b.hour);
}

/** Sorted by contribution: the item that earns most, not the one that sells most. */
function rollUpByItem(lines: readonly ReportableSaleLine[]): readonly ItemLine[] {
  const byItem = new Map<
    string,
    { name: string; qty: number; gross: number; cogs: number; complete: boolean }
  >();

  for (const line of lines) {
    const entry = byItem.get(line.menuItemId) ?? {
      name: line.name,
      qty: 0,
      gross: 0,
      cogs: 0,
      complete: true,
    };
    entry.qty += line.qty;
    entry.gross += line.grossSatang;
    const cost = knownCost(line);
    if (cost === null) entry.complete = false;
    else entry.cogs += cost;
    byItem.set(line.menuItemId, entry);
  }

  return [...byItem]
    .map(([menuItemId, e]) => ({
      menuItemId,
      name: e.name,
      qty: e.qty,
      gross: satang(e.gross),
      costOfGoods: satang(e.cogs),
      contribution: satang(e.gross - e.cogs),
      costComplete: e.complete,
    }))
    .sort((a, b) => b.contribution - a.contribution || (a.name < b.name ? -1 : 1));
}
