/**
 * analysis.ts — is this channel worth serving?
 *
 * `settlement.ts` already answers that for a single drink. This wires it to a
 * day's sales so the dashboard can answer it for the business, and it enforces
 * the one ordering rule PLAN.md states twice: **sorted by contribution and
 * never by revenue.** Delivery volume can grow while profit shrinks, and a
 * revenue-sorted dashboard hides exactly that.
 *
 * Phase 3 reports contribution *before* commission, because a counter sale has
 * none. Here the same sale is taken further: commission, its VAT, and
 * withholding are applied to get what actually reaches the bank. The two
 * numbers differ on delivery channels and they are supposed to.
 *
 * **The number to distrust here is not the arithmetic.** It is
 * `gpBasis` / `gpAppliesTo`, which default to the harsher contract reading.
 * PLAN.md names trusting those defaults as this phase's risk, so every result
 * carries the reading it was computed under.
 */

import { satang, sum, type Satang } from "../money.js";
import { settle, breakEvenListPrice, type Settlement, type SettlementInput } from "./settlement.js";
import type { Channel, ChannelId } from "./types.js";

export class ChannelAnalysisError extends Error {
  override readonly name = "ChannelAnalysisError";
}

/** One sale, reduced to what a settlement needs. */
export interface ChannelSale {
  readonly saleId: string;
  readonly channelId: ChannelId;
  readonly listPrice: Satang;
  readonly merchantFundedDiscount: Satang;
  readonly ingredientCost: Satang;
  readonly packagingCost: Satang;
  /** `false` when any line of the sale had no frozen cost. */
  readonly costComplete: boolean;
}

export interface ChannelPerformance {
  readonly channelId: ChannelId;
  readonly channelName: string;
  readonly saleCount: number;
  readonly customerPaid: Satang;
  readonly gpAmount: Satang;
  readonly gpVat: Satang;
  readonly wht: Satang;
  readonly netPayout: Satang;
  readonly costOfGoods: Satang;
  readonly contribution: Satang;
  /** Contribution per sale — what one more order on this channel is worth. */
  readonly contributionPerSale: Satang;
  /** `null` when any sale on the channel lacked a frozen cost. */
  readonly contributionMarginBp: number | null;
  readonly costComplete: boolean;
  /** The contract reading this was computed under. Never let it go unstated. */
  readonly gpBasis: Channel["gpBasis"];
  readonly gpAppliesTo: Channel["gpAppliesTo"];
  readonly gpRateBp: number;
}

/**
 * Roll a day's sales up by channel.
 *
 * Sales on a channel with no definition are dropped rather than guessed at —
 * a commission rate invented by the reporting layer is worse than a missing
 * row, because it looks authoritative.
 */
export function performanceByChannel(
  sales: readonly ChannelSale[],
  channels: readonly Channel[],
  opts: { vatRegistered: boolean; vatRateBp: number },
): readonly ChannelPerformance[] {
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const byChannel = new Map<ChannelId, ChannelSale[]>();

  for (const sale of sales) {
    if (!channelById.has(sale.channelId)) continue;
    const list = byChannel.get(sale.channelId) ?? [];
    list.push(sale);
    byChannel.set(sale.channelId, list);
  }

  const out: ChannelPerformance[] = [];

  for (const [channelId, channelSales] of byChannel) {
    const channel = channelById.get(channelId)!;
    const settlements = channelSales.map((sale) =>
      settle({
        channel,
        listPrice: sale.listPrice,
        merchantFundedDiscount: sale.merchantFundedDiscount,
        ingredientCost: sale.ingredientCost,
        packagingCost: sale.packagingCost,
        vatRegistered: opts.vatRegistered,
        vatRateBp: opts.vatRateBp,
      }),
    );

    const costComplete = channelSales.every((s) => s.costComplete);
    const customerPaid = sum(settlements.map((s) => s.customerPaid));
    const contribution = sum(settlements.map((s) => s.contribution));

    out.push({
      channelId,
      channelName: channel.name,
      saleCount: channelSales.length,
      customerPaid,
      gpAmount: sum(settlements.map((s) => s.gpAmount)),
      gpVat: sum(settlements.map((s) => s.gpVat)),
      wht: sum(settlements.map((s) => s.wht)),
      netPayout: sum(settlements.map((s) => s.netPayout)),
      costOfGoods: sum(settlements.map((s) => s.costOfGoods)),
      contribution,
      contributionPerSale:
        channelSales.length === 0
          ? satang(0)
          : satang(Math.round(contribution / channelSales.length)),
      contributionMarginBp:
        !costComplete || customerPaid === 0
          ? null
          : Math.round((contribution * 10_000) / customerPaid),
      costComplete,
      gpBasis: channel.gpBasis,
      gpAppliesTo: channel.gpAppliesTo,
      gpRateBp: channel.gpRateBp,
    });
  }

  // Contribution, never revenue. A channel can top the revenue table and sit
  // at the bottom of this one.
  return out.sort((a, b) => b.contribution - a.contribution);
}

export interface PricingAnswer {
  readonly channelId: ChannelId;
  readonly channelName: string;
  readonly currentListPrice: Satang;
  readonly currentContribution: Satang;
  /** Contribution this drink earns at the counter — the bar delivery must clear. */
  readonly targetContribution: Satang;
  /** List price needed to match the counter. `null` if unreachable. */
  readonly breakEvenListPrice: Satang | null;
  /** How much the price would have to move. `null` when unreachable. */
  readonly shortfall: Satang | null;
  readonly alreadyClears: boolean;
}

/**
 * "Should I raise my Grab price?" — with a number.
 *
 * The target is what the same drink contributes at the counter, so the answer
 * is "this is what delivery must list at to be worth the same as a walk-in
 * customer" rather than an abstract margin goal.
 */
export function answerPricingQuestion(
  channel: Channel,
  currentListPrice: Satang,
  targetContribution: Satang,
  template: Omit<SettlementInput, "listPrice" | "channel">,
): PricingAnswer {
  const current = settle({ ...template, channel, listPrice: currentListPrice });
  const breakEven = breakEvenListPrice(targetContribution, { ...template, channel });

  return {
    channelId: channel.id,
    channelName: channel.name,
    currentListPrice,
    currentContribution: current.contribution,
    targetContribution,
    breakEvenListPrice: breakEven,
    shortfall: breakEven === null ? null : satang(breakEven - currentListPrice),
    alreadyClears: current.contribution >= targetContribution,
  };
}

/** Contribution a drink earns at the counter — the reference the answer uses. */
export function counterContribution(
  walkIn: Channel,
  listPrice: Satang,
  template: Omit<SettlementInput, "listPrice" | "channel">,
): Satang {
  const settlement: Settlement = settle({ ...template, channel: walkIn, listPrice });
  return settlement.contribution;
}
