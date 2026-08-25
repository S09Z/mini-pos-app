/**
 * recipe.ts — bill of materials, resolved per channel.
 *
 * The rule PLAN.md puts in bold: **you do not stock lattes.** Stock is held in
 * ingredients, and a drink is a recipe that consumes them. Modelling stock on
 * the product is the mistake that makes a count impossible to reconcile,
 * because the same tin of matcha is behind four different menu items.
 *
 * Channel overrides exist because a delivery order is physically a different
 * object: the same tea goes into a sealed cup inside a carrier bag. The
 * override semantics, spelled out because `channel/types.ts` says only "adds
 * or replaces":
 *
 *   - A line with `channelId: null` is the base recipe and applies everywhere.
 *   - A line with a specific `channelId` **replaces** the base line for that
 *     same ingredient, on that channel only.
 *   - A channel line for an ingredient with no base counterpart **adds** to
 *     the recipe on that channel only.
 *
 * So a sealed lid (no base line) is added for delivery, while a 12oz cup can
 * be swapped for a sealed 12oz cup by giving the delivery channel its own line
 * for the same ingredient.
 */

import type { ChannelId, RecipeLine } from "../channel/types.js";
import { quantity, scaleQty, sumQty, howManyFit, ZERO_QTY, type Quantity } from "./units.js";

export class RecipeError extends Error {
  override readonly name = "RecipeError";
}

/** One ingredient and how much of it a drink (or a whole cart) consumes. */
export interface Requirement {
  readonly ingredientId: string;
  readonly qty: Quantity;
}

/**
 * Resolve the effective recipe for one menu item on one channel.
 *
 * `RecipeLine.qty` is a plain `number` in the existing schema; it is validated
 * and branded here rather than trusted, so a hand-edited recipe row cannot put
 * a float into the depletion path.
 */
export function resolveRecipe(
  lines: readonly RecipeLine[],
  menuItemId: string,
  channelId: ChannelId,
): readonly Requirement[] {
  const forItem = lines.filter((l) => l.menuItemId === menuItemId);

  const effective = new Map<string, Quantity>();
  for (const line of forItem) {
    if (line.channelId === null) effective.set(line.ingredientId, quantity(line.qty));
  }
  // Channel-specific lines are applied second, so they replace the base entry
  // for the same ingredient and add entries for ingredients with no base line.
  for (const line of forItem) {
    if (line.channelId === channelId) effective.set(line.ingredientId, quantity(line.qty));
  }

  return [...effective]
    .map(([ingredientId, qty]) => ({ ingredientId, qty }))
    .sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0));
}

export interface CartRequirementInput {
  readonly menuItemId: string;
  readonly qty: number;
}

/**
 * Aggregate what a whole ticket consumes, so depletion is one set of movements
 * rather than one per line. Two lattes and one iced matcha draw on the same
 * tin, and the operator wants to know the tin is short before the second drink
 * is made, not after.
 */
export function requirementsForCart(
  lines: readonly RecipeLine[],
  cart: readonly CartRequirementInput[],
  channelId: ChannelId,
): readonly Requirement[] {
  const totals = new Map<string, Quantity[]>();

  for (const item of cart) {
    if (!Number.isInteger(item.qty) || item.qty < 0) {
      throw new RecipeError(`Cart quantity must be a non-negative integer, got ${item.qty}`);
    }
    for (const req of resolveRecipe(lines, item.menuItemId, channelId)) {
      const existing = totals.get(req.ingredientId) ?? [];
      existing.push(scaleQty(req.qty, item.qty));
      totals.set(req.ingredientId, existing);
    }
  }

  return [...totals]
    .map(([ingredientId, parts]) => ({ ingredientId, qty: sumQty(parts) }))
    .sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0));
}

/**
 * How many of this drink can still be made from what is on hand?
 *
 * The binding constraint is whichever ingredient runs out first. A drink with
 * no recipe at all returns `Infinity` rather than 0 — an unmodelled item is
 * unknown, not sold out, and blocking sales on missing reference data would
 * break the "never block a sale" rule for the worst possible reason.
 */
export function maxProducible(
  requirements: readonly Requirement[],
  onHand: ReadonlyMap<string, Quantity>,
): number {
  if (requirements.length === 0) return Infinity;

  let limit = Infinity;
  for (const req of requirements) {
    const available = onHand.get(req.ingredientId) ?? ZERO_QTY;
    limit = Math.min(limit, howManyFit(available, req.qty));
  }
  return limit;
}

/** Ingredients a cart would take below zero, with how short each one is. */
export function shortfalls(
  requirements: readonly Requirement[],
  onHand: ReadonlyMap<string, Quantity>,
): readonly Requirement[] {
  const short: Requirement[] = [];
  for (const req of requirements) {
    const available = onHand.get(req.ingredientId) ?? ZERO_QTY;
    if (available < req.qty) {
      short.push({ ingredientId: req.ingredientId, qty: quantity(req.qty - available) });
    }
  }
  return short;
}
