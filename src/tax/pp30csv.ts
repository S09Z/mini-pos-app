/**
 * pp30csv.ts — the PP.30 draft, as a file an accountant opens.
 *
 * Same rules as `day/csv.ts`, and it reuses that module's primitives rather
 * than restating them: plain decimals, formula-injection guarded text, and an
 * empty cell wherever the honest answer is "unknown".
 *
 * Two files, for the same reason the day export is three: the headline return
 * and the purchase detail have different schemas, and mixing them in one sheet
 * is what produces follow-up questions.
 */

import { csvDocument, csvMoney } from "../day/csv.js";
import type { InputTaxEntry, Pp30 } from "./pp30.js";
import { periodOf } from "./pp30.js";

/** The return itself: label/value pairs, in filing order. */
export function pp30Csv(ret: Pp30): string {
  const rows: string[][] = [
    ["PP.30 draft", ret.period],
    [],
    ["Sales (net of VAT)", csvMoney(ret.sales.net)],
    ["Sales entries", String(ret.sales.entries)],
    ["Output VAT", csvMoney(ret.outputVat)],
    [],
    ["Purchases (net, claimable)", csvMoney(ret.purchases.net)],
    ["Input VAT claimed", csvMoney(ret.inputVat)],
    // Reported rather than omitted: "what did we fail to claim, and why" is a
    // question worth being able to answer, and a missing line answers nothing.
    ["Input VAT disallowed", csvMoney(ret.purchases.disallowedVat)],
    ["Disallowed entries", String(ret.purchases.disallowedEntries)],
    [],
    ["Credit brought forward", csvMoney(ret.creditBroughtForward)],
    ["VAT payable", csvMoney(ret.payable)],
    ["Credit carried forward", csvMoney(ret.creditCarriedForward)],
    [],
    [
      "Note",
      // The caveat belongs in the file, not only on the screen the operator saw
      // before exporting it. The file is what gets emailed on.
      "This is a draft for review, not a filing. Claimable input tax and the treatment of zero-rated and exempt supplies follow Revenue Department practice.",
    ],
  ];

  return csvDocument(rows);
}

/** The supplier invoices behind the input-tax figure. */
export function pp30PurchasesCsv(period: string, entries: readonly InputTaxEntry[]): string {
  const header = [
    "date",
    "supplier",
    "supplier_invoice_no",
    "net",
    "vat",
    "claimable",
    "disallowed_reason",
  ];

  const rows = entries
    .filter((entry) => periodOf(entry.at) === period)
    .map((entry) => [
      entry.at.slice(0, 10),
      // Raw: csvDocument escapes and formula-guards every field itself, and
      // escaping here as well would double-quote anything containing a quote.
      entry.supplier,
      entry.invoiceNo,
      csvMoney(entry.net),
      csvMoney(entry.vat),
      entry.claimable ? "yes" : "no",
      entry.claimable ? "" : (entry.disallowedReason ?? ""),
    ]);

  return csvDocument([header, ...rows]);
}
