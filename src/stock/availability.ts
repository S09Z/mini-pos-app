/**
 * availability.ts — what the sell screen needs to know about stock.
 *
 * Turns "you do not stock lattes" back into something a menu tile can render.
 * The operator does not want to be told the milk is low; they want to be told
 * *the latte* is about to become a problem, while there is still time to say
 * so to the customer.
 *
 * Kept separate from `ledger.ts` because this is a read-side projection with
 * no business writing anything, and separate from `recipe.ts` because it is
 * the one place recipe and stock levels meet.
 */

import { type Quantity, ZERO_QTY } from "./units.js";
import { stockStatus, type StockStatus } from "./ledger.js";
import { maxProducible, type Requirement } from "./recipe.js";

export interface MenuItemStock {
  readonly status: StockStatus;
  /** How many more of this drink the current stock covers. `Infinity` when unmodelled. */
  readonly maxProducible: number;
  /**
   * The ingredient that runs out first, for the badge text. Naming it is what
   * turns a warning into an action — "Low: matcha" tells the operator which
   * tin to go and check.
   */
  readonly limitingIngredientId: string | null;
}

/**
 * Stock state for one menu item.
 *
 * `OUT` when the next one cannot be made at all. `LOW` when any ingredient it
 * needs has fallen to its reorder point, even if there is still plenty of
 * runway on the drink itself — the reorder point is the operator's own
 * statement about when to buy more, and it should fire on their terms.
 *
 * An unmodelled item (no recipe) is `OK` with infinite runway rather than
 * sold out. Missing reference data must never take a sellable drink off the
 * menu; see `maxProducible`.
 */
export function menuItemStock(
  requirements: readonly Requirement[],
  onHand: ReadonlyMap<string, Quantity>,
  reorderPoints: ReadonlyMap<string, Quantity>,
): MenuItemStock {
  const producible = maxProducible(requirements, onHand);

  if (producible === 0) {
    // Name whichever ingredient actually blocks it, not just the first listed.
    const blocking = requirements.find(
      (req) => (onHand.get(req.ingredientId) ?? ZERO_QTY) < req.qty,
    );
    return {
      status: "OUT",
      maxProducible: 0,
      limitingIngredientId: blocking?.ingredientId ?? null,
    };
  }

  let lowest: { readonly ingredientId: string; readonly runway: number } | null = null;
  let anyLow = false;

  for (const req of requirements) {
    const available = onHand.get(req.ingredientId) ?? ZERO_QTY;
    const reorderPoint = reorderPoints.get(req.ingredientId) ?? ZERO_QTY;
    if (stockStatus(available, reorderPoint) !== "OK") anyLow = true;

    const runway = req.qty === 0 ? Infinity : available / req.qty;
    if (lowest === null || runway < lowest.runway) {
      lowest = { ingredientId: req.ingredientId, runway };
    }
  }

  return {
    status: anyLow ? "LOW" : "OK",
    maxProducible: producible,
    limitingIngredientId: anyLow ? lowest?.ingredientId ?? null : null,
  };
}

/** Stock state for every menu item, keyed by menu item id. */
export function menuStockByItem(
  requirementsByItem: ReadonlyMap<string, readonly Requirement[]>,
  onHand: ReadonlyMap<string, Quantity>,
  reorderPoints: ReadonlyMap<string, Quantity>,
): Map<string, MenuItemStock> {
  const out = new Map<string, MenuItemStock>();
  for (const [menuItemId, requirements] of requirementsByItem) {
    out.set(menuItemId, menuItemStock(requirements, onHand, reorderPoints));
  }
  return out;
}
