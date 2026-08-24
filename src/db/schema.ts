/**
 * schema.ts — local Dexie (IndexedDB) store.
 *
 * `sales` and `sale_lines` are append-only: there is no update or delete path.
 * A void is a new row in `voids` pointing at the original sale id, never a
 * mutation of the sale itself — see CLAUDE.md rule 4.
 */

import Dexie, { type EntityTable } from "dexie";
import type { BasisPoints } from "../money.js";

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

export const db = new Dexie("mini-pos-app") as Dexie & {
  menu_items: EntityTable<MenuItemRecord, "id">;
  sales: EntityTable<SaleRecord, "id">;
  sale_lines: EntityTable<SaleLineRecord, "id">;
  voids: EntityTable<VoidRecord, "id">;
  device_config: EntityTable<DeviceConfigRecord, "id">;
};

db.version(1).stores({
  menu_items: "id, sortOrder",
  sales: "id, receiptNo, createdAt",
  sale_lines: "id, saleId, menuItemId",
  voids: "id, saleId, receiptNo",
  device_config: "id",
});

const DEFAULT_MENU: readonly MenuItemRecord[] = [
  { id: "usucha", name: "Usucha", priceSatang: 8_000, sortOrder: 0, soldOut: false },
  { id: "iced-matcha", name: "Iced Matcha", priceSatang: 8_000, sortOrder: 1, soldOut: false },
  { id: "hojicha", name: "Hojicha", priceSatang: 7_500, sortOrder: 2, soldOut: false },
  { id: "matcha-latte", name: "Matcha Latte", priceSatang: 9_000, sortOrder: 3, soldOut: false },
];

/** Seed a fresh install with a starter menu and device config. Idempotent. */
export async function seedIfEmpty(): Promise<void> {
  await db.transaction("rw", db.menu_items, db.device_config, async () => {
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
  });
}
