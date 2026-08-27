/**
 * stock.ts — the only path that writes a stock movement.
 *
 * Every function here goes through `applyMovements`, which writes the
 * append-only ledger rows and updates the cached `ingredients.onHand`
 * projection inside one transaction. Nothing else may touch `onHand`: if a
 * movement and its projection could ever be written separately, a crash
 * between them would produce exactly the silent drift Phase 2 exists to
 * eliminate.
 */

import { quantity, type Quantity } from "../stock/units.js";
import type { UnitCost } from "../stock/costing.js";
import { blendCost } from "../stock/costing.js";
import {
  depletionDrafts,
  restockDrafts,
  wasteDraft,
  purchaseDraft,
  countAdjustmentDraft,
  onHandFrom,
  type MovementDraft,
  type StockMovement,
  type WasteReason,
} from "../stock/ledger.js";
import type { Requirement } from "../stock/recipe.js";
import { resolveRecipe, requirementsForCart } from "../stock/recipe.js";
import { WALK_IN } from "../channel/types.js";
import type { Satang } from "../money.js";
import { db, type IngredientRecord, type StockMovementRecord } from "./schema.js";

export class StockError extends Error {
  override readonly name = "StockError";
}

/** Ledger rows as the domain layer wants them. */
const asMovements = (rows: readonly StockMovementRecord[]): StockMovement[] =>
  rows.map((row) => ({ ...row, delta: quantity(row.delta) }));

/**
 * Write movements and advance the cached on-hand, atomically.
 *
 * Safe to call from inside an existing transaction — Dexie reuses the parent
 * when the table scope is a subset, which is how checkout gets its depletion
 * into the very same transaction as the sale.
 */
export async function applyMovements(drafts: readonly MovementDraft[]): Promise<void> {
  if (drafts.length === 0) return;

  await db.transaction("rw", db.ingredients, db.stock_movements, async () => {
    await db.stock_movements.bulkAdd(
      drafts.map((draft) => ({ ...draft, id: crypto.randomUUID(), delta: draft.delta as number })),
    );

    const deltaByIngredient = new Map<string, number>();
    for (const draft of drafts) {
      deltaByIngredient.set(
        draft.ingredientId,
        (deltaByIngredient.get(draft.ingredientId) ?? 0) + draft.delta,
      );
    }

    for (const [ingredientId, delta] of deltaByIngredient) {
      const ingredient = await db.ingredients.get(ingredientId);
      if (!ingredient) {
        // An unmodelled ingredient must not abort a sale. The movement is
        // still recorded, so the gap shows up as an unattributed row rather
        // than vanishing.
        continue;
      }
      await db.ingredients.put({ ...ingredient, onHand: ingredient.onHand + delta });
    }
  });
}

/**
 * Deplete a cart's ingredients. Called inside the checkout transaction.
 *
 * Resolved against the sale's channel, so a delivery order takes its sealed
 * lid and carrier bag out of stock while a counter order does not.
 */
export async function depleteForSale(
  cart: readonly { readonly menuItemId: string; readonly qty: number }[],
  saleId: string,
  at: string,
  channelId: string = WALK_IN.id,
): Promise<void> {
  const recipeLines = await db.recipe_lines.toArray();
  const requirements = requirementsForCart(recipeLines, cart, channelId);
  await applyMovements(depletionDrafts(requirements, saleId, at));
}

/**
 * Put back what a voided sale took.
 *
 * Reads the original depletion rows rather than recomputing from the recipe,
 * so a recipe edited between the sale and the void cannot restock a different
 * amount than was removed.
 */
export async function restockForVoid(saleId: string, at: string): Promise<void> {
  const original = await db.stock_movements.where("saleId").equals(saleId).toArray();
  const depletions = asMovements(original).filter((m) => m.kind === "SALE_DEPLETION");
  if (depletions.length === 0) return;
  await applyMovements(restockDrafts(depletions, at));
}

export async function recordWaste(
  ingredientId: string,
  qty: Quantity,
  reason: WasteReason,
  note = "",
): Promise<void> {
  await applyMovements([wasteDraft(ingredientId, qty, reason, new Date().toISOString(), note)]);
}

/**
 * Record a purchase and re-blend the running cost.
 *
 * The cost update and the movement share a transaction because a purchase that
 * moved stock without moving cost would silently overstate margin from then on.
 */
export async function recordPurchase(
  ingredientId: string,
  qty: Quantity,
  totalCost: Satang,
  note = "",
): Promise<void> {
  await db.transaction("rw", db.ingredients, db.stock_movements, async () => {
    const ingredient = await db.ingredients.get(ingredientId);
    if (!ingredient) throw new StockError(`Unknown ingredient "${ingredientId}"`);

    const blended = blendCost(
      quantity(ingredient.onHand),
      ingredient.costPerUnit as UnitCost,
      qty,
      totalCost,
    );

    await applyMovements([purchaseDraft(ingredientId, qty, new Date().toISOString(), note)]);

    const after = await db.ingredients.get(ingredientId);
    if (after) await db.ingredients.put({ ...after, costPerUnit: blended });
  });
}

/**
 * Record a physical count as a variance.
 *
 * Returns the adjustment written, or `null` when the count already agreed —
 * which is the result PLAN.md's "done when" is actually asking for, twice in
 * a row.
 */
export async function recordCount(
  ingredientId: string,
  countedQty: Quantity,
  note = "",
): Promise<MovementDraft | null> {
  return db.transaction("rw", db.ingredients, db.stock_movements, async () => {
    const ingredient = await db.ingredients.get(ingredientId);
    if (!ingredient) throw new StockError(`Unknown ingredient "${ingredientId}"`);

    const draft = countAdjustmentDraft(
      ingredientId,
      countedQty,
      quantity(ingredient.onHand),
      new Date().toISOString(),
      note,
    );
    if (draft) await applyMovements([draft]);
    return draft;
  });
}

export interface OnHandVariance {
  readonly ingredientId: string;
  readonly cached: Quantity;
  readonly derived: Quantity;
}

/**
 * Rebuild every cached on-hand from the ledger and report any that disagreed.
 *
 * The cache is a convenience; the ledger is the truth. This is the function
 * that proves the two have not diverged — run it before trusting a physical
 * count, so a cache bug is never mistaken for a missing gram of matcha.
 */
export async function recomputeOnHand(): Promise<readonly OnHandVariance[]> {
  return db.transaction("rw", db.ingredients, db.stock_movements, async () => {
    const ingredients = await db.ingredients.toArray();
    const variances: OnHandVariance[] = [];

    for (const ingredient of ingredients) {
      const rows = await db.stock_movements.where("ingredientId").equals(ingredient.id).toArray();
      const derived = onHandFrom(asMovements(rows));
      if (derived !== ingredient.onHand) {
        variances.push({
          ingredientId: ingredient.id,
          cached: quantity(ingredient.onHand),
          derived,
        });
        await db.ingredients.put({ ...ingredient, onHand: derived });
      }
    }
    return variances;
  });
}

export async function onHandMap(): Promise<Map<string, Quantity>> {
  const ingredients = await db.ingredients.toArray();
  return new Map(ingredients.map((i) => [i.id, quantity(i.onHand)]));
}

export async function unitCostMap(): Promise<Map<string, UnitCost>> {
  const ingredients = await db.ingredients.toArray();
  return new Map(ingredients.map((i) => [i.id, i.costPerUnit as UnitCost]));
}

/** What one of each menu item consumes, for the availability calculation. */
export async function requirementsByMenuItem(): Promise<Map<string, readonly Requirement[]>> {
  const [menuItems, recipeLines] = await Promise.all([
    db.menu_items.toArray(),
    db.recipe_lines.toArray(),
  ]);
  return new Map(
    menuItems.map((item) => [item.id, resolveRecipe(recipeLines, item.id, WALK_IN.id)]),
  );
}

export async function ingredientsSorted(): Promise<IngredientRecord[]> {
  return db.ingredients.orderBy("sortOrder").toArray();
}

export async function movementsFor(ingredientId: string): Promise<StockMovement[]> {
  const rows = await db.stock_movements.where("ingredientId").equals(ingredientId).toArray();
  return asMovements(rows).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
