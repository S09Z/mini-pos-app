/**
 * schema.ts — local Dexie (IndexedDB) store.
 *
 * `sales` and `sale_lines` are append-only: there is no update or delete path.
 * A void is a new row in `voids` pointing at the original sale id, never a
 * mutation of the sale itself — see CLAUDE.md rule 4.
 */

import Dexie, { type EntityTable } from "dexie";
import type { BasisPoints } from "../money.js";
import type { Unit } from "../stock/units.js";
import type { MovementKind, WasteReason } from "../stock/ledger.js";

export interface MenuItemRecord {
  readonly id: string;
  readonly name: string;
  /** Satang, VAT-inclusive list price. */
  readonly priceSatang: number;
  readonly sortOrder: number;
  readonly soldOut: boolean;
}

export interface SaleLineRecord {
  readonly id: string;
  readonly saleId: string;
  readonly menuItemId: string;
  /** Snapshot of the menu item name at time of sale — receipts must not drift if the menu changes later. */
  readonly name: string;
  readonly unitPriceSatang: number;
  readonly qty: number;
  readonly grossSatang: number;
  readonly netSatang: number;
  readonly vatSatang: number;
}

export interface SaleRecord {
  readonly id: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly grossSatang: number;
  readonly netSatang: number;
  readonly vatSatang: number;
  readonly rateBp: BasisPoints;
  readonly authority: string;
  readonly provisional: boolean;
  readonly vatRegistered: boolean;
  readonly taxInvoiceEligible: boolean;
  readonly tenderedSatang: number;
  readonly changeSatang: number;
}

export interface VoidRecord {
  readonly id: string;
  /** The original sale this void reverses. The original row is never touched. */
  readonly saleId: string;
  readonly receiptNo: string;
  readonly createdAt: string;
}

/** Singleton row: local device identity and the sequence used for receipt numbers. */
export interface DeviceConfigRecord {
  readonly id: "device";
  readonly receiptPrefix: string;
  readonly nextReceiptSeq: number;
  /** Below the registration threshold by default; VAT registration is a Phase 6 concern. */
  readonly vatRegistered: boolean;
  /** Soft gate on void, not an auth system — see PLAN.md Phase 8 for real roles/hashed PINs. */
  readonly ownerPin: string;
}

/** An ingredient you actually stock. You do not stock lattes — see stock/recipe.ts. */
export interface IngredientRecord {
  readonly id: string;
  readonly name: string;
  readonly unit: Unit;
  /**
   * Cached projection of the movement ledger, in milli-units.
   *
   * `stock_movements` is the source of truth; this exists so the sell screen
   * can decide whether a tile is sold out without folding the whole ledger on
   * every render. Every write updates both in one transaction, and
   * `recomputeOnHand()` rebuilds this from the ledger to prove they agree.
   */
  readonly onHand: number;
  /** Milli-units. At or below this, the tile shows a low-stock label. */
  readonly reorderPoint: number;
  /** Millisatang per display unit — weighted average, updated on purchase. */
  readonly costPerUnit: number;
  readonly sortOrder: number;
}

/** Bill of materials. `channelId: null` is the base recipe; see stock/recipe.ts for override semantics. */
export interface RecipeLineRecord {
  readonly id: string;
  readonly menuItemId: string;
  readonly ingredientId: string;
  /** Milli-units. */
  readonly qty: number;
  readonly channelId: string | null;
}

/** Append-only. Never updated, never deleted — a correction is another movement. */
export interface StockMovementRecord {
  readonly id: string;
  readonly ingredientId: string;
  readonly kind: MovementKind;
  /** Signed, in milli-units. */
  readonly delta: number;
  readonly at: string;
  readonly saleId: string | null;
  readonly wasteReason: WasteReason | null;
  readonly note: string;
}

export const db = new Dexie("mini-pos-app") as Dexie & {
  menu_items: EntityTable<MenuItemRecord, "id">;
  sales: EntityTable<SaleRecord, "id">;
  sale_lines: EntityTable<SaleLineRecord, "id">;
  voids: EntityTable<VoidRecord, "id">;
  device_config: EntityTable<DeviceConfigRecord, "id">;
  ingredients: EntityTable<IngredientRecord, "id">;
  recipe_lines: EntityTable<RecipeLineRecord, "id">;
  stock_movements: EntityTable<StockMovementRecord, "id">;
};

db.version(1).stores({
  menu_items: "id, sortOrder",
  sales: "id, receiptNo, createdAt",
  sale_lines: "id, saleId, menuItemId",
  voids: "id, saleId, receiptNo",
  device_config: "id",
});

// v2 — Phase 2 stock. Dexie carries v1's tables forward; only additions are
// declared here. Existing sales survive the upgrade untouched.
db.version(2).stores({
  ingredients: "id, sortOrder",
  recipe_lines: "id, menuItemId, ingredientId",
  stock_movements: "id, ingredientId, at, saleId, kind",
});

const DEFAULT_MENU: readonly MenuItemRecord[] = [
  { id: "usucha", name: "Usucha", priceSatang: 8_000, sortOrder: 0, soldOut: false },
  { id: "iced-matcha", name: "Iced Matcha", priceSatang: 8_000, sortOrder: 1, soldOut: false },
  { id: "hojicha", name: "Hojicha", priceSatang: 7_500, sortOrder: 2, soldOut: false },
  { id: "matcha-latte", name: "Matcha Latte", priceSatang: 9_000, sortOrder: 3, soldOut: false },
];

/**
 * Starter ingredients. `onHand` is seeded at zero and the opening stock is
 * written as real PURCHASE movements below, so the ledger is the source of
 * truth from the very first row rather than from the first sale.
 */
const DEFAULT_INGREDIENTS: readonly IngredientRecord[] = [
  { id: "matcha", name: "Matcha", unit: "g", onHand: 0, reorderPoint: 20_000, costPerUnit: 2_000_000, sortOrder: 0 },
  { id: "hojicha-leaf", name: "Hojicha leaf", unit: "g", onHand: 0, reorderPoint: 30_000, costPerUnit: 600_000, sortOrder: 1 },
  { id: "milk", name: "Milk", unit: "ml", onHand: 0, reorderPoint: 1_000_000, costPerUnit: 5_000, sortOrder: 2 },
  { id: "cup", name: "Cup", unit: "piece", onHand: 0, reorderPoint: 20_000, costPerUnit: 200_000, sortOrder: 3 },
];

/** Opening stock, in milli-units: 200g matcha, 200g hojicha, 4L milk, 100 cups. */
const OPENING_STOCK: readonly (readonly [string, number])[] = [
  ["matcha", 200_000],
  ["hojicha-leaf", 200_000],
  ["milk", 4_000_000],
  ["cup", 100_000],
];

/**
 * Starter recipes — deliberate guesses, and the first thing real use should
 * correct. PLAN.md's warning applies directly: a recipe written from a chair
 * is wrong in ways you cannot predict until you have made the drink and
 * weighed what actually went into it.
 */
const DEFAULT_RECIPES: readonly RecipeLineRecord[] = [
  { id: "usucha:matcha:*", menuItemId: "usucha", ingredientId: "matcha", qty: 2_000, channelId: null },
  { id: "usucha:cup:*", menuItemId: "usucha", ingredientId: "cup", qty: 1_000, channelId: null },

  { id: "iced-matcha:matcha:*", menuItemId: "iced-matcha", ingredientId: "matcha", qty: 4_000, channelId: null },
  { id: "iced-matcha:cup:*", menuItemId: "iced-matcha", ingredientId: "cup", qty: 1_000, channelId: null },

  { id: "hojicha:hojicha-leaf:*", menuItemId: "hojicha", ingredientId: "hojicha-leaf", qty: 5_000, channelId: null },
  { id: "hojicha:cup:*", menuItemId: "hojicha", ingredientId: "cup", qty: 1_000, channelId: null },

  // PLAN.md's worked example: one latte removes 4g matcha, 200ml milk, 1 cup.
  { id: "matcha-latte:matcha:*", menuItemId: "matcha-latte", ingredientId: "matcha", qty: 4_000, channelId: null },
  { id: "matcha-latte:milk:*", menuItemId: "matcha-latte", ingredientId: "milk", qty: 200_000, channelId: null },
  { id: "matcha-latte:cup:*", menuItemId: "matcha-latte", ingredientId: "cup", qty: 1_000, channelId: null },
];

/** Seed a fresh install with a starter menu, ingredients, recipes, and device config. Idempotent. */
export async function seedIfEmpty(): Promise<void> {
  await db.transaction(
    "rw",
    db.menu_items,
    db.device_config,
    db.ingredients,
    db.recipe_lines,
    db.stock_movements,
    async () => {
      if ((await db.menu_items.count()) === 0) {
        await db.menu_items.bulkAdd(DEFAULT_MENU);
      }
      if ((await db.device_config.get("device")) === undefined) {
        await db.device_config.add({
          id: "device",
          receiptPrefix: "A",
          nextReceiptSeq: 1,
          vatRegistered: false,
          ownerPin: "1234",
        });
      }
      if ((await db.recipe_lines.count()) === 0) {
        await db.recipe_lines.bulkAdd(DEFAULT_RECIPES);
      }
      if ((await db.ingredients.count()) === 0) {
        const at = new Date().toISOString();
        await db.ingredients.bulkAdd(
          DEFAULT_INGREDIENTS.map((ingredient) => {
            const opening = OPENING_STOCK.find(([id]) => id === ingredient.id)?.[1] ?? 0;
            return { ...ingredient, onHand: opening };
          }),
        );
        await db.stock_movements.bulkAdd(
          OPENING_STOCK.map(([ingredientId, qty]) => ({
            id: `opening-${ingredientId}`,
            ingredientId,
            kind: "PURCHASE" as const,
            delta: qty,
            at,
            saleId: null,
            wasteReason: null,
            note: "Opening stock — replace with a real count",
          })),
        );
      }
    },
  );
}
