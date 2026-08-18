/**
 * types.ts — sales channel and platform commission (GP) schema.
 *
 * The modelling insight: the same drink is a different product economically
 * per channel. Delivery list prices are marked up to absorb GP, packaging
 * differs, and the fee structure is entirely separate. So `channelId` is a
 * first-class dimension on every sale, not a tag.
 *
 * Several fields here are deliberately configurable rather than hardcoded
 * because platform contracts differ and change: whether GP is charged on the
 * VAT-inclusive or ex-VAT amount, and whether it is charged before or after a
 * merchant-funded discount. Read your actual contract and set them; do not
 * assume the defaults match your deal.
 */

import type { Satang, BasisPoints } from "../money.js";

export type ChannelId = string;

/** Is the platform's commission computed on the gross (VAT-inclusive) or net figure? */
export type GpBasis = "GROSS" | "NET";

/** Is commission charged on the list price, or on the price after a discount? */
export type GpAppliesTo = "LIST_PRICE" | "DISCOUNTED_PRICE";

export interface Channel {
  readonly id: ChannelId;
  readonly name: string;
  /** Commission rate. 3000 = 30.00%. Zero for walk-in. */
  readonly gpRateBp: BasisPoints;
  readonly gpBasis: GpBasis;
  readonly gpAppliesTo: GpAppliesTo;
  /**
   * VAT the platform charges on top of its commission. This is *input* VAT and
   * is reclaimable once you are registered — one of the few ways registration
   * improves delivery margin.
   */
  readonly gpVatRateBp: BasisPoints;
  /**
   * Withholding tax deducted from the service fee, typically 300 (3%).
   * Whether it applies depends on your legal form — record what the statement
   * actually shows rather than trusting this figure.
   */
  readonly whtRateBp: BasisPoints;
  /** Delivery channels need their own packaging BOM. */
  readonly requiresDeliveryPackaging: boolean;
  readonly active: boolean;
}

export const WALK_IN: Channel = {
  id: "WALK_IN",
  name: "Walk-in",
  gpRateBp: 0,
  gpBasis: "GROSS",
  gpAppliesTo: "LIST_PRICE",
  gpVatRateBp: 0,
  whtRateBp: 0,
  requiresDeliveryPackaging: false,
  active: true,
};

/**
 * Example delivery channel. The 30% is illustrative — GP varies by contract,
 * by merchant tier, and by whether you have opted into platform promotions.
 */
export const GRAB: Channel = {
  id: "GRAB",
  name: "GrabFood",
  gpRateBp: 3000,
  gpBasis: "GROSS",
  gpAppliesTo: "LIST_PRICE",
  gpVatRateBp: 700,
  whtRateBp: 300,
  requiresDeliveryPackaging: true,
  active: true,
};

/** Per-channel pricing. A drink has one price per channel, not one price. */
export interface ChannelPrice {
  readonly menuItemId: string;
  readonly channelId: ChannelId;
  /** VAT-inclusive list price on that channel. */
  readonly price: Satang;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * Recipe line with an optional channel override. `channelId: null` applies
 * everywhere; a specific channel adds or replaces for that channel only —
 * this is how sealed cups and carrier bags get counted on delivery orders
 * without polluting walk-in COGS.
 */
export interface RecipeLine {
  readonly menuItemId: string;
  readonly ingredientId: string;
  readonly qty: number;
  readonly channelId: ChannelId | null;
}

/** One immutable fee record per platform order, matched at reconciliation. */
export interface PlatformFeeRecord {
  readonly saleId: string;
  readonly channelId: ChannelId;
  readonly platformOrderId: string;
  readonly gpAmount: Satang;
  readonly gpVat: Satang;
  readonly wht: Satang;
  /**
   * Promotions are sometimes co-funded and sometimes entirely on the merchant.
   * Split out, or revenue will never reconcile to the payout.
   */
  readonly merchantFundedDiscount: Satang;
  readonly netPayout: Satang;
  readonly payoutBatchId: string | null;
}
