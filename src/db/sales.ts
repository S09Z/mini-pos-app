/**
 * sales.ts — the one path that writes a sale.
 *
 * Wires the pure domain layer (rateAt, computeDocumentVat, settle) to local
 * storage. Three things are resolved once, here, and frozen onto the record:
 * the VAT rate and its authority, the cost of goods, and — on a delivery
 * channel — the platform commission. Nothing downstream ever recomputes any
 * of them at today's values. See CLAUDE.md rule 5.
 *
 * The channel is threaded through everything: the price came from the
 * channel's price list, the recipe is resolved against the channel so delivery
 * packaging is consumed, and the settlement uses the channel's contract terms.
 */

import { satang, scale, sub, sum, type Satang } from "../money.js";
import { rateAt } from "../tax/rates.js";
import { computeDocumentVat, type DocumentLineInput } from "../tax/vat.js";
import {
  db,
  type SaleRecord,
  type SaleLineRecord,
  type ChannelRecord,
  type PlatformFeeRecord,
} from "./schema.js";
import { nextReceiptNumber } from "./receipts.js";
import { registrationStateAt } from "./tax.js";
import { depleteForSale, unitCostMap } from "./stock.js";
import { resolveRecipe } from "../stock/recipe.js";
import { costOf, costOfGoods, type UnitCost } from "../stock/costing.js";
import { scaleQty } from "../stock/units.js";
import { settle } from "../channel/settlement.js";
import { priceFor } from "../channel/pricing.js";
import { WALK_IN, type Channel, type ChannelPrice } from "../channel/types.js";

export class CheckoutError extends Error {
  override readonly name = "CheckoutError";
}

export interface CartLine {
  readonly menuItemId: string;
  readonly name: string;
  readonly unitPriceSatang: Satang;
  readonly qty: number;
}

export interface CheckoutOptions {
  readonly channelId?: string;
  /** The platform's order reference, keyed from their tablet. */
  readonly platformOrderId?: string;
  readonly merchantFundedDiscount?: Satang;
}

export interface CheckoutResult {
  readonly sale: SaleRecord;
  readonly lines: readonly SaleLineRecord[];
  readonly platformFee: PlatformFeeRecord | null;
}

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

export async function checkout(
  cart: readonly CartLine[],
  tenderedSatang: Satang,
  options: CheckoutOptions = {},
): Promise<CheckoutResult> {
  if (cart.length === 0) throw new CheckoutError("Cannot check out an empty ticket");

  const device = await db.device_config.get("device");
  if (!device) throw new CheckoutError("Device config missing — run seedIfEmpty() first");

  const channelId = options.channelId ?? WALK_IN.id;
  const channelRecord = await db.channels.get(channelId);
  if (!channelRecord) throw new CheckoutError(`Unknown channel "${channelId}"`);
  const channel = asChannel(channelRecord);

  // A delivery order without its platform reference cannot be reconciled to a
  // payout in Phase 5, and the reference is unrecoverable once the platform
  // tablet moves on. Better to refuse the sale than to book an orphan.
  const isDelivery = channel.id !== WALK_IN.id;
  const platformOrderId = options.platformOrderId?.trim() ?? "";
  if (isDelivery && platformOrderId === "") {
    throw new CheckoutError(`${channel.name} orders need the platform order number`);
  }

  const merchantFundedDiscount = options.merchantFundedDiscount ?? satang(0);
  if (merchantFundedDiscount < 0) throw new CheckoutError("Discount cannot be negative");

  const now = new Date();
  const rate = rateAt("VAT_TH", now);

  // Resolved from the registration ledger at the instant of sale, not from a
  // stored flag: a registration entered today with next month's effective date
  // must not start charging VAT today. Both this and the rate are frozen onto
  // the record below, so the receipt reprints under the rules that applied.
  const registration = await registrationStateAt(now);

  // Belt and braces on the channel's own rule: refuse a ticket priced for a
  // different channel. The UI already blocks the window where a stale price
  // map could be tapped, but "impossible to ring a delivery order at counter
  // prices" is worth enforcing where the write actually happens rather than
  // trusting every future caller to have got the ordering right.
  await assertPricedForChannel(cart, channel.id, now);

  const listTotal = sum(cart.map((l) => scale(l.unitPriceSatang, l.qty)));
  if (merchantFundedDiscount > listTotal) {
    throw new CheckoutError("Discount exceeds the ticket total");
  }

  const docLines: DocumentLineInput[] = cart.map((l) => ({
    lineId: l.menuItemId,
    gross: scale(l.unitPriceSatang, l.qty),
  }));
  const doc = computeDocumentVat(docLines, {
    rateBp: rate.rateBp,
    vatRegistered: registration.registered,
  });

  const dueFromCustomer = satang(doc.gross - merchantFundedDiscount);

  // A delivery order is settled by the platform, not tendered at the counter,
  // so there is no cash to check against.
  if (!isDelivery && tenderedSatang < dueFromCustomer) {
    throw new CheckoutError("Amount tendered is less than the total due");
  }

  const receiptNo = await nextReceiptNumber();
  const saleId = crypto.randomUUID();

  const sale: SaleRecord = {
    id: saleId,
    receiptNo,
    createdAt: now.toISOString(),
    grossSatang: doc.gross,
    netSatang: doc.net,
    vatSatang: doc.vat,
    rateBp: doc.rateBp,
    authority: rate.authority,
    provisional: rate.provisional,
    vatRegistered: doc.vatRegistered,
    taxInvoiceEligible: doc.taxInvoiceEligible,
    tenderedSatang: isDelivery ? dueFromCustomer : tenderedSatang,
    changeSatang: isDelivery ? satang(0) : sub(tenderedSatang, dueFromCustomer),
    channelId: channel.id,
    platformOrderId: isDelivery ? platformOrderId : null,
    merchantFundedDiscountSatang: merchantFundedDiscount,
  };

  const [recipeLines, costs, ingredients] = await Promise.all([
    db.recipe_lines.toArray(),
    unitCostMap(),
    db.ingredients.toArray(),
  ]);
  const packagingIds = new Set(ingredients.filter((i) => i.isPackaging).map((i) => i.id));

  const lines: SaleLineRecord[] = cart.map((cartLine, i) => {
    const docLine = doc.lines[i]!;
    // Resolved against the channel, so a delivery order costs its lid and bag.
    const recipe = resolveRecipe(recipeLines, cartLine.menuItemId, channel.id);
    const cogsSatang =
      recipe.length === 0
        ? null
        : costOfGoods(
            recipe.map((req) => ({
              ingredientId: req.ingredientId,
              qty: scaleQty(req.qty, cartLine.qty),
            })),
            costs,
          );

    return {
      id: crypto.randomUUID(),
      saleId,
      menuItemId: cartLine.menuItemId,
      name: cartLine.name,
      unitPriceSatang: cartLine.unitPriceSatang,
      qty: cartLine.qty,
      grossSatang: docLine.gross,
      netSatang: docLine.net,
      vatSatang: docLine.vat,
      cogsSatang,
    };
  });

  // Commission is frozen with the same argument as VAT and cost: renegotiating
  // GP next quarter must not restate what this order actually earned.
  let platformFee: PlatformFeeRecord | null = null;
  if (isDelivery) {
    const split = splitCost(cart, recipeLines, costs, packagingIds, channel.id);
    const settlement = settle({
      channel,
      listPrice: doc.gross,
      merchantFundedDiscount,
      ingredientCost: split.ingredient,
      packagingCost: split.packaging,
      vatRegistered: doc.vatRegistered,
      vatRateBp: doc.rateBp,
    });

    platformFee = {
      saleId,
      channelId: channel.id,
      platformOrderId,
      gpAmountSatang: settlement.gpAmount,
      gpVatSatang: settlement.gpVat,
      whtSatang: settlement.wht,
      merchantFundedDiscountSatang: merchantFundedDiscount,
      netPayoutSatang: settlement.netPayout,
      gpRateBp: channel.gpRateBp,
      gpBasis: channel.gpBasis,
      gpAppliesTo: channel.gpAppliesTo,
      payoutBatchId: null,
    };
  }

  // Sale, lines, depletion and commission all land together: a sale that
  // booked without its depletion would put the stock count wrong in a way no
  // later reconciliation could explain, and one without its fee record would
  // be invisible to Phase 5's payout matching.
  await db.transaction(
    "rw",
    [db.sales, db.sale_lines, db.ingredients, db.stock_movements, db.recipe_lines, db.platform_fees],
    async () => {
      await db.sales.add(sale);
      await db.sale_lines.bulkAdd(lines);
      await depleteForSale(
        cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty })),
        saleId,
        sale.createdAt,
        channel.id,
      );
      if (platformFee) await db.platform_fees.add(platformFee);
    },
  );

  return { sale, lines, platformFee };
}

/**
 * Refuse a cart whose line prices are not the channel's current prices.
 *
 * The failure this prevents is silent and expensive: a delivery order rung at
 * counter prices looks completely normal on the receipt and surfaces a month
 * later as a channel that mysteriously lost money.
 */
async function assertPricedForChannel(
  cart: readonly CartLine[],
  channelId: string,
  at: Date,
): Promise<void> {
  const [menuItems, priceRows] = await Promise.all([
    db.menu_items.toArray(),
    db.channel_prices.toArray(),
  ]);
  const baseById = new Map(menuItems.map((m) => [m.id, m.priceSatang]));
  const domainPrices: ChannelPrice[] = priceRows.map((r) => ({
    menuItemId: r.menuItemId,
    channelId: r.channelId,
    price: satang(r.priceSatang),
    validFrom: r.validFrom,
    validTo: r.validTo,
  }));

  for (const line of cart) {
    const base = baseById.get(line.menuItemId);
    if (base === undefined) continue; // unmodelled item; nothing to compare against
    const expected = priceFor(domainPrices, line.menuItemId, channelId, satang(base), at);
    if (expected.price !== line.unitPriceSatang) {
      throw new CheckoutError(
        `${line.name} is priced ${line.unitPriceSatang} but this channel lists it at ${expected.price}. Clear the ticket and re-add it.`,
      );
    }
  }
}

/**
 * Split a ticket's cost into ingredients and packaging.
 *
 * `settle()` adds the two back together, so this changes no arithmetic — but
 * reporting them apart is how you notice that delivery's extra wrapping, not
 * the commission, is what ate the markup.
 */
function splitCost(
  cart: readonly CartLine[],
  recipeLines: readonly { menuItemId: string; ingredientId: string; qty: number; channelId: string | null }[],
  costs: ReadonlyMap<string, UnitCost>,
  packagingIds: ReadonlySet<string>,
  channelId: string,
): { ingredient: Satang; packaging: Satang } {
  let ingredient = 0;
  let packaging = 0;

  for (const cartLine of cart) {
    for (const req of resolveRecipe(recipeLines, cartLine.menuItemId, channelId)) {
      const unit = costs.get(req.ingredientId);
      if (unit === undefined) continue;
      const lineCost = costOf(scaleQty(req.qty, cartLine.qty), unit);
      if (packagingIds.has(req.ingredientId)) packaging += lineCost;
      else ingredient += lineCost;
    }
  }
  return { ingredient: satang(ingredient), packaging: satang(packaging) };
}
