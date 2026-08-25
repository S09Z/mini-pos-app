/**
 * ledger.ts — stock as an append-only movement log.
 *
 * On-hand is not a number you edit. It is the sum of every movement ever
 * recorded against an ingredient. This is the same argument as rule 4 for
 * sales, applied to stock, and PLAN.md states the payoff directly: without
 * waste events "counts drift and you will never learn why".
 *
 * A stored on-hand figure can only tell you that you are 12g short. A ledger
 * tells you that you sold 40 drinks, recorded 8g spilled, and are *still* 12g
 * short — which is a different and much more useful sentence. Phase 2 is done
 * when a physical count matches twice in a row, and that is only diagnosable
 * if every change has a reason attached to it.
 *
 * So there is no `setOnHand`. Correcting a count writes a COUNT_ADJUSTMENT
 * movement recording the variance, exactly as a void writes a compensating
 * record rather than deleting a sale.
 */

import { quantity, sumQty, negateQty, ZERO_QTY, type Quantity } from "./units.js";
import type { Requirement } from "./recipe.js";

export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

/**
 * Why stock moved. Every movement carries one, because "the tin is 12g light"
 * is only actionable when you can see which of these it came from.
 */
export type MovementKind =
  | "PURCHASE"
  | "SALE_DEPLETION"
  | "WASTE"
  | "VOID_RESTOCK"
  | "COUNT_ADJUSTMENT";

/** The three ways stock leaves without being sold. PLAN.md names exactly these. */
export type WasteReason = "SPILLED" | "EXPIRED" | "STAFF_DRINK";

export interface StockMovement {
  readonly id: string;
  readonly ingredientId: string;
  readonly kind: MovementKind;
  /** Signed. Negative takes stock out, positive puts it in. */
  readonly delta: Quantity;
  readonly at: string;
  /** Set for SALE_DEPLETION and VOID_RESTOCK, so a movement traces to its sale. */
  readonly saleId: string | null;
  readonly wasteReason: WasteReason | null;
  readonly note: string;
}

/** A movement before the storage layer stamps an id onto it. */
export type MovementDraft = Omit<StockMovement, "id">;

/** Which direction each kind is allowed to move stock. */
const REQUIRED_SIGN: Record<MovementKind, "POSITIVE" | "NEGATIVE" | "EITHER"> = {
  PURCHASE: "POSITIVE",
  SALE_DEPLETION: "NEGATIVE",
  WASTE: "NEGATIVE",
  VOID_RESTOCK: "POSITIVE",
  COUNT_ADJUSTMENT: "EITHER",
};

/**
 * Reject a mis-signed movement at construction.
 *
 * A purchase that lands negative, or a waste event that lands positive, would
 * quietly corrupt every count downstream of it and look like a real
 * discrepancy for as long as it took to notice.
 */
export function assertWellSigned(kind: MovementKind, delta: Quantity): void {
  const required = REQUIRED_SIGN[kind];
  if (required === "POSITIVE" && delta < 0) {
    throw new LedgerError(`${kind} must add stock, got ${delta}`);
  }
  if (required === "NEGATIVE" && delta > 0) {
    throw new LedgerError(`${kind} must remove stock, got ${delta}`);
  }
}

/** On-hand for one ingredient: the sum of its movements, nothing else. */
export function onHandFrom(movements: readonly StockMovement[]): Quantity {
  return sumQty(movements.map((m) => m.delta));
}

/** On-hand for every ingredient mentioned in the ledger. */
export function onHandByIngredient(
  movements: readonly StockMovement[],
): Map<string, Quantity> {
  const totals = new Map<string, Quantity>();
  for (const movement of movements) {
    const running = totals.get(movement.ingredientId) ?? ZERO_QTY;
    totals.set(movement.ingredientId, quantity(running + movement.delta));
  }
  return totals;
}

/** Movements that take a sale's ingredients out of stock. */
export function depletionDrafts(
  requirements: readonly Requirement[],
  saleId: string,
  at: string,
): readonly MovementDraft[] {
  return requirements
    .filter((req) => req.qty !== 0)
    .map((req) => {
      const delta = negateQty(req.qty);
      assertWellSigned("SALE_DEPLETION", delta);
      return {
        ingredientId: req.ingredientId,
        kind: "SALE_DEPLETION" as const,
        delta,
        at,
        saleId,
        wasteReason: null,
        note: "",
      };
    });
}

/**
 * Compensating movements that put a voided sale's ingredients back.
 *
 * Derived from the original depletions rather than recomputed from the recipe,
 * so a recipe edited between the sale and the void cannot restock a different
 * amount than was taken. The ledger stays internally consistent even when the
 * reference data behind it has moved on.
 */
export function restockDrafts(
  originalDepletions: readonly StockMovement[],
  at: string,
): readonly MovementDraft[] {
  return originalDepletions.map((depletion) => {
    if (depletion.kind !== "SALE_DEPLETION") {
      throw new LedgerError(`Can only restock a SALE_DEPLETION, got ${depletion.kind}`);
    }
    const delta = negateQty(depletion.delta);
    assertWellSigned("VOID_RESTOCK", delta);
    return {
      ingredientId: depletion.ingredientId,
      kind: "VOID_RESTOCK" as const,
      delta,
      at,
      saleId: depletion.saleId,
      wasteReason: null,
      note: "",
    };
  });
}

export function wasteDraft(
  ingredientId: string,
  qty: Quantity,
  reason: WasteReason,
  at: string,
  note = "",
): MovementDraft {
  if (qty <= 0) throw new LedgerError("Waste quantity must be positive");
  const delta = negateQty(qty);
  assertWellSigned("WASTE", delta);
  return { ingredientId, kind: "WASTE", delta, at, saleId: null, wasteReason: reason, note };
}

export function purchaseDraft(
  ingredientId: string,
  qty: Quantity,
  at: string,
  note = "",
): MovementDraft {
  if (qty <= 0) throw new LedgerError("Purchase quantity must be positive");
  assertWellSigned("PURCHASE", qty);
  return { ingredientId, kind: "PURCHASE", delta: qty, at, saleId: null, wasteReason: null, note };
}

/**
 * Record a physical count as a variance, never as an overwrite.
 *
 * Returns `null` when the count already agrees, so a clean count does not
 * clutter the ledger with zero-delta rows. Anything else writes the difference
 * as its own event — the discrepancy is the finding, and silently assigning
 * the counted value would erase exactly the signal Phase 2 exists to produce.
 */
export function countAdjustmentDraft(
  ingredientId: string,
  countedQty: Quantity,
  derivedOnHand: Quantity,
  at: string,
  note = "",
): MovementDraft | null {
  if (countedQty < 0) throw new LedgerError("A physical count cannot be negative");
  const delta = quantity(countedQty - derivedOnHand);
  if (delta === 0) return null;
  return {
    ingredientId,
    kind: "COUNT_ADJUSTMENT",
    delta,
    at,
    saleId: null,
    wasteReason: null,
    note,
  };
}

export type StockStatus = "OK" | "LOW" | "OUT";

/**
 * Where an ingredient sits against its reorder point.
 *
 * `OUT` at or below zero, `LOW` at or below the reorder point. The reorder
 * point is meant to fire while there is still stock left to sell, so the
 * boundary is inclusive.
 */
export function stockStatus(onHand: Quantity, reorderPoint: Quantity): StockStatus {
  if (onHand <= 0) return "OUT";
  if (onHand <= reorderPoint) return "LOW";
  return "OK";
}

/** Group a ledger by ingredient, for a variance investigation. */
export function movementsByKind(
  movements: readonly StockMovement[],
): Map<MovementKind, Quantity> {
  const totals = new Map<MovementKind, Quantity>();
  for (const movement of movements) {
    const running = totals.get(movement.kind) ?? ZERO_QTY;
    totals.set(movement.kind, quantity(running + movement.delta));
  }
  return totals;
}
