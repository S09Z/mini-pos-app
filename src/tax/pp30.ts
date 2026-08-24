/**
 * pp30.ts — monthly VAT return aggregation (ภ.พ.30).
 *
 * Output tax minus input tax, per Bangkok calendar month, with the credit
 * chained forward. Three things here are easy to get wrong and expensive to
 * discover:
 *
 *  1. **A void is not a filter.** Removing voided sales from the month they
 *     were rung is correct only when the void happened in the same month. A
 *     January sale voided in February must stay in January — that return was
 *     filed with the VAT declared — and the reversal belongs in February, where
 *     the credit note was issued. So voids become *negative entries* dated at
 *     the void, never a `where not voided` filter.
 *
 *  2. **The month is a Bangkok month.** Same trap period.ts documents for the
 *     trading day, one boundary a month instead of one a night.
 *
 *  3. **Excess input tax is a credit, not a negative payable.** It carries
 *     forward, so a month cannot be read on its own; the chain is part of the
 *     answer.
 *
 * Pure module: no Dexie, no React. See CLAUDE.md.
 *
 * **Not accountancy advice.** Which input tax is claimable, and the treatment
 * of zero-rated and exempt supplies, are Revenue Department practice — flag
 * them for a Thai accountant rather than encoding a guess here. This module
 * aggregates what it is told and reports what it excluded.
 */

import { satang, sum, type Satang } from "../money.js";
import { bangkokDayOf } from "../day/period.js";

export class Pp30Error extends Error {
  override readonly name = "Pp30Error";
}

/** `YYYY-MM` of the Bangkok-local month an instant falls in. */
export function periodOf(instant: string): string {
  return bangkokDayOf(instant).slice(0, 7);
}

function assertPeriod(period: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Pp30Error(`Expected a YYYY-MM period, got "${period}"`);
  }
}

export type OutputSource = "SALE" | "VOID";

/** A sale reduced to its VAT figures, as frozen on the record at checkout. */
export interface SaleForTax {
  readonly id: string;
  readonly receiptNo: string;
  readonly at: string;
  readonly net: Satang;
  readonly vat: Satang;
}

export interface VoidForTax {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly at: string;
}

export interface OutputTaxEntry {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly at: string;
  readonly net: Satang;
  readonly vat: Satang;
  readonly source: OutputSource;
}

export interface InputTaxEntry {
  readonly id: string;
  readonly at: string;
  readonly supplier: string;
  readonly invoiceNo: string;
  readonly net: Satang;
  readonly vat: Satang;
  /** False when the VAT cannot be claimed — no tax invoice, entertainment, etc. */
  readonly claimable: boolean;
  readonly disallowedReason: string | null;
}

/**
 * Sales and their voids, flattened into signed entries dated at the instant
 * each actually happened.
 *
 * A void pointing at no sale is refused rather than dropped: silently ignoring
 * it would understate output tax by exactly the amount nobody noticed.
 */
export function outputTaxEntries(
  sales: readonly SaleForTax[],
  voids: readonly VoidForTax[],
): OutputTaxEntry[] {
  const byId = new Map(sales.map((s) => [s.id, s]));

  const entries: OutputTaxEntry[] = sales.map((s) => ({
    saleId: s.id,
    receiptNo: s.receiptNo,
    at: s.at,
    net: s.net,
    vat: s.vat,
    source: "SALE",
  }));

  for (const v of voids) {
    const original = byId.get(v.saleId);
    if (original === undefined) {
      throw new Pp30Error(
        `Void ${v.receiptNo} points at sale "${v.saleId}", which is not in the ledger`,
      );
    }
    entries.push({
      saleId: original.id,
      receiptNo: v.receiptNo,
      at: v.at,
      net: satang(-original.net),
      vat: satang(-original.vat),
      source: "VOID",
    });
  }

  return entries;
}

export interface Pp30 {
  readonly period: string;
  readonly sales: {
    readonly net: Satang;
    readonly vat: Satang;
    readonly entries: number;
  };
  readonly purchases: {
    readonly net: Satang;
    readonly vat: Satang;
    readonly entries: number;
    /** Input tax excluded from the claim, reported so it is visible rather than lost. */
    readonly disallowedVat: Satang;
    readonly disallowedEntries: number;
  };
  readonly outputVat: Satang;
  /** Claimable input tax only. */
  readonly inputVat: Satang;
  readonly creditBroughtForward: Satang;
  /** Never negative. Excess input tax becomes `creditCarriedForward` instead. */
  readonly payable: Satang;
  readonly creditCarriedForward: Satang;
}

export function buildPp30(
  period: string,
  output: readonly OutputTaxEntry[],
  input: readonly InputTaxEntry[],
  creditBroughtForward: Satang = satang(0),
): Pp30 {
  assertPeriod(period);
  if (creditBroughtForward < 0) {
    throw new Pp30Error("A credit brought forward cannot be negative");
  }

  const outRows = output.filter((e) => periodOf(e.at) === period);
  const inRows = input.filter((e) => periodOf(e.at) === period);
  const claimable = inRows.filter((e) => e.claimable);
  const disallowed = inRows.filter((e) => !e.claimable);

  const outputVat = sum(outRows.map((e) => e.vat));
  const inputVat = sum(claimable.map((e) => e.vat));

  // Signed once, then split. Deriving both halves from one figure is what
  // guarantees they cannot disagree — the same argument vat.ts makes for
  // deriving VAT by subtraction.
  const netVat = outputVat - inputVat - creditBroughtForward;

  return {
    period,
    sales: {
      net: sum(outRows.map((e) => e.net)),
      vat: outputVat,
      entries: outRows.length,
    },
    purchases: {
      net: sum(claimable.map((e) => e.net)),
      vat: inputVat,
      entries: inRows.length,
      disallowedVat: sum(disallowed.map((e) => e.vat)),
      disallowedEntries: disallowed.length,
    },
    outputVat,
    inputVat,
    creditBroughtForward,
    payable: satang(Math.max(0, netVat)),
    creditCarriedForward: satang(Math.max(0, -netVat)),
  };
}

/**
 * Every month from the first entry to the last, with the credit chained.
 *
 * Months with no activity are included deliberately. A nil return still has to
 * be filed, and — more to the point here — a credit has to travel through an
 * empty month rather than vanishing in the gap.
 */
export function pp30Series(
  output: readonly OutputTaxEntry[],
  input: readonly InputTaxEntry[],
): readonly Pp30[] {
  const periods = [
    ...output.map((e) => periodOf(e.at)),
    ...input.map((e) => periodOf(e.at)),
  ].sort();
  if (periods.length === 0) return [];

  const out: Pp30[] = [];
  let credit = satang(0);
  for (const period of monthsBetween(periods[0]!, periods[periods.length - 1]!)) {
    const ret = buildPp30(period, output, input, credit);
    out.push(ret);
    credit = ret.creditCarriedForward;
  }
  return out;
}

/** Inclusive month range, as `YYYY-MM` strings. */
export function monthsBetween(first: string, last: string): string[] {
  assertPeriod(first);
  assertPeriod(last);

  const index = (p: string): number => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;
  const label = (i: number): string =>
    `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

  const out: string[] = [];
  for (let i = index(first); i <= index(last); i++) out.push(label(i));
  return out;
}
