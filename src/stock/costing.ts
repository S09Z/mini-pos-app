/**
 * costing.ts — what an ingredient costs, kept current as prices move.
 *
 * PLAN.md wants purchase entry "so cost-per-unit stays current". The reason it
 * matters is Phase 3 and 4: contribution margin is revenue minus *cost*, and a
 * cost figure keyed in once when the stall opened will quietly overstate
 * margin for as long as matcha prices rise.
 *
 * Weighted average rather than FIFO. FIFO is more accurate when prices move
 * sharply, but it requires tracking every purchase lot through to consumption,
 * and a one-person stall decanting a new bag into a half-full tin is not
 * running lots in any meaningful sense — the physical reality is a blend, and
 * weighted average is what the physical reality actually is.
 *
 * Unit of account: **millisatang per display unit** (satang × 1000 per g/ml/
 * piece). Matcha at ฿2,000/100g is 2,000 satang/g, so 2,000,000 here. The
 * extra three digits exist because bulk ingredients get genuinely cheap per
 * unit — sugar at ฿30/kg is 0.003 satang per gram, which rounds to nothing
 * without them.
 */

import { satang, type Satang } from "../money.js";
import { type Quantity, MILLI } from "./units.js";

export class CostingError extends Error {
  override readonly name = "CostingError";
}

/**
 * Cost in millisatang per display unit. Integer, for the same reason money and
 * quantities are integers.
 */
export type UnitCost = number;

/** Millisatang per display unit, per satang per milli-unit. */
const UNIT_COST_SCALE = MILLI * MILLI;

/**
 * Round half away from zero.
 *
 * `Math.round` rounds half toward +Infinity, so -0.5 becomes -0 rather than
 * -1. CLAUDE.md requires half-away-from-zero on money so that a reversal is
 * the exact negation of the thing it reverses; the same applies to a costed
 * void restock.
 */
function roundHalfAwayFromZero(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(x));
}

export function unitCost(n: number): UnitCost {
  if (!Number.isFinite(n)) throw new CostingError(`Not a finite unit cost: ${n}`);
  if (!Number.isInteger(n)) throw new CostingError(`Unit cost must be a whole number of millisatang, got ${n}`);
  if (n < 0) throw new CostingError(`Unit cost cannot be negative, got ${n}`);
  return n;
}

/**
 * Cost per display unit implied by a purchase: total paid ÷ amount received.
 */
export function unitCostOfPurchase(totalCost: Satang, qty: Quantity): UnitCost {
  if (qty <= 0) throw new CostingError("Cannot derive a unit cost from a non-positive quantity");
  if (totalCost < 0) throw new CostingError("Purchase cost cannot be negative");
  return unitCost(roundHalfAwayFromZero((totalCost * UNIT_COST_SCALE) / qty));
}

/**
 * Blend a new purchase into the running average.
 *
 * When there is nothing on hand — a first purchase, or a tin that ran dry —
 * the new price simply becomes the average. Carrying a stale average across a
 * gap in stock would price the next sale off a bag that no longer exists, and
 * a negative on-hand (an unrecorded purchase, which Phase 2 exists to surface)
 * must not be allowed to drag the average around either.
 */
export function blendCost(
  onHandBefore: Quantity,
  currentCost: UnitCost,
  purchasedQty: Quantity,
  purchasedTotalCost: Satang,
): UnitCost {
  if (purchasedQty <= 0) throw new CostingError("Purchased quantity must be positive");
  const incoming = unitCostOfPurchase(purchasedTotalCost, purchasedQty);

  if (onHandBefore <= 0) return incoming;

  const blended =
    (onHandBefore * currentCost + purchasedQty * incoming) / (onHandBefore + purchasedQty);
  return unitCost(roundHalfAwayFromZero(blended));
}

/** What a given amount of one ingredient is worth. */
export function costOf(qty: Quantity, cost: UnitCost): Satang {
  return satang(roundHalfAwayFromZero((qty * cost) / UNIT_COST_SCALE));
}

export interface CostedRequirement {
  readonly ingredientId: string;
  readonly qty: Quantity;
}

/**
 * Cost of goods for a drink or a whole ticket.
 *
 * Costed per ingredient and then summed, which is the opposite of the rule VAT
 * follows — and deliberately so. VAT must tie to a document total that the
 * customer was charged, so it is extracted once and allocated down. COGS has
 * no such external total to tie to; each ingredient genuinely has its own
 * price, and summing the parts *is* the correct total.
 *
 * An ingredient with no known cost contributes zero rather than throwing. A
 * missing cost is a reporting gap, and blocking a sale over one would break
 * the rule that the sale path never depends on reference data being complete.
 */
export function costOfGoods(
  requirements: readonly CostedRequirement[],
  costs: ReadonlyMap<string, UnitCost>,
): Satang {
  let total = 0;
  for (const req of requirements) {
    const cost = costs.get(req.ingredientId);
    if (cost === undefined) continue;
    total += costOf(req.qty, cost);
  }
  return satang(total);
}

/** Value of everything on hand — what is sitting in the tins, in money. */
export function stockValue(
  onHand: ReadonlyMap<string, Quantity>,
  costs: ReadonlyMap<string, UnitCost>,
): Satang {
  let total = 0;
  for (const [ingredientId, qty] of onHand) {
    const cost = costs.get(ingredientId);
    if (cost === undefined) continue;
    total += costOf(qty, cost);
  }
  return satang(total);
}
