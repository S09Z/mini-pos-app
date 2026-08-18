/**
 * settlement.ts — what a sale is actually worth, per channel.
 *
 * This is the module that answers the question the dashboard should lead with:
 * not "how much did we sell" but "how much did we keep".
 *
 * The VAT registration flag changes the whole shape of the calculation:
 *
 *   Registered   — revenue is recognised net of output VAT; VAT on commission
 *                  and on supplies is reclaimable input VAT, so costs are taken
 *                  ex-VAT. You remit 7% of counter takings you used to keep,
 *                  but you claw back the VAT on GP.
 *   Unregistered — you keep the full gross, but every VAT you pay on commission
 *                  and supplies is a real, unrecoverable cost.
 *
 * Which is better depends on your channel mix, which is precisely why this
 * should be computed from real data rather than guessed at.
 */

import { satang, sum, type Satang } from "../money.js";
import { extractInclusive } from "../tax/vat.js";
import type { Channel } from "./types.js";

export class SettlementError extends Error {
  override readonly name = "SettlementError";
}

export interface SettlementInput {
  readonly channel: Channel;
  /** VAT-inclusive list price shown to the customer on this channel. */
  readonly listPrice: Satang;
  /** Discount funded by you, not the platform. Positive number. */
  readonly merchantFundedDiscount?: Satang;
  /** Ingredient cost, VAT-inclusive as you paid it. */
  readonly ingredientCost: Satang;
  /** Packaging cost, VAT-inclusive. Delivery packaging is the expensive one. */
  readonly packagingCost: Satang;
  readonly vatRegistered: boolean;
  readonly vatRateBp: number;
}

export interface Settlement {
  readonly customerPaid: Satang;
  readonly outputVat: Satang;
  readonly netRevenue: Satang;
  readonly gpBase: Satang;
  readonly gpAmount: Satang;
  readonly gpVat: Satang;
  readonly wht: Satang;
  /** What actually lands in the bank from the platform. */
  readonly netPayout: Satang;
  /** VAT on commission plus VAT on supplies, recoverable only if registered. */
  readonly reclaimableInputVat: Satang;
  readonly costOfGoods: Satang;
  /** Revenue less commission less cost. The number that matters. */
  readonly contribution: Satang;
  /** Contribution as basis points of what the customer paid. */
  readonly contributionMarginBp: number;
}

export function settle(input: SettlementInput): Settlement {
  const {
    channel, listPrice, ingredientCost, packagingCost, vatRegistered, vatRateBp,
  } = input;
  const discount = input.merchantFundedDiscount ?? satang(0);

  if (listPrice < 0) throw new SettlementError("listPrice cannot be negative");
  if (discount < 0) throw new SettlementError("merchantFundedDiscount must be positive");
  if (discount > listPrice) throw new SettlementError("Discount exceeds list price");

  const customerPaid = satang(listPrice - discount);

  // --- Output VAT on the sale to the end customer ---------------------------
  // On a delivery order you remain the seller of the food; the platform sells
  // you a service. So output VAT is on the full amount the customer paid.
  const saleSplit = vatRegistered
    ? extractInclusive(customerPaid, vatRateBp)
    : { net: customerPaid, vat: satang(0), gross: customerPaid, rateBp: 0 };

  const outputVat = saleSplit.vat;
  const netRevenue = saleSplit.net;

  // --- Platform commission --------------------------------------------------
  const gpOn = channel.gpAppliesTo === "LIST_PRICE" ? listPrice : customerPaid;
  const gpBase =
    channel.gpBasis === "GROSS" ? gpOn : extractInclusive(gpOn, vatRateBp).net;

  const gpAmount = satang(Math.round((gpBase * channel.gpRateBp) / 10_000));
  const gpVat = satang(Math.round((gpAmount * channel.gpVatRateBp) / 10_000));
  const wht = satang(Math.round((gpAmount * channel.whtRateBp) / 10_000));

  // WHT is withheld from what you owe the platform, so it increases your payout
  // while creating a remittance liability to the Revenue Department.
  const netPayout = satang(customerPaid - gpAmount - gpVat + wht);

  // --- Costs ----------------------------------------------------------------
  const grossCost = satang(ingredientCost + packagingCost);
  const supplyInputVat = vatRegistered ? extractInclusive(grossCost, vatRateBp).vat : satang(0);
  const costOfGoods = satang(grossCost - supplyInputVat);
  const reclaimableInputVat = vatRegistered ? satang(gpVat + supplyInputVat) : satang(0);

  // --- Contribution ---------------------------------------------------------
  // Unregistered: gpVat is a real cost, so it stays in. Registered: it is
  // reclaimed, so it is excluded and costs are taken ex-VAT.
  const irrecoverableGpVat = vatRegistered ? satang(0) : gpVat;
  const contribution = satang(
    netRevenue - gpAmount - irrecoverableGpVat - costOfGoods,
  );

  const contributionMarginBp =
    customerPaid === 0 ? 0 : Math.round((contribution * 10_000) / customerPaid);

  return {
    customerPaid, outputVat, netRevenue, gpBase, gpAmount, gpVat, wht,
    netPayout, reclaimableInputVat, costOfGoods, contribution, contributionMarginBp,
  };
}

export interface ChannelComparison {
  readonly channelId: string;
  readonly channelName: string;
  readonly settlement: Settlement;
}

/**
 * Compare the same drink across channels. Sort by contribution, never by
 * revenue — delivery volume can grow while profit shrinks, and a revenue-sorted
 * dashboard hides exactly that.
 */
export function compareChannels(
  inputs: readonly SettlementInput[],
): readonly ChannelComparison[] {
  return inputs
    .map((i) => ({
      channelId: i.channel.id,
      channelName: i.channel.name,
      settlement: settle(i),
    }))
    .sort((a, b) => b.settlement.contribution - a.settlement.contribution);
}

/**
 * The delivery pricing question in reverse: what must a drink list at on a
 * platform to earn the same contribution it earns at the counter?
 *
 * Solved by bisection rather than algebra because the rounding steps make the
 * function non-continuous — an exact closed form would be off by a satang.
 */
export function breakEvenListPrice(
  target: Satang,
  template: Omit<SettlementInput, "listPrice">,
  maxPrice: Satang = satang(1_000_00),
): Satang | null {
  let lo = 0;
  let hi: number = maxPrice;
  if (settle({ ...template, listPrice: satang(hi) }).contribution < target) return null;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (settle({ ...template, listPrice: satang(mid) }).contribution >= target) hi = mid;
    else lo = mid + 1;
  }
  return satang(lo);
}

/** Aggregate a day's settlements for the dashboard. */
export function summarise(settlements: readonly Settlement[]): {
  readonly customerPaid: Satang;
  readonly outputVat: Satang;
  readonly gpAmount: Satang;
  readonly contribution: Satang;
  readonly reclaimableInputVat: Satang;
} {
  return {
    customerPaid: sum(settlements.map((s) => s.customerPaid)),
    outputVat: sum(settlements.map((s) => s.outputVat)),
    gpAmount: sum(settlements.map((s) => s.gpAmount)),
    contribution: sum(settlements.map((s) => s.contribution)),
    reclaimableInputVat: sum(settlements.map((s) => s.reclaimableInputVat)),
  };
}
