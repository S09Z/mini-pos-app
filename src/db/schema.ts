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
import type { GpBasis, GpAppliesTo } from "../channel/types.js";
import { WALK_IN, GRAB } from "../channel/types.js";

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
  /**
   * Cost of the ingredients this line consumed, frozen at checkout.
   *
   * Rule 5's principle applied to cost: a Z-report re-run after a supplier
   * price change must still reproduce the margin the day actually earned.
   * Recomputing from today's weighted average would quietly restate history.
   *
   * `null` means not costed — sales written before this field existed, or an
   * item with no recipe. Reports must say "unknown", never assume zero cost,
   * because zero cost reads as 100% margin.
   */
  readonly cogsSatang: number | null;
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
  /**
   * Which channel rang this sale. Counter sales are `WALK_IN`.
   *
   * Frozen on the record because the same drink is economically a different
   * product per channel, and a report that had to infer the channel later
   * could not tell a counter sale from a delivery one at all.
   */
  readonly channelId: string;
  /** The platform's own order reference, keyed from their tablet. Null at the counter. */
  readonly platformOrderId: string | null;
  /** Discount funded by the merchant, not the platform. Kept separate — see PlatformFeeRecord. */
  readonly merchantFundedDiscountSatang: number;
}

export interface VoidRecord {
  readonly id: string;
  /** The original sale this void reverses. The original row is never touched. */
  readonly saleId: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  /**
   * Who authorised it. Only "owner" exists until Phase 8 introduces staff
   * roles, so grouping by actor is structural for now — but the field has to
   * be on the record from the first void, or the audit trail starts empty on
   * the day it finally matters.
   */
  readonly actor: string;
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
  /**
   * Cups, lids, bags. Split from ingredients only for reporting —
   * `settle()` adds the two together, but seeing packaging separately is how
   * you notice that delivery's extra wrapping is eating the markup.
   */
  readonly isPackaging: boolean;
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

/**
 * A drawer count. Append-only, like everything else that records a
 * discrepancy: the variance is its own row and is never silently corrected,
 * because a till that quietly agrees with itself every night is exactly how
 * theft stays invisible.
 */
export interface CashCountRecord {
  readonly id: string;
  /** Bangkok-local trading day, YYYY-MM-DD. */
  readonly day: string;
  readonly countedAt: string;
  /** What the sales say should be in the drawer. */
  readonly expectedSatang: number;
  /** What the operator actually counted. */
  readonly declaredSatang: number;
  /** declared − expected. Negative is short. */
  readonly varianceSatang: number;
  readonly note: string;
}

/** A sales channel. Mirrors `channel/types.ts`, stored so it can be edited per contract. */
export interface ChannelRecord {
  readonly id: string;
  readonly name: string;
  readonly gpRateBp: number;
  readonly gpBasis: GpBasis;
  readonly gpAppliesTo: GpAppliesTo;
  readonly gpVatRateBp: number;
  readonly whtRateBp: number;
  readonly requiresDeliveryPackaging: boolean;
  readonly active: boolean;
  readonly sortOrder: number;
}

/** Per-channel list price, dated. Add a row; never edit one. */
export interface ChannelPriceRecord {
  readonly id: string;
  readonly menuItemId: string;
  readonly channelId: string;
  readonly priceSatang: number;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * Commission frozen at the moment of sale, one row per delivery sale.
 *
 * Rule 5 applied to commission: renegotiating GP next quarter must not
 * restate what last quarter's orders actually earned. `payoutBatchId` stays
 * null until Phase 5 matches it to a deposit.
 */
export interface PlatformFeeRecord {
  readonly saleId: string;
  readonly channelId: string;
  readonly platformOrderId: string;
  readonly gpAmountSatang: number;
  readonly gpVatSatang: number;
  readonly whtSatang: number;
  readonly merchantFundedDiscountSatang: number;
  readonly netPayoutSatang: number;
  /** The contract reading this was computed under, frozen alongside the figures. */
  readonly gpRateBp: number;
  readonly gpBasis: GpBasis;
  readonly gpAppliesTo: GpAppliesTo;
  readonly payoutBatchId: string | null;
}

/**
 * One imported statement and the deposit it corresponds to.
 *
 * Append-only, like everything else that records a discrepancy. Re-importing a
 * corrected statement creates a new batch rather than editing this one, so the
 * history of what the platform claimed and when stays intact.
 */
export interface PayoutBatchRecord {
  readonly id: string;
  readonly channelId: string;
  readonly importedAt: string;
  readonly fileName: string;
  /** Statement rows read, before matching. */
  readonly rowCount: number;
  readonly statementTotalSatang: number;
  readonly expectedTotalSatang: number;
  /** What actually reached the bank. Null until the operator enters it. */
  readonly depositSatang: number | null;
  readonly note: string;
}

/** A statement row as imported, with its original cells kept for investigation. */
export interface StatementRowRecord {
  readonly id: string;
  readonly batchId: string;
  readonly platformOrderId: string;
  readonly netPayoutSatang: number;
  readonly grossSatang: number | null;
  readonly commissionSatang: number | null;
  /** Funded by the platform, not us — kept apart from merchantFundedDiscount. */
  readonly platformFundedDiscountSatang: number | null;
  readonly merchantFundedDiscountSatang: number | null;
  readonly orderDate: string | null;
  readonly status: string | null;
  readonly lineNumber: number;
  readonly raw: Readonly<Record<string, string>>;
}

/**
 * An unmatched or mismatched row. PLAN.md: these are the finding, not the mess.
 *
 * `reason` stays null until someone works the queue. Resolving attaches an
 * explanation and never alters `varianceSatang` — a reconciliation that
 * reached zero by editing the numbers would prove nothing.
 */
export interface PayoutExceptionRecord {
  readonly id: string;
  readonly batchId: string;
  readonly kind: string;
  readonly platformOrderId: string;
  readonly varianceSatang: number;
  readonly saleId: string | null;
  readonly detail: string;
  readonly reason: string | null;
  readonly note: string;
  readonly resolvedAt: string | null;
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
  cash_counts: EntityTable<CashCountRecord, "id">;
  channels: EntityTable<ChannelRecord, "id">;
  channel_prices: EntityTable<ChannelPriceRecord, "id">;
  platform_fees: EntityTable<PlatformFeeRecord, "saleId">;
  payout_batches: EntityTable<PayoutBatchRecord, "id">;
  statement_rows: EntityTable<StatementRowRecord, "id">;
  payout_exceptions: EntityTable<PayoutExceptionRecord, "id">;
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

// v3 — Phase 3 day close. `cash_counts` is new; the two backfills below make
// the absence of older data explicit in the record rather than leaving it to
// be inferred from a missing field.
db.version(3)
  .stores({
    cash_counts: "id, day, countedAt",
  })
  .upgrade(async (tx) => {
    // Pre-v3 sales were never costed. Marked unknown, not zero — see
    // SaleLineRecord.cogsSatang.
    await tx
      .table("sale_lines")
      .toCollection()
      .modify((line: { cogsSatang?: number | null }) => {
        line.cogsSatang = null;
      });
    await tx
      .table("voids")
      .toCollection()
      .modify((v: { actor?: string }) => {
        v.actor = "owner";
      });
  });

// v4 — Phase 4 delivery channels. Existing sales predate the channel
// dimension entirely, so they are backfilled as counter sales: that is what
// they were, and leaving the field absent would drop them out of every
// per-channel report.
db.version(4)
  .stores({
    channels: "id, sortOrder",
    channel_prices: "id, menuItemId, channelId, [menuItemId+channelId]",
    platform_fees: "saleId, channelId, platformOrderId, payoutBatchId",
  })
  .upgrade(async (tx) => {
    await tx
      .table("sales")
      .toCollection()
      .modify((sale: { channelId?: string; platformOrderId?: string | null; merchantFundedDiscountSatang?: number }) => {
        sale.channelId = WALK_IN.id;
        sale.platformOrderId = null;
        sale.merchantFundedDiscountSatang = 0;
      });

    // Ingredients seeded before `isPackaging` existed have no such key, and an
    // absent flag reads as false — which would file cups under ingredients and
    // quietly understate what packaging costs on every channel.
    const packagingIds = new Set(
      DEFAULT_INGREDIENTS.filter((i) => i.isPackaging).map((i) => i.id),
    );
    await tx
      .table("ingredients")
      .toCollection()
      .modify((ingredient: { id: string; isPackaging?: boolean }) => {
        if (ingredient.isPackaging === undefined) {
          ingredient.isPackaging = packagingIds.has(ingredient.id);
        }
      });
  });

// v5 — Phase 5 payout reconciliation. Purely additive; nothing existing needs
// backfilling, because an unsettled sale is exactly what `payoutBatchId: null`
// already meant.
db.version(5).stores({
  payout_batches: "id, channelId, importedAt",
  statement_rows: "id, batchId, platformOrderId",
  payout_exceptions: "id, batchId, kind, platformOrderId, reason",
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
  { id: "matcha", name: "Matcha", unit: "g", onHand: 0, reorderPoint: 20_000, costPerUnit: 2_000_000, sortOrder: 0, isPackaging: false },
  { id: "hojicha-leaf", name: "Hojicha leaf", unit: "g", onHand: 0, reorderPoint: 30_000, costPerUnit: 600_000, sortOrder: 1, isPackaging: false },
  { id: "milk", name: "Milk", unit: "ml", onHand: 0, reorderPoint: 1_000_000, costPerUnit: 5_000, sortOrder: 2, isPackaging: false },
  { id: "cup", name: "Cup", unit: "piece", onHand: 0, reorderPoint: 20_000, costPerUnit: 200_000, sortOrder: 3, isPackaging: true },
  // Delivery-only packaging, consumed via the channel recipe override.
  { id: "lid", name: "Sealed lid", unit: "piece", onHand: 0, reorderPoint: 20_000, costPerUnit: 150_000, sortOrder: 4, isPackaging: true },
  { id: "carrier-bag", name: "Carrier bag", unit: "piece", onHand: 0, reorderPoint: 20_000, costPerUnit: 300_000, sortOrder: 5, isPackaging: true },
];

/** Opening stock, in milli-units. */
const OPENING_STOCK: readonly (readonly [string, number])[] = [
  ["matcha", 200_000],
  ["hojicha-leaf", 200_000],
  ["milk", 4_000_000],
  ["cup", 100_000],
  ["lid", 100_000],
  ["carrier-bag", 100_000],
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

/**
 * Channels, seeded from the domain constants so the stored contract terms
 * start as the documented defaults rather than a second set of numbers that
 * can drift from them.
 *
 * **Read your contract and edit these.** PLAN.md names trusting the defaults
 * as this phase's risk: `gpBasis` and `gpAppliesTo` encode the harsher
 * reading — commission on the VAT-inclusive list price, charged before any
 * merchant-funded discount — and the difference is material.
 */
const DEFAULT_CHANNELS: readonly ChannelRecord[] = [
  { ...WALK_IN, sortOrder: 0 },
  { ...GRAB, sortOrder: 1 },
];

/**
 * Delivery list prices. Marked up over the counter to absorb 30% commission —
 * and still worth checking against the break-even tool on the Day screen,
 * because "marked up" and "actually profitable" are not the same claim.
 */
const DEFAULT_CHANNEL_PRICES: readonly ChannelPriceRecord[] = [
  { id: "GRAB:usucha", menuItemId: "usucha", channelId: GRAB.id, priceSatang: 11_500, validFrom: "2026-01-01T00:00:00+07:00", validTo: null },
  { id: "GRAB:iced-matcha", menuItemId: "iced-matcha", channelId: GRAB.id, priceSatang: 11_500, validFrom: "2026-01-01T00:00:00+07:00", validTo: null },
  { id: "GRAB:hojicha", menuItemId: "hojicha", channelId: GRAB.id, priceSatang: 10_900, validFrom: "2026-01-01T00:00:00+07:00", validTo: null },
  { id: "GRAB:matcha-latte", menuItemId: "matcha-latte", channelId: GRAB.id, priceSatang: 12_900, validFrom: "2026-01-01T00:00:00+07:00", validTo: null },
];

/**
 * Delivery packaging, via the channel-scoped recipe override that
 * `stock/recipe.ts` already implements: a lid is *added* on Grab because it
 * has no base line, and the cup is *replaced* with a sealed one at a higher
 * count. Counter orders are untouched, so delivery packaging never pollutes
 * walk-in COGS.
 */
const DELIVERY_RECIPES: readonly RecipeLineRecord[] = [
  { id: "usucha:lid:GRAB", menuItemId: "usucha", ingredientId: "lid", qty: 1_000, channelId: GRAB.id },
  { id: "iced-matcha:lid:GRAB", menuItemId: "iced-matcha", ingredientId: "lid", qty: 1_000, channelId: GRAB.id },
  { id: "hojicha:lid:GRAB", menuItemId: "hojicha", ingredientId: "lid", qty: 1_000, channelId: GRAB.id },
  { id: "matcha-latte:lid:GRAB", menuItemId: "matcha-latte", ingredientId: "lid", qty: 1_000, channelId: GRAB.id },
  { id: "matcha-latte:bag:GRAB", menuItemId: "matcha-latte", ingredientId: "carrier-bag", qty: 1_000, channelId: GRAB.id },
  { id: "usucha:bag:GRAB", menuItemId: "usucha", ingredientId: "carrier-bag", qty: 1_000, channelId: GRAB.id },
  { id: "iced-matcha:bag:GRAB", menuItemId: "iced-matcha", ingredientId: "carrier-bag", qty: 1_000, channelId: GRAB.id },
  { id: "hojicha:bag:GRAB", menuItemId: "hojicha", ingredientId: "carrier-bag", qty: 1_000, channelId: GRAB.id },
];

/**
 * Add only the rows whose id is not already present, and report which landed.
 *
 * An all-or-nothing `count() === 0` guard is wrong for reference data: it
 * makes seeding a one-time event, so every row a later phase adds — a delivery
 * recipe, a new packaging ingredient — silently never reaches an install that
 * was seeded before that phase existed. Adding per row is additive and leaves
 * any operator edits to existing rows untouched.
 */
async function addMissing<T extends { readonly id: string }>(
  table: EntityTable<T, "id">,
  rows: readonly T[],
): Promise<readonly T[]> {
  const existing = new Set<string>(
    (await table.toCollection().primaryKeys()) as unknown as string[],
  );
  const missing = rows.filter((row) => !existing.has(row.id));
  if (missing.length > 0) await table.bulkAdd(missing as T[]);
  return missing;
}

/** Seed a fresh install with a starter menu, ingredients, recipes, and device config. Idempotent. */
export async function seedIfEmpty(): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.menu_items,
      db.device_config,
      db.ingredients,
      db.recipe_lines,
      db.stock_movements,
      db.channels,
      db.channel_prices,
    ],
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
      // Reference data is seeded per row, so rows introduced by a later phase
      // still reach an install seeded before that phase existed.
      await addMissing(db.recipe_lines, [...DEFAULT_RECIPES, ...DELIVERY_RECIPES]);
      await addMissing(db.channels, DEFAULT_CHANNELS);
      await addMissing(db.channel_prices, DEFAULT_CHANNEL_PRICES);

      const at = new Date().toISOString();
      const newIngredients = await addMissing(
        db.ingredients,
        DEFAULT_INGREDIENTS.map((ingredient) => ({
          ...ingredient,
          onHand: OPENING_STOCK.find(([id]) => id === ingredient.id)?.[1] ?? 0,
        })),
      );
      // Opening stock is a real PURCHASE movement, so the ledger stays the
      // source of truth even for ingredients that arrive in a later phase.
      if (newIngredients.length > 0) {
        await db.stock_movements.bulkAdd(
          newIngredients
            .filter((ingredient) => ingredient.onHand !== 0)
            .map((ingredient) => ({
              id: `opening-${ingredient.id}`,
              ingredientId: ingredient.id,
              kind: "PURCHASE" as const,
              delta: ingredient.onHand,
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
