/**
 * invoice.ts — building a Thai tax invoice from a sale that has already been rung.
 *
 * Two documents live here, and they are not variants of one layout:
 *
 *  - **ใบกำกับภาษีอย่างย่อ** (abbreviated) — what a retail counter hands every
 *    customer. It does not identify the buyer, shows VAT-inclusive amounts, and
 *    must carry the POS machine number approved by the Revenue Department.
 *  - **ใบกำกับภาษี** (full) — issued on request to a customer who needs to claim
 *    the input tax. It identifies the buyer by name, address and tax ID, and
 *    states VAT as a separate figure.
 *
 * Three rules this module exists to enforce:
 *
 *  1. **Rule 7.** No tax invoice while unregistered, in either form, for any
 *     reason. There is no override parameter, because the only reason to add
 *     one would be to use it.
 *  2. **Rule 5.** The figures come from the sale record and are never
 *     recomputed. If the supplied figures do not tie, we refuse rather than
 *     silently correcting — an invoice that quietly disagrees with the sale it
 *     came from is worse than no invoice.
 *  3. **One original per number.** A reprint is marked สำเนา. Two unmarked
 *     originals of one invoice number is precisely the document a duplicate
 *     input-tax claim is built on.
 *
 * Pure module: no Dexie, no React, no I/O.
 *
 * **Not accountancy advice.** The required field list, and whether an
 * abbreviated invoice may be issued at all, depend on Revenue Department
 * approval of the POS machine. Have an accountant review the layout before it
 * is handed to a customer — PLAN.md makes that Phase 6's completion bar.
 */

import { sum, type BasisPoints, type Satang } from "../money.js";
import { formatBranch, isValidThaiTaxId } from "./registration.js";

export class TaxInvoiceError extends Error {
  override readonly name = "TaxInvoiceError";
}

/** Terms of art. Verbatim Thai, never machine-translated — see DESIGN.md. */
export const ABBREVIATED_HEADING_TH = "ใบกำกับภาษีอย่างย่อ";
export const FULL_HEADING_TH = "ใบกำกับภาษี";
export const VAT_INCLUDED_NOTICE_TH = "ราคานี้รวมภาษีมูลค่าเพิ่มแล้ว";
export const ORIGINAL_LABEL_TH = "ต้นฉบับ";
export const COPY_LABEL_TH = "สำเนา";

export type InvoiceKind = "ABBREVIATED" | "FULL";

export interface InvoiceSeller {
  readonly name: string;
  readonly address: string;
  readonly taxId: string;
  readonly branchCode: string;
  /** The Revenue Department's approved machine number. Required on abbreviated. */
  readonly posMachineNumber: string;
}

export interface InvoiceBuyer {
  readonly name: string;
  readonly address: string;
  /** Null for an individual. Without it the buyer cannot claim the input tax. */
  readonly taxId: string | null;
}

export interface InvoiceSourceLine {
  readonly description: string;
  readonly qty: number;
  /** VAT-inclusive unit price, as rung. */
  readonly unitPrice: Satang;
  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;
}

/** A sale, as stored. Everything here was frozen at checkout. */
export interface InvoiceSource {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly issuedAt: string;
  readonly vatRegistered: boolean;
  readonly taxInvoiceEligible: boolean;
  readonly rateBp: BasisPoints;
  readonly authority: string;
  readonly provisional: boolean;
  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;
  readonly lines: readonly InvoiceSourceLine[];
}

export interface TaxInvoice {
  readonly kind: InvoiceKind;
  readonly headingTh: string;
  readonly headingEn: string;
  readonly invoiceNo: string;
  readonly issuedAt: string;
  /** The till receipt this invoice covers, so the two can be tied together. */
  readonly receiptNo: string;
  readonly saleId: string;

  readonly seller: InvoiceSeller;
  readonly branchLabel: string;
  readonly posMachineNumber: string;

  /** Null on an abbreviated invoice — it does not identify the buyer. */
  readonly buyer: InvoiceBuyer | null;
  /** True only for a full invoice to a buyer with a valid tax ID. */
  readonly buyerCanClaimInputTax: boolean;

  readonly lines: readonly InvoiceSourceLine[];
  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;
  readonly rateBp: BasisPoints;
  readonly authority: string;
  /** Carried through so the document can print the rates.ts warning. */
  readonly provisional: boolean;

  /** Set on abbreviated only: the amounts shown are VAT-inclusive. */
  readonly vatIncludedNotice: string | null;
  readonly originalityLabelTh: string;
  readonly isCopy: boolean;
}

export interface BuildInvoiceOptions {
  readonly kind: InvoiceKind;
  readonly invoiceNo: string;
  readonly seller: InvoiceSeller;
  /** Required for FULL, refused for ABBREVIATED. */
  readonly buyer?: InvoiceBuyer;
  /** A reprint. Marked สำเนา so only one original of a number ever exists. */
  readonly copy?: boolean;
}

export function buildTaxInvoice(source: InvoiceSource, opts: BuildInvoiceOptions): TaxInvoice {
  const { kind, invoiceNo, seller, buyer, copy = false } = opts;

  // ── Rule 7, first and unconditionally. ───────────────────────────────────
  // Both flags must agree. When they disagree the record is already wrong, and
  // trusting the permissive one is how a UI override arrives through the back
  // door of a data bug.
  if (!source.vatRegistered || !source.taxInvoiceEligible) {
    throw new TaxInvoiceError(
      "Cannot issue a tax invoice for a sale rung while unregistered — this is an offence, not a setting",
    );
  }
  if (source.rateBp <= 0) {
    throw new TaxInvoiceError(
      `Sale ${source.receiptNo} is marked VAT-registered but carries no rate — refusing to invent one`,
    );
  }

  if (invoiceNo.trim() === "") {
    throw new TaxInvoiceError("A tax invoice needs a serial number");
  }

  // ── Seller identity ──────────────────────────────────────────────────────
  if (seller.name.trim() === "" || seller.address.trim() === "") {
    throw new TaxInvoiceError("A tax invoice needs the seller's name and address");
  }
  assertTaxId("seller", seller.taxId);
  const branchLabel = branchLabelOf(seller.branchCode);

  // ── Kind-specific requirements ───────────────────────────────────────────
  if (kind === "ABBREVIATED") {
    if (seller.posMachineNumber.trim() === "") {
      throw new TaxInvoiceError(
        "An abbreviated tax invoice must carry the Revenue Department POS machine number",
      );
    }
    if (buyer !== undefined) {
      // An abbreviated invoice has nowhere to put a buyer. Dropping the details
      // silently would hand the customer a document that cannot do the job they
      // asked for, and they would not find out until their accountant did.
      throw new TaxInvoiceError(
        "An abbreviated tax invoice cannot identify a buyer — issue a full tax invoice (ใบกำกับภาษี) instead",
      );
    }
  } else {
    if (buyer === undefined) {
      throw new TaxInvoiceError("A full tax invoice needs the buyer's details");
    }
    if (buyer.name.trim() === "" || buyer.address.trim() === "") {
      throw new TaxInvoiceError("A full tax invoice needs the buyer's name and address");
    }
    if (buyer.taxId !== null) assertTaxId("buyer", buyer.taxId);
  }

  assertFiguresTie(source);

  return {
    kind,
    headingTh: kind === "ABBREVIATED" ? ABBREVIATED_HEADING_TH : FULL_HEADING_TH,
    headingEn: kind === "ABBREVIATED" ? "Abbreviated tax invoice" : "Tax invoice",
    invoiceNo,
    issuedAt: source.issuedAt,
    receiptNo: source.receiptNo,
    saleId: source.saleId,

    seller,
    branchLabel,
    posMachineNumber: seller.posMachineNumber,

    buyer: kind === "FULL" ? buyer! : null,
    buyerCanClaimInputTax:
      kind === "FULL" && buyer?.taxId != null && isValidThaiTaxId(buyer.taxId),

    lines: source.lines,
    gross: source.gross,
    net: source.net,
    vat: source.vat,
    rateBp: source.rateBp,
    authority: source.authority,
    provisional: source.provisional,

    vatIncludedNotice: kind === "ABBREVIATED" ? VAT_INCLUDED_NOTICE_TH : null,
    originalityLabelTh: copy ? COPY_LABEL_TH : ORIGINAL_LABEL_TH,
    isCopy: copy,
  };
}

/**
 * Re-raise an identity problem as a TaxInvoiceError, naming the party.
 *
 * The caller is a print button, and "the buyer's tax ID is wrong" is a thing
 * the operator can act on at the counter while the customer is still standing
 * there. A bare RegistrationError leaves them guessing which of the two IDs on
 * the document is the bad one.
 */
function assertTaxId(party: "seller" | "buyer", id: string): void {
  if (!isValidThaiTaxId(id)) {
    throw new TaxInvoiceError(`The ${party}'s tax ID is not a valid 13-digit Thai tax ID: "${id}"`);
  }
}

function branchLabelOf(branchCode: string): string {
  try {
    return formatBranch(branchCode);
  } catch (err) {
    throw new TaxInvoiceError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The invoice must reproduce the sale exactly. Refuse rather than repair.
 *
 * A repaired invoice is the worst outcome available: it looks correct, ties to
 * nothing, and the discrepancy surfaces at PP.30 time with no way to tell which
 * of the two documents was right.
 */
function assertFiguresTie(source: InvoiceSource): void {
  if (source.lines.length === 0) {
    throw new TaxInvoiceError("Cannot issue a tax invoice with no lines");
  }
  if (source.gross < 0) {
    throw new TaxInvoiceError(
      "Cannot issue a tax invoice for a negative amount — a reversal is a credit note (ใบลดหนี้), which this does not issue",
    );
  }
  if (source.net + source.vat !== source.gross) {
    throw new TaxInvoiceError(
      `Sale ${source.receiptNo}: net + vat does not equal gross (${source.net} + ${source.vat} ≠ ${source.gross})`,
    );
  }
  const tie = (label: string, part: Satang, whole: Satang): void => {
    if (part !== whole) {
      throw new TaxInvoiceError(
        `Sale ${source.receiptNo}: line ${label} (${part}) does not tie to the document (${whole})`,
      );
    }
  };
  tie("gross", sum(source.lines.map((l) => l.gross)), source.gross);
  tie("net", sum(source.lines.map((l) => l.net)), source.net);
  tie("vat", sum(source.lines.map((l) => l.vat)), source.vat);
}
