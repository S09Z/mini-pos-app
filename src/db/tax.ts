/**
 * tax.ts — VAT mode against local storage.
 *
 * Four jobs, all of them wiring the pure `tax/**` modules to Dexie:
 *
 *  - **Registration** as an append-only ledger. `registrationStateAt()` answers
 *    the dated question — was I registered *then* — which is what both the sale
 *    path and a reprint of an old receipt actually need.
 *  - **The watchdog**, folded over real sales less voids, so the 1.8M line is
 *    watched by the till rather than by someone remembering to add it up.
 *  - **Tax invoices**, issued against a sale that has already been rung, with
 *    their own serial sequence and a copy-marked reprint.
 *  - **PP.30**, aggregated from sales, voids and purchases.
 *
 * Rule 7 is enforced in `tax/invoice.ts` and again here at the point of issue:
 * the number is not consumed unless the document can legally be built.
 */

import { satang, type Satang } from "../money.js";
import {
  registrationAt,
  validateRegistrationLedger,
  vatWatchdog,
  type RegistrationEvent,
  type RegistrationState,
  type RevenuePoint,
  type Watchdog,
} from "../tax/registration.js";
import {
  buildTaxInvoice,
  type InvoiceBuyer,
  type InvoiceKind,
  type InvoiceSource,
  type TaxInvoice,
} from "../tax/invoice.js";
import {
  buildPp30,
  outputTaxEntries,
  pp30Series,
  type InputTaxEntry,
  type OutputTaxEntry,
  type Pp30,
  type SaleForTax,
  type VoidForTax,
} from "../tax/pp30.js";
import {
  db,
  type DeviceConfigRecord,
  type PurchaseRecord,
  type RegistrationEventRecord,
  type SaleRecord,
  type TaxInvoiceRecord,
} from "./schema.js";

export class TaxError extends Error {
  override readonly name = "TaxError";
}

/** Storage shape back to the domain shape. */
const asEvent = (record: RegistrationEventRecord): RegistrationEvent => ({
  id: record.id,
  kind: record.kind,
  effectiveFrom: record.effectiveFrom,
  taxId: record.taxId,
  branchCode: record.branchCode,
  posMachineNumber: record.posMachineNumber,
  note: record.note,
});

export async function registrationLedger(): Promise<RegistrationEvent[]> {
  const rows = await db.registration_events.toArray();
  return rows.map(asEvent);
}

/** The registration state in force at an instant. Defaults to now. */
export async function registrationStateAt(at: Date = new Date()): Promise<RegistrationState> {
  return registrationAt(await registrationLedger(), at);
}

/**
 * Append a registration event.
 *
 * The whole ledger is re-validated, not just the new row, because the rules
 * that matter here are about the sequence — two events at one instant, a
 * registration with no machine number — and those are only visible whole.
 *
 * Validate and append inside one transaction, or two tabs could each validate
 * against a ledger that does not yet contain the other's event and both land.
 */
export async function appendRegistrationEvent(
  event: Omit<RegistrationEventRecord, "id" | "recordedAt">,
): Promise<RegistrationEventRecord> {
  const record: RegistrationEventRecord = {
    ...event,
    id: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
  };

  return db.transaction("rw", db.registration_events, async () => {
    const existing = (await db.registration_events.toArray()).map(asEvent);
    validateRegistrationLedger([...existing, asEvent(record)]);
    await db.registration_events.add(record);
    return record;
  });
}

async function requireDevice(): Promise<DeviceConfigRecord> {
  const device = await db.device_config.get("device");
  if (!device) throw new TaxError("Device config missing — run seedIfEmpty() first");
  return device;
}

export async function saveBusinessIdentity(name: string, address: string): Promise<void> {
  const device = await requireDevice();
  await db.device_config.put({ ...device, businessName: name, businessAddress: address });
}

/**
 * Trailing-twelve-month watchdog over real takings.
 *
 * Voided sales are excluded, because they were not revenue — but the exclusion
 * happens here rather than by date-filtering, so a sale voided next month
 * still comes out of the window it was rung in.
 */
export async function currentWatchdog(asOf: Date = new Date()): Promise<Watchdog> {
  const [sales, voids] = await Promise.all([db.sales.toArray(), db.voids.toArray()]);
  const voidedSaleIds = new Set(voids.map((v) => v.saleId));

  const points: RevenuePoint[] = sales
    .filter((sale) => !voidedSaleIds.has(sale.id))
    .map((sale) => ({ id: sale.id, at: sale.createdAt, gross: satang(sale.grossSatang) }));

  return vatWatchdog(points, asOf);
}

/**
 * Assemble the invoice source from what was frozen on the sale.
 *
 * Nothing is recomputed — not the rate, not the VAT, not the line allocation.
 * A reprint issued after a decree change must reproduce the original document
 * exactly, which is only possible because the sale carries its own figures.
 */
export async function invoiceSourceFor(saleId: string): Promise<InvoiceSource> {
  const sale = await db.sales.get(saleId);
  if (!sale) throw new TaxError("Sale not found");

  const lines = await db.sale_lines.where("saleId").equals(saleId).toArray();
  if (lines.length === 0) throw new TaxError(`Sale ${sale.receiptNo} has no lines`);

  const voided = await db.voids.where("saleId").equals(saleId).first();
  if (voided) {
    throw new TaxError(
      `Sale ${sale.receiptNo} was voided by ${voided.receiptNo} — a reversal needs a credit note (ใบลดหนี้), not a tax invoice`,
    );
  }

  return {
    saleId: sale.id,
    receiptNo: sale.receiptNo,
    issuedAt: sale.createdAt,
    vatRegistered: sale.vatRegistered,
    taxInvoiceEligible: sale.taxInvoiceEligible,
    rateBp: sale.rateBp,
    authority: sale.authority,
    provisional: sale.provisional,
    gross: satang(sale.grossSatang),
    net: satang(sale.netSatang),
    vat: satang(sale.vatSatang),
    lines: lines.map((line) => ({
      description: line.name,
      qty: line.qty,
      unitPrice: satang(line.unitPriceSatang),
      gross: satang(line.grossSatang),
      net: satang(line.netSatang),
      vat: satang(line.vatSatang),
    })),
  };
}

export interface IssueInvoiceOptions {
  readonly kind: InvoiceKind;
  readonly buyer?: InvoiceBuyer;
}

/**
 * Issue a tax invoice for a sale, consuming the next serial number.
 *
 * The seller identity comes from the registration state *at the time of the
 * sale*, not today's: an invoice for a March sale must carry the tax ID and
 * machine number that were in force in March.
 *
 * The document is built before the number is consumed, so a refusal — rule 7,
 * a missing machine number, figures that do not tie — leaves no gap in the
 * sequence. A gap in a tax invoice sequence has to be explained to the Revenue
 * Department, and "the software tried and failed" is not an explanation
 * anyone wants to give.
 */
export async function issueTaxInvoice(
  saleId: string,
  opts: IssueInvoiceOptions,
): Promise<{ invoice: TaxInvoice; record: TaxInvoiceRecord }> {
  const source = await invoiceSourceFor(saleId);
  const registration = await registrationStateAt(new Date(Date.parse(source.issuedAt)));

  if (!registration.registered) {
    throw new TaxError(
      "No VAT registration was in force when this sale was rung — a tax invoice cannot be issued for it",
    );
  }

  const device = await requireDevice();
  if (device.businessName.trim() === "" || device.businessAddress.trim() === "") {
    throw new TaxError(
      "Set the business name and address on the Tax screen before issuing a tax invoice",
    );
  }

  const seller = {
    name: device.businessName,
    address: device.businessAddress,
    taxId: registration.taxId!,
    branchCode: registration.branchCode!,
    posMachineNumber: registration.posMachineNumber!,
  };

  return db.transaction("rw", [db.tax_invoices, db.device_config], async () => {
    const current = await requireDevice();
    const invoiceNo = `${current.taxInvoicePrefix}-${current.nextTaxInvoiceSeq}`;

    // Built first: a throw here rolls the transaction back with the sequence
    // untouched, which is the whole point of doing it in this order.
    const invoice = buildTaxInvoice(source, {
      kind: opts.kind,
      invoiceNo,
      seller,
      ...(opts.buyer === undefined ? {} : { buyer: opts.buyer }),
    });

    const record: TaxInvoiceRecord = {
      id: crypto.randomUUID(),
      invoiceNo,
      kind: invoice.kind,
      saleId: source.saleId,
      receiptNo: source.receiptNo,
      issuedAt: new Date().toISOString(),
      copy: false,
      sellerName: seller.name,
      sellerAddress: seller.address,
      sellerTaxId: seller.taxId,
      branchCode: seller.branchCode,
      posMachineNumber: seller.posMachineNumber,
      buyerName: invoice.buyer?.name ?? null,
      buyerAddress: invoice.buyer?.address ?? null,
      buyerTaxId: invoice.buyer?.taxId ?? null,
      grossSatang: invoice.gross,
      netSatang: invoice.net,
      vatSatang: invoice.vat,
      rateBp: invoice.rateBp,
    };

    await db.tax_invoices.add(record);
    await db.device_config.put({
      ...current,
      nextTaxInvoiceSeq: current.nextTaxInvoiceSeq + 1,
    });

    return { invoice, record };
  });
}

/**
 * Reprint an issued invoice, marked สำเนา.
 *
 * Rebuilt from the stored record rather than from today's settings, and it
 * never consumes a new number: the reprint is the same document, and marking
 * it as a copy is what keeps one original per number true.
 */
export async function reprintTaxInvoice(invoiceRecordId: string): Promise<TaxInvoice> {
  const record = await db.tax_invoices.get(invoiceRecordId);
  if (!record) throw new TaxError("Tax invoice not found");

  const source = await invoiceSourceFor(record.saleId);
  const invoice = buildTaxInvoice(source, {
    kind: record.kind,
    invoiceNo: record.invoiceNo,
    seller: {
      name: record.sellerName,
      address: record.sellerAddress,
      taxId: record.sellerTaxId,
      branchCode: record.branchCode,
      posMachineNumber: record.posMachineNumber,
    },
    ...(record.buyerName === null
      ? {}
      : {
          buyer: {
            name: record.buyerName,
            address: record.buyerAddress ?? "",
            taxId: record.buyerTaxId,
          },
        }),
    copy: true,
  });

  // The reprint is itself a row: how many times a document was handed out, and
  // when, is worth being able to answer.
  await db.tax_invoices.add({
    ...record,
    id: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    copy: true,
  });

  return invoice;
}

/** Every invoice issued against a sale, oldest first. */
export async function invoicesForSale(saleId: string): Promise<TaxInvoiceRecord[]> {
  const rows = await db.tax_invoices.where("saleId").equals(saleId).toArray();
  return rows.sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : 1));
}

export async function recordPurchase(
  entry: Omit<PurchaseRecord, "id">,
): Promise<PurchaseRecord> {
  if (entry.vatSatang < 0 || entry.netSatang < 0) {
    throw new TaxError("A purchase cannot have a negative amount — record a credit note separately");
  }
  const record: PurchaseRecord = { ...entry, id: crypto.randomUUID() };
  await db.purchases.add(record);
  return record;
}

/** Sales, voids and purchases reduced to what PP.30 needs. */
async function taxLedger(): Promise<{
  output: readonly OutputTaxEntry[];
  input: readonly InputTaxEntry[];
}> {
  const [sales, voids, purchases] = await Promise.all([
    db.sales.toArray(),
    db.voids.toArray(),
    db.purchases.toArray(),
  ]);

  const forTax: SaleForTax[] = sales.map((sale: SaleRecord) => ({
    id: sale.id,
    receiptNo: sale.receiptNo,
    at: sale.createdAt,
    net: satang(sale.netSatang),
    vat: satang(sale.vatSatang),
  }));

  const voidsForTax: VoidForTax[] = voids.map((v) => ({
    saleId: v.saleId,
    receiptNo: v.receiptNo,
    at: v.createdAt,
  }));

  const input: InputTaxEntry[] = purchases.map((p) => ({
    id: p.id,
    at: p.at,
    supplier: p.supplier,
    invoiceNo: p.invoiceNo,
    net: satang(p.netSatang),
    vat: satang(p.vatSatang),
    claimable: p.claimable,
    disallowedReason: p.disallowedReason,
  }));

  return { output: outputTaxEntries(forTax, voidsForTax), input };
}

/** One month's return. */
export async function buildReturn(period: string, creditBroughtForward?: Satang): Promise<Pp30> {
  const { output, input } = await taxLedger();
  // The credit is chained by the series, so a single month asked for on its own
  // has to be told what came before it rather than assuming zero.
  const brought = creditBroughtForward ?? (await creditBefore(period, output, input));
  return buildPp30(period, output, input, brought);
}

async function creditBefore(
  period: string,
  output: readonly OutputTaxEntry[],
  input: readonly InputTaxEntry[],
): Promise<Satang> {
  const series = pp30Series(output, input);
  const priorMonths = series.filter((r) => r.period < period);
  return priorMonths[priorMonths.length - 1]?.creditCarriedForward ?? satang(0);
}

/** Every month from the first entry to the last, with the credit chained. */
export async function buildReturnSeries(): Promise<readonly Pp30[]> {
  const { output, input } = await taxLedger();
  return pp30Series(output, input);
}

export interface TaxView {
  readonly registration: RegistrationState;
  readonly events: readonly RegistrationEventRecord[];
  readonly watchdog: Watchdog;
  readonly returns: readonly Pp30[];
  readonly purchases: readonly PurchaseRecord[];
  readonly invoices: readonly TaxInvoiceRecord[];
  readonly businessName: string;
  readonly businessAddress: string;
  readonly taxInvoicePrefix: string;
  readonly nextTaxInvoiceSeq: number;
}

/** Everything the Tax screen renders, in one read. */
export async function buildTaxView(asOf: Date = new Date()): Promise<TaxView> {
  const [events, watchdog, returns, purchases, invoices, device] = await Promise.all([
    db.registration_events.toArray(),
    currentWatchdog(asOf),
    buildReturnSeries(),
    db.purchases.toArray(),
    db.tax_invoices.toArray(),
    requireDevice(),
  ]);

  return {
    registration: registrationAt(events.map(asEvent), asOf),
    events: [...events].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
    watchdog,
    returns: [...returns].reverse(),
    purchases: [...purchases].sort((a, b) => (a.at < b.at ? 1 : -1)),
    invoices: [...invoices].sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)),
    businessName: device.businessName,
    businessAddress: device.businessAddress,
    taxInvoicePrefix: device.taxInvoicePrefix,
    nextTaxInvoiceSeq: device.nextTaxInvoiceSeq,
  };
}
