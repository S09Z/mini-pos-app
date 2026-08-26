/**
 * csv.ts — the file the accountant actually opens.
 *
 * Phase 3's "done when" is an accountant asking no follow-up questions, so
 * this module optimises for being unambiguous rather than compact.
 *
 * Four decisions worth stating:
 *
 * 1. **Money is a decimal string, not a float.** `฿1,234.50` becomes
 *    `1234.50` — no symbol, no thousands separator, always two places. A
 *    spreadsheet parses that identically everywhere; `฿1,234.5` does not.
 *
 * 2. **Text fields are guarded against formula injection.** A menu item named
 *    `=cmd()` is a live formula when the file is opened in Excel. Leading
 *    `= + - @`, tab, and carriage return get a `'` prefix. This is a real
 *    attack on anyone you send a CSV to, and the operator types the menu.
 *
 * 3. **The VAT rate and its authority ride along on every sale row.** The
 *    frozen values, not today's — an accountant reconciling a PP.30 needs to
 *    see which decree applied to each sale.
 *
 * 4. **Unknown cost exports as empty, never as 0.** An empty cell is a
 *    question; a zero is a wrong answer that sums silently.
 */

import { formatTHB, type Satang } from "../money.js";
import { bangkokDayOf, bangkokHourOf } from "./period.js";

/** Money for a spreadsheet: plain decimal, two places, no symbol or grouping. */
export function csvMoney(value: Satang): string {
  return formatTHB(value, { symbol: false }).replace(/,/g, "");
}

/** Basis points as a percentage string, e.g. 700 -> "7.00". */
export function csvPercent(bp: number): string {
  return (bp / 100).toFixed(2);
}

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
/** A plain decimal number, optionally negative. Nothing here can be a formula. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Escape one field, RFC 4180 style, with a formula-injection guard.
 *
 * The guard prefixes a single quote so the spreadsheet treats the value as
 * text, and runs on every field rather than only operator-entered ones — the
 * set of "safe" fields only ever shrinks.
 *
 * **Negative numbers are exempt, and that exemption is load-bearing.** `-` is
 * a formula trigger, so a naive guard turns a `-20.00` cash variance into the
 * text `'-20.00`, and the accountant's variance column silently stops summing.
 * A well-formed decimal cannot be a formula, so it passes through untouched
 * while `-1+2` — which is not a well-formed decimal — is still guarded.
 */
export function csvField(value: string): string {
  const guarded = FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/** CRLF line endings, as RFC 4180 specifies and Excel on Windows expects. */
export function csvDocument(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

export interface ExportableSale {
  readonly id: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly grossSatang: number;
  readonly netSatang: number;
  readonly vatSatang: number;
  readonly rateBp: number;
  readonly authority: string;
  readonly provisional: boolean;
  readonly vatRegistered: boolean;
  readonly tenderedSatang: number;
  readonly changeSatang: number;
}

export interface ExportableLine {
  readonly saleId: string;
  readonly menuItemId: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPriceSatang: number;
  readonly grossSatang: number;
  readonly netSatang: number;
  readonly vatSatang: number;
  /** Optional and nullable for rows predating costing — see ReportableSaleLine. */
  readonly cogsSatang?: number | null;
}

const SALES_HEADER = [
  "receipt_no",
  "sale_id",
  "trading_day_ict",
  "timestamp_utc",
  "hour_ict",
  "status",
  "gross_thb",
  "net_thb",
  "vat_thb",
  "vat_rate_percent",
  "vat_authority",
  "vat_rate_provisional",
  "vat_registered",
  "tendered_thb",
  "change_thb",
] as const;

/**
 * One row per sale.
 *
 * Voided sales are exported with `status=VOIDED` rather than omitted. An
 * export that silently drops them cannot be reconciled against the receipt
 * numbers, which are sequential and would appear to have gaps.
 */
export function salesCsv(
  sales: readonly ExportableSale[],
  voidedSaleIds: ReadonlySet<string>,
): string {
  const rows: string[][] = [[...SALES_HEADER]];

  for (const sale of sales) {
    rows.push([
      sale.receiptNo,
      sale.id,
      bangkokDayOf(sale.createdAt),
      sale.createdAt,
      String(bangkokHourOf(sale.createdAt)),
      voidedSaleIds.has(sale.id) ? "VOIDED" : "SOLD",
      csvMoney(sale.grossSatang as Satang),
      csvMoney(sale.netSatang as Satang),
      csvMoney(sale.vatSatang as Satang),
      csvPercent(sale.rateBp),
      sale.authority,
      sale.provisional ? "yes" : "no",
      sale.vatRegistered ? "yes" : "no",
      csvMoney(sale.tenderedSatang as Satang),
      csvMoney(sale.changeSatang as Satang),
    ]);
  }
  return csvDocument(rows);
}

const LINES_HEADER = [
  "receipt_no",
  "sale_id",
  "trading_day_ict",
  "status",
  "menu_item_id",
  "item_name",
  "qty",
  "unit_price_thb",
  "gross_thb",
  "net_thb",
  "vat_thb",
  "cogs_thb",
  "contribution_thb",
] as const;

/** One row per sale line, with COGS and contribution where cost is known. */
export function saleLinesCsv(
  sales: readonly ExportableSale[],
  lines: readonly ExportableLine[],
  voidedSaleIds: ReadonlySet<string>,
): string {
  const saleById = new Map(sales.map((s) => [s.id, s]));
  const rows: string[][] = [[...LINES_HEADER]];

  for (const line of lines) {
    const sale = saleById.get(line.saleId);
    if (!sale) continue;

    // Empty, not zero: an unknown cost must not sum to a wrong contribution.
    // `== null` catches both the explicit null and the absent legacy field.
    const cost = line.cogsSatang == null ? null : line.cogsSatang;
    const cogs = cost === null ? "" : csvMoney(cost as Satang);
    const contribution = cost === null ? "" : csvMoney((line.netSatang - cost) as Satang);

    rows.push([
      sale.receiptNo,
      sale.id,
      bangkokDayOf(sale.createdAt),
      voidedSaleIds.has(sale.id) ? "VOIDED" : "SOLD",
      line.menuItemId,
      line.name,
      String(line.qty),
      csvMoney(line.unitPriceSatang as Satang),
      csvMoney(line.grossSatang as Satang),
      csvMoney(line.netSatang as Satang),
      csvMoney(line.vatSatang as Satang),
      cogs,
      contribution,
    ]);
  }
  return csvDocument(rows);
}

export interface DaySummaryInput {
  readonly day: string;
  readonly gross: Satang;
  readonly net: Satang;
  readonly vat: Satang;
  readonly costOfGoods: Satang;
  readonly contribution: Satang;
  readonly contributionMarginBp: number | null;
  readonly costComplete: boolean;
  readonly uncostedLines: number;
  readonly saleCount: number;
  readonly itemCount: number;
  readonly voidCount: number;
  readonly voidedValue: Satang;
  readonly expectedCash: Satang;
  readonly declaredCash: Satang | null;
  readonly cashVariance: Satang | null;
}

/**
 * A tall key/value summary rather than a wide single row.
 *
 * It reads correctly in a spreadsheet without horizontal scrolling, and adding
 * a measure later appends a row instead of shifting every column — which
 * matters when an accountant has built anything on top of the previous shape.
 */
export function daySummaryCsv(input: DaySummaryInput): string {
  const rows: string[][] = [["measure", "value", "note"]];
  const add = (measure: string, value: string, note = ""): void => {
    rows.push([measure, value, note]);
  };

  add("trading_day_ict", input.day, "Bangkok local day, 00:00-24:00 +07:00");
  add("sales_count", String(input.saleCount));
  add("items_sold", String(input.itemCount));

  // Contribution first: PLAN.md's stated risk for this phase is reporting
  // revenue instead of contribution, and an export is read top-down too.
  add(
    "contribution_thb",
    csvMoney(input.contribution),
    input.costComplete ? "net revenue less cost of goods" : "UNDERSTATED - some lines have no cost",
  );
  add(
    "contribution_margin_percent",
    input.contributionMarginBp === null ? "" : csvPercent(input.contributionMarginBp),
    input.contributionMarginBp === null ? "withheld - cost of goods incomplete" : "of net revenue",
  );
  add(
    "cost_of_goods_thb",
    csvMoney(input.costOfGoods),
    input.costComplete ? "" : `${input.uncostedLines} line(s) had no recorded cost`,
  );

  add("net_revenue_thb", csvMoney(input.net), "excludes VAT");
  add("vat_thb", csvMoney(input.vat));
  add("gross_takings_thb", csvMoney(input.gross), "VAT inclusive");

  add("voids_count", String(input.voidCount));
  add("voided_value_thb", csvMoney(input.voidedValue), "excluded from takings above");

  add("expected_cash_thb", csvMoney(input.expectedCash));
  add("declared_cash_thb", input.declaredCash === null ? "" : csvMoney(input.declaredCash),
    input.declaredCash === null ? "drawer not counted" : "physical count");
  add("cash_variance_thb", input.cashVariance === null ? "" : csvMoney(input.cashVariance),
    "declared less expected; negative is short");

  return csvDocument(rows);
}
