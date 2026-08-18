/**
 * voids.ts — compensating records, never mutation.
 *
 * Voiding a sale writes a new row to `voids` pointing at the original sale id.
 * The original `sales`/`sale_lines` rows are never touched — see CLAUDE.md
 * rule 4. This is how theft (or an operator quietly "fixing" a till count)
 * becomes visible in the record instead of disappearing from it.
 */

import { db, type VoidRecord } from "./schema.js";
import { nextReceiptNumber } from "./receipts.js";

export class VoidError extends Error {
  override readonly name = "VoidError";
}

export async function voidSale(saleId: string, enteredPin: string): Promise<VoidRecord> {
  const device = await db.device_config.get("device");
  if (!device) throw new VoidError("Device config missing — run seedIfEmpty() first");
  if (enteredPin !== device.ownerPin) throw new VoidError("Incorrect owner PIN");

  const sale = await db.sales.get(saleId);
  if (!sale) throw new VoidError("Sale not found");

  const already = await db.voids.where("saleId").equals(saleId).first();
  if (already) throw new VoidError(`Sale ${sale.receiptNo} has already been voided`);

  const receiptNo = await nextReceiptNumber();
  const record: VoidRecord = {
    id: crypto.randomUUID(),
    saleId,
    receiptNo,
    createdAt: new Date().toISOString(),
  };
  await db.voids.add(record);
  return record;
}
