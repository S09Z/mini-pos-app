/**
 * day.ts — assembling a trading day out of local storage.
 *
 * Sales are range-queried on `createdAt` using Bangkok-local day bounds, so
 * the late-shift sale rung at 00:30 ICT lands in the right report. Voids are
 * loaded without a date filter and matched by `saleId`: a sale voided
 * tomorrow still has to come out of today's takings.
 */

import { satang, sum, type Satang } from "../money.js";
import { bangkokDayBounds, bangkokDayOf, type DayBounds } from "../day/period.js";
import { buildZReport, type ZReport } from "../day/zreport.js";
import { auditVoids, type AuditableVoid, type VoidAudit } from "../day/voidaudit.js";
import { reconcileDrawer, type Reconciliation } from "../day/drawer.js";
import {
  performanceByChannel,
  answerPricingQuestion,
  counterContribution,
  type ChannelPerformance,
  type ChannelSale,
  type PricingAnswer,
} from "../channel/analysis.js";
import { WALK_IN, type Channel } from "../channel/types.js";
import { resolveRecipe } from "../stock/recipe.js";
import { costOf } from "../stock/costing.js";
import { unitCostMap } from "./stock.js";
import {
  db,
  type CashCountRecord,
  type ChannelRecord,
  type SaleRecord,
  type SaleLineRecord,
} from "./schema.js";

/** Storage shape back to the domain shape. */
const asChannel = (record: ChannelRecord): Channel => ({
  id: record.id,
  name: record.name,
  gpRateBp: record.gpRateBp,
  gpBasis: record.gpBasis,
  gpAppliesTo: record.gpAppliesTo,
  gpVatRateBp: record.gpVatRateBp,
  whtRateBp: record.whtRateBp,
  requiresDeliveryPackaging: record.requiresDeliveryPackaging,
  active: record.active,
});

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
  readonly byChannel: readonly ChannelPerformance[];
  readonly pricingAnswers: readonly ItemPricingAnswer[];
}

/** A break-even answer, tied to the drink it is about. */
export interface ItemPricingAnswer extends PricingAnswer {
  readonly menuItemId: string;
  readonly menuItemName: string;
}

/**
 * Build the per-channel view: contribution after commission, plus a
 * break-even answer for every delivery channel.
 *
 * The reference for "break even" is what the same drink contributes at the
 * counter, so the question being answered is the one PLAN.md poses — should I
 * raise my Grab price — rather than an abstract margin target.
 */
async function buildChannelView(
  sales: readonly SaleRecord[],
  lines: readonly SaleLineRecord[],
  voidedSaleIds: ReadonlySet<string>,
  vatRegistered: boolean,
): Promise<{
  byChannel: readonly ChannelPerformance[];
  pricingAnswers: readonly ItemPricingAnswer[];
}> {
  const [channelRecords, ingredients, menuItems, priceRows] = await Promise.all([
    db.channels.toArray(),
    db.ingredients.toArray(),
    db.menu_items.orderBy("sortOrder").toArray(),
    db.channel_prices.toArray(),
  ]);
  const channels: Channel[] = channelRecords.map(asChannel);
  const packagingIds = new Set(ingredients.filter((i) => i.isPackaging).map((i) => i.id));

  const linesBySale = new Map<string, SaleLineRecord[]>();
  for (const line of lines) {
    const list = linesBySale.get(line.saleId) ?? [];
    list.push(line);
    linesBySale.set(line.saleId, list);
  }

  const channelSales: ChannelSale[] = sales
    .filter((sale) => !voidedSaleIds.has(sale.id))
    .map((sale) => {
      const saleLines = linesBySale.get(sale.id) ?? [];
      // Packaging is split out only for reporting; settle() adds them back.
      const packaging = sum(
        saleLines
          .filter((l) => packagingIds.has(l.menuItemId))
          .map((l) => satang(l.cogsSatang ?? 0)),
      );
      const totalCost = sum(saleLines.map((l) => satang(l.cogsSatang ?? 0)));
      return {
        saleId: sale.id,
        channelId: sale.channelId ?? WALK_IN.id,
        listPrice: satang(sale.grossSatang),
        merchantFundedDiscount: satang(sale.merchantFundedDiscountSatang ?? 0),
        ingredientCost: satang(totalCost - packaging),
        packagingCost: packaging,
        costComplete: saleLines.every((l) => l.cogsSatang != null),
      };
    });

  const byChannel = performanceByChannel(channelSales, channels, {
    vatRegistered,
    vatRateBp: sales[0]?.rateBp ?? 0,
  });

  // Break-even is answered against the flagship item on each delivery channel.
  const walkIn = channels.find((c) => c.id === WALK_IN.id);
  const pricingAnswers: ItemPricingAnswer[] = [];

  if (walkIn) {
    const costs = await unitCostMap();
    const recipeLines = await db.recipe_lines.toArray();

    for (const channel of channels.filter((c) => c.id !== WALK_IN.id && c.active)) {
      for (const item of menuItems) {
        const counterRecipe = resolveRecipe(recipeLines, item.id, WALK_IN.id);
        const channelRecipe = resolveRecipe(recipeLines, item.id, channel.id);
        if (channelRecipe.length === 0) continue;

        const splitFor = (recipe: typeof channelRecipe) => {
          let ingredient = 0;
          let packaging = 0;
          for (const req of recipe) {
            const unit = costs.get(req.ingredientId);
            if (unit === undefined) continue;
            const cost = costOf(req.qty, unit);
            if (packagingIds.has(req.ingredientId)) packaging += cost;
            else ingredient += cost;
          }
          return { ingredientCost: satang(ingredient), packagingCost: satang(packaging) };
        };

        const base = { vatRegistered, vatRateBp: 0, merchantFundedDiscount: satang(0) };
        const target = counterContribution(walkIn, satang(item.priceSatang), {
          ...base,
          ...splitFor(counterRecipe),
        });

        const listed = priceRows.find(
          (p) => p.menuItemId === item.id && p.channelId === channel.id && p.validTo === null,
        );
        const currentPrice = satang(listed?.priceSatang ?? item.priceSatang);

        pricingAnswers.push({
          ...answerPricingQuestion(channel, currentPrice, target, {
            ...base,
            ...splitFor(channelRecipe),
          }),
          menuItemId: item.id,
          menuItemName: item.name,
        });
      }
    }
  }

  return { byChannel, pricingAnswers };
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

  const voidedSaleIds = new Set(report.voids.map((v) => v.saleId));
  const device = await db.device_config.get("device");
  const { byChannel, pricingAnswers } = await buildChannelView(
    sales,
    lines,
    voidedSaleIds,
    device?.vatRegistered ?? false,
  );

  return {
    report,
    audit,
    byChannel,
    pricingAnswers,
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
