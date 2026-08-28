/**
 * parse.ts — reading a platform statement without trusting it.
 *
 * PLAN.md's instruction for this phase is unusually specific: "parse
 * defensively, never assume column order, formats change without notice."
 * That is not defensive programming as a style preference. Delivery platforms
 * change their export format without telling anyone, and a parser that assumed
 * column 3 was the payout will, one Tuesday, silently reconcile a month of
 * orders against the commission column instead.
 *
 * So this module:
 *
 *  - finds the header row rather than assuming it is first (statements often
 *    carry a preamble of merchant name, period, and blank lines);
 *  - maps columns by *alias*, normalised for case, spacing and punctuation, so
 *    "Net Payout", "net_payout" and "NET PAYOUT (THB)" are one column;
 *  - refuses to guess when a required column is absent, naming what it looked
 *    for — a loud failure at import is recoverable, a wrong match is not;
 *  - parses amounts through `fromBahtString` after stripping the decorations
 *    real exports carry, and keeps every original cell.
 *
 * Nothing here throws away the raw row. An unmatched row is the finding, and
 * you cannot investigate a finding you have discarded.
 */

import { fromBahtString, satang, type Satang } from "../money.js";

export class StatementParseError extends Error {
  override readonly name = "StatementParseError";
}

/** Split RFC 4180 CSV text into rows, honouring quotes and embedded newlines. */
export function splitCsv(text: string): string[][] {
  // A UTF-8 BOM survives round-tripping through most tools and would otherwise
  // become part of the first header name.
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // Swallow; the \n that follows ends the row. A lone \r ends it too.
      if (input[i + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Normalise a header cell so spelling variations collapse to one key. */
export function normaliseHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // drop unit annotations like "(THB)"
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

/**
 * Column aliases, widest first.
 *
 * These are the names real exports use for the same thing. Add to this list
 * when a platform renames a column; do not rename the canonical key, or every
 * previously imported batch stops lining up with the new ones.
 */
export const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  platformOrderId: [
    "order_id",
    "order_no",
    "order_number",
    "order_reference",
    "reference",
    "reference_no",
    "transaction_id",
    "merchant_order_id",
    "short_order_id",
  ],
  grossSatang: ["gross", "gross_amount", "order_total", "subtotal", "food_value", "total", "order_amount"],
  commissionSatang: ["commission", "commission_amount", "gp", "gp_amount", "service_fee", "platform_fee", "merchant_commission"],
  netPayoutSatang: [
    "net_payout",
    "payout",
    "payout_amount",
    "net_amount",
    "net_transfer",
    "amount_payable",
    "settlement_amount",
    "net",
  ],
  platformFundedDiscountSatang: [
    "platform_funded_discount",
    "platform_promotion",
    "platform_discount",
    "promo_funded_by_platform",
    "campaign_subsidy",
  ],
  merchantFundedDiscountSatang: [
    "merchant_funded_discount",
    "merchant_promotion",
    "merchant_discount",
    "promo_funded_by_merchant",
  ],
  orderDate: ["order_date", "date", "transaction_date", "created_at", "order_time", "datetime"],
  status: ["status", "order_status", "state", "type", "transaction_type"],
};

/** Canonical column keys that must be present for a statement to be usable. */
const REQUIRED: readonly string[] = ["platformOrderId", "netPayoutSatang"];

export interface StatementRow {
  readonly platformOrderId: string;
  /** What the platform says it is paying. The figure the whole phase turns on. */
  readonly netPayout: Satang;
  readonly gross: Satang | null;
  readonly commission: Satang | null;
  readonly platformFundedDiscount: Satang | null;
  readonly merchantFundedDiscount: Satang | null;
  readonly orderDate: string | null;
  readonly status: string | null;
  /** 1-based line in the source file, for pointing the operator at a row. */
  readonly lineNumber: number;
  /** Every original cell, kept verbatim — an exception has to be investigable. */
  readonly raw: Readonly<Record<string, string>>;
}

export interface ParseWarning {
  readonly lineNumber: number;
  readonly reason: string;
  readonly raw: Readonly<Record<string, string>>;
}

export interface ParsedStatement {
  readonly rows: readonly StatementRow[];
  /** Rows that could not be read. Surfaced, never dropped silently. */
  readonly warnings: readonly ParseWarning[];
  /** Canonical key -> the header text it was found under, for the import summary. */
  readonly columnMap: Readonly<Record<string, string>>;
  readonly headerLineNumber: number;
}

/**
 * Parse an amount the way exports actually write them.
 *
 * Handles currency symbols, thousands separators, whitespace, a trailing
 * minus, and accounting parentheses for negatives. Everything is funnelled
 * through `fromBahtString` so the float path is never touched — a statement is
 * exactly the boundary CLAUDE.md says to use it at.
 */
export function parseAmount(input: string): Satang | null {
  const trimmed = input.trim();
  if (trimmed === "" || /^(n\/?a|-|—|null)$/i.test(trimmed)) return null;

  const negative = /^\(.*\)$/.test(trimmed) || /-\s*$/.test(trimmed) || /^-/.test(trimmed);
  const digits = trimmed.replace(/[()]/g, "").replace(/[^0-9.]/g, "");
  if (digits === "" || !/\d/.test(digits)) return null;
  // More than one dot means the separators were ambiguous; refuse rather than guess.
  if ((digits.match(/\./g) ?? []).length > 1) return null;

  const magnitude = fromBahtString(digits);
  return negative ? satang(-magnitude) : magnitude;
}

/** Find the row that looks like a header, and map its columns to canonical keys. */
function locateHeader(rows: readonly string[][]): {
  index: number;
  columnMap: Record<string, number>;
  headerNames: Record<string, string>;
} {
  const aliasToKey = new Map<string, string>();
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) aliasToKey.set(alias, key);
  }

  let best: { index: number; columnMap: Record<string, number>; headerNames: Record<string, string> } | null =
    null;

  // Scan a bounded preamble rather than only the first row: statements
  // routinely lead with a merchant name, a period, and a blank line or two.
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const row = rows[i]!;
    const columnMap: Record<string, number> = {};
    const headerNames: Record<string, string> = {};

    row.forEach((cell, column) => {
      const key = aliasToKey.get(normaliseHeader(cell));
      // First occurrence wins, so a trailing duplicate cannot shadow the real one.
      if (key !== undefined && columnMap[key] === undefined) {
        columnMap[key] = column;
        headerNames[key] = cell.trim();
      }
    });

    const found = Object.keys(columnMap).length;
    if (found > (best === null ? 0 : Object.keys(best.columnMap).length)) {
      best = { index: i, columnMap, headerNames };
    }
    // A row carrying every required column is good enough; stop looking.
    if (REQUIRED.every((key) => columnMap[key] !== undefined)) break;
  }

  if (best === null) throw new StatementParseError("No header row found in the first 30 lines");

  const missing = REQUIRED.filter((key) => best!.columnMap[key] === undefined);
  if (missing.length > 0) {
    const looked = missing.map((key) => `${key} (any of: ${COLUMN_ALIASES[key]!.join(", ")})`);
    throw new StatementParseError(
      `Statement is missing required column(s). Looked for ${looked.join("; ")}. ` +
        `Found: ${Object.keys(best.columnMap).join(", ") || "nothing recognisable"}.`,
    );
  }
  return best;
}

export function parseStatement(text: string): ParsedStatement {
  const rows = splitCsv(text);
  if (rows.length === 0) throw new StatementParseError("Statement file is empty");

  const { index, columnMap, headerNames } = locateHeader(rows);
  const headerRow = rows[index]!;

  const parsed: StatementRow[] = [];
  const warnings: ParseWarning[] = [];

  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNumber = i + 1;

    // Keep every cell under its original header, so an exception can be read
    // against the file the platform actually sent.
    const raw: Record<string, string> = {};
    headerRow.forEach((name, column) => {
      raw[name.trim() === "" ? `column_${column + 1}` : name.trim()] = row[column] ?? "";
    });

    if (row.every((cell) => cell.trim() === "")) continue; // blank separator line

    const cell = (key: string): string => {
      const column = columnMap[key];
      return column === undefined ? "" : (row[column] ?? "");
    };

    const platformOrderId = cell("platformOrderId").trim();
    const netPayout = parseAmount(cell("netPayoutSatang"));

    if (platformOrderId === "") {
      // Trailing "Total" rows look like this. Worth reporting rather than
      // dropping — a real order with a blank reference is a genuine problem.
      warnings.push({ lineNumber, reason: "No order reference on this row", raw });
      continue;
    }
    if (netPayout === null) {
      warnings.push({
        lineNumber,
        reason: `Could not read a payout amount from "${cell("netPayoutSatang")}"`,
        raw,
      });
      continue;
    }

    const dateText = cell("orderDate").trim();
    const statusText = cell("status").trim();

    parsed.push({
      platformOrderId,
      netPayout,
      gross: parseAmount(cell("grossSatang")),
      commission: parseAmount(cell("commissionSatang")),
      platformFundedDiscount: parseAmount(cell("platformFundedDiscountSatang")),
      merchantFundedDiscount: parseAmount(cell("merchantFundedDiscountSatang")),
      orderDate: dateText === "" ? null : dateText,
      status: statusText === "" ? null : statusText,
      lineNumber,
      raw,
    });
  }

  return { rows: parsed, warnings, columnMap: headerNames, headerLineNumber: index + 1 };
}
