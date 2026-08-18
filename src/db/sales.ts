/**
 * sales.ts — the one path that writes a sale.
 *
 * Wires the pure domain layer (rateAt, computeDocumentVat) to local storage:
 * the VAT rate and its authority are resolved and frozen onto the record here,
 * once, at checkout. Nothing downstream ever recomputes VAT at "today's rate"
 * — see CLAUDE.md rule 5.
 */

import { scale, sub, type Satang } from "../money.js";
import { rateAt } from "../tax/rates.js";
import { computeDocumentVat, type DocumentLineInput } from "../tax/vat.js";
import { db, type SaleRecord, type SaleLineRecord } from "./schema.js";
import { nextReceiptNumber } from "./receipts.js";

export class CheckoutError extends Error {
  override readonly name = "CheckoutError";
}

export interface CartLine {
  readonly menuItemId: string;
  readonly name: string;
  readonly unitPriceSatang: Satang;
  readonly qty: number;
}

export interface CheckoutResult {
  readonly sale: SaleRecord;
  readonly lines: readonly SaleLineRecord[];
}

export async function checkout(
  cart: readonly CartLine[],
  tenderedSatang: Satang,
): Promise<CheckoutResult> {
  if (cart.length === 0) throw new CheckoutError("Cannot check out an empty ticket");

  const device = await db.device_config.get("device");
  if (!device) throw new CheckoutError("Device config missing — run seedIfEmpty() first");

  const now = new Date();
  const rate = rateAt("VAT_TH", now);

  const docLines: DocumentLineInput[] = cart.map((l) => ({
    lineId: l.menuItemId,
    gross: scale(l.unitPriceSatang, l.qty),
  }));
  const doc = computeDocumentVat(docLines, {
    rateBp: rate.rateBp,
    vatRegistered: device.vatRegistered,
  });

  if (tenderedSatang < doc.gross) {
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
    tenderedSatang,
    changeSatang: sub(tenderedSatang, doc.gross),
  };

  const lines: SaleLineRecord[] = cart.map((cartLine, i) => {
    const docLine = doc.lines[i]!;
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
    };
  });

  await db.transaction("rw", db.sales, db.sale_lines, async () => {
    await db.sales.add(sale);
    await db.sale_lines.bulkAdd(lines);
  });

  return { sale, lines };
}
