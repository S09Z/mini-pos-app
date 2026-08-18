/**
 * vat.ts — VAT extraction and document-level computation.
 *
 * Thai retail prices are VAT-inclusive: a ฿100 latte costs ฿100 at the counter
 * and the VAT is extracted backwards out of that figure.
 *
 * Two invariants hold everywhere in this module:
 *
 *   net + vat === gross                       (always, exactly)
 *   sum(line.net) + sum(line.vat) === gross   (always, exactly)
 *
 * They hold because VAT is derived by *subtraction* rather than by rounding
 * both halves independently, and because per-line figures are allocated down
 * from the document total by largest remainder rather than computed per line.
 * Rounding each line separately drifts by a satang or two per receipt, which is
 * invisible per sale and impossible to reconcile at PP.30 time.
 */

import { satang, sum, allocate, type Satang, type BasisPoints } from "../money.js";

export class VatError extends Error {
  override readonly name = "VatError";
}

export interface VatSplit {
  readonly net: Satang;
  readonly vat: Satang;
  readonly gross: Satang;
  readonly rateBp: BasisPoints;
}

function assertRate(bp: BasisPoints): void {
  if (!Number.isInteger(bp) || bp < 0) {
    throw new VatError(`Invalid VAT rate in basis points: ${bp}`);
  }
}

/**
 * Extract VAT from a VAT-inclusive amount.
 *
 * net = round(gross × 10000 / (10000 + rateBp)), then vat = gross − net.
 * Deriving vat by subtraction is what guarantees the parts tie.
 */
export function extractInclusive(gross: Satang, rateBp: BasisPoints): VatSplit {
  assertRate(rateBp);
  const sign = gross < 0 ? -1 : 1;
  const net = satang(sign * Math.round((Math.abs(gross) * 10_000) / (10_000 + rateBp)));
  return { net, vat: satang(gross - net), gross, rateBp };
}

/** Add VAT onto a VAT-exclusive amount (wholesale / supplier invoices). */
export function addExclusive(net: Satang, rateBp: BasisPoints): VatSplit {
  assertRate(rateBp);
  const sign = net < 0 ? -1 : 1;
  const vat = satang(sign * Math.round((Math.abs(net) * rateBp) / 10_000));
  return { net, vat, gross: satang(net + vat), rateBp };
}

export interface DocumentLineInput {
  readonly lineId: string;
  /** VAT-inclusive amount for the whole line (unit price × qty, less discount). */
  readonly gross: Satang;
}

export interface DocumentLineResult extends DocumentLineInput {
  readonly net: Satang;
  readonly vat: Satang;
}

export interface DocumentVatResult {
  readonly vatRegistered: boolean;
  readonly rateBp: BasisPoints;
  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;
  readonly lines: readonly DocumentLineResult[];
  /** True only when the seller may legally issue a tax invoice for this sale. */
  readonly taxInvoiceEligible: boolean;
}

/**
 * Compute VAT for a whole sale.
 *
 * When `vatRegistered` is false the result is zero VAT and net === gross. A
 * business under the 1.8M THB threshold is not merely exempt from charging VAT
 * — issuing a tax invoice while unregistered is an offence, so this path also
 * hard-blocks tax-invoice eligibility rather than leaving it to the UI.
 */
export function computeDocumentVat(
  lines: readonly DocumentLineInput[],
  opts: { rateBp: BasisPoints; vatRegistered: boolean },
): DocumentVatResult {
  const { rateBp, vatRegistered } = opts;
  assertRate(rateBp);
  if (lines.length === 0) throw new VatError("Cannot compute VAT for a document with no lines");

  const ids = new Set(lines.map((l) => l.lineId));
  if (ids.size !== lines.length) throw new VatError("Duplicate lineId in document");

  const gross = sum(lines.map((l) => l.gross));

  if (!vatRegistered) {
    return {
      vatRegistered: false,
      rateBp: 0,
      gross,
      net: gross,
      vat: satang(0),
      lines: lines.map((l) => ({ ...l, net: l.gross, vat: satang(0) })),
      taxInvoiceEligible: false,
    };
  }

  const doc = extractInclusive(gross, rateBp);

  // Allocate the document VAT back onto lines, weighted by line gross.
  const weights = lines.map((l) => Math.abs(l.gross));
  const vatParts = allocate(doc.vat, weights);

  const resultLines: DocumentLineResult[] = lines.map((l, i) => {
    const vat = vatParts[i]!;
    return { ...l, vat, net: satang(l.gross - vat) };
  });

  // Belt and braces: these should be unreachable, but a silent mismatch here
  // would corrupt the ledger, so we would rather crash than book it.
  if (sum(resultLines.map((l) => l.vat)) !== doc.vat) {
    throw new VatError("Line VAT allocation does not tie to document VAT");
  }
  if (sum(resultLines.map((l) => l.net)) !== doc.net) {
    throw new VatError("Line net allocation does not tie to document net");
  }

  return {
    vatRegistered: true,
    rateBp,
    gross,
    net: doc.net,
    vat: doc.vat,
    lines: resultLines,
    taxInvoiceEligible: true,
  };
}

/** Output VAT minus input VAT — the PP.30 payable (negative = credit carried). */
export function vatPayable(outputVat: Satang, inputVat: Satang): Satang {
  return satang(outputVat - inputVat);
}

/**
 * Trailing-12-month registration watchdog.
 *
 * Registration becomes compulsory above 1,800,000 THB of annual revenue, and
 * the duty to register arises within 30 days of crossing. Businesses miss it
 * because takings creep up gradually, so we warn well before the line.
 */
export const VAT_REGISTRATION_THRESHOLD: Satang = satang(180_000_000);

export function registrationStatus(
  trailing12mRevenue: Satang,
  warnAtBp: BasisPoints = 8_300, // 83% ≈ 1.5M THB
): { readonly required: boolean; readonly approaching: boolean; readonly usedBp: number } {
  const usedBp = Math.round((trailing12mRevenue * 10_000) / VAT_REGISTRATION_THRESHOLD);
  return {
    required: trailing12mRevenue > VAT_REGISTRATION_THRESHOLD,
    approaching: usedBp >= warnAtBp && trailing12mRevenue <= VAT_REGISTRATION_THRESHOLD,
    usedBp,
  };
}
