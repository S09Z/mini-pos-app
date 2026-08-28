import { describe, expect, it } from "vitest";
import { fromBahtString, negate, satang, type Satang } from "../money.js";
import {
  splitCsv,
  normaliseHeader,
  parseAmount,
  parseStatement,
  StatementParseError,
} from "./parse.js";

const b = (s: string): Satang => fromBahtString(s);

describe("splitCsv", () => {
  it("splits a plain file", () => {
    expect(splitCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("honours quoted fields containing commas", () => {
    expect(splitCsv('a,b\n"x,y",2\n')).toEqual([
      ["a", "b"],
      ["x,y", "2"],
    ]);
  });

  it("honours doubled quotes inside a quoted field", () => {
    expect(splitCsv('a\n"say ""hi"""\n')).toEqual([["a"], ['say "hi"']]);
  });

  it("honours embedded newlines inside quotes", () => {
    expect(splitCsv('a,b\n"line1\nline2",2\n')).toEqual([
      ["a", "b"],
      ["line1\nline2", "2"],
    ]);
  });

  it("handles CRLF endings", () => {
    expect(splitCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM so it does not become part of the first header", () => {
    const rows = splitCsv("﻿order_id,net_payout\nA,1\n");
    expect(rows[0]).toEqual(["order_id", "net_payout"]);
  });

  it("handles a file with no trailing newline", () => {
    expect(splitCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("normaliseHeader", () => {
  it("collapses spelling variations to one key", () => {
    for (const variant of ["Net Payout", "net_payout", "NET  PAYOUT", "Net-Payout", "net payout (THB)"]) {
      expect(normaliseHeader(variant)).toBe("net_payout");
    }
  });

  it("drops parenthesised unit annotations", () => {
    expect(normaliseHeader("Commission (THB)")).toBe("commission");
  });
});

describe("parseAmount", () => {
  it("reads a plain decimal", () => {
    expect(parseAmount("1234.50")).toBe(b("1234.50"));
  });

  it("strips thousands separators and currency symbols", () => {
    expect(parseAmount("฿1,234.50")).toBe(b("1234.50"));
    expect(parseAmount(" THB 1,234.50 ")).toBe(b("1234.50"));
  });

  it("reads accounting parentheses as negative", () => {
    expect(parseAmount("(20.00)")).toBe(negate(b("20")));
  });

  it("reads a leading or trailing minus as negative", () => {
    expect(parseAmount("-20.00")).toBe(negate(b("20")));
    expect(parseAmount("20.00-")).toBe(negate(b("20")));
  });

  it("treats blanks and placeholders as absent, not zero", () => {
    // Zero would sum silently into a wrong reconciliation.
    for (const value of ["", "  ", "N/A", "n/a", "-", "—", "null"]) {
      expect(parseAmount(value)).toBeNull();
    }
  });

  it("refuses an ambiguous separator rather than guessing", () => {
    // "1.234.50" could be either convention; a guess here is a silent error.
    expect(parseAmount("1.234.50")).toBeNull();
  });

  it("goes through the exact string path, not the float path", () => {
    // fromBaht(1.005) would give 100; the string path correctly gives 101.
    expect(parseAmount("1.005")).toBe(satang(101));
  });

  it("returns null for text with no digits", () => {
    expect(parseAmount("pending")).toBeNull();
  });
});

const STATEMENT = [
  "order_id,order_date,gross,commission,net_payout",
  "GF-001,2026-08-19,129.00,38.70,88.75",
  "GF-002,2026-08-19,115.00,34.50,79.12",
  "",
].join("\n");

describe("parseStatement — the happy path", () => {
  it("reads every row", () => {
    const parsed = parseStatement(STATEMENT);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!.platformOrderId).toBe("GF-001");
    expect(parsed.rows[0]!.netPayout).toBe(b("88.75"));
  });

  it("reports which header each canonical column was found under", () => {
    const parsed = parseStatement(STATEMENT);
    expect(parsed.columnMap["netPayoutSatang"]).toBe("net_payout");
    expect(parsed.columnMap["platformOrderId"]).toBe("order_id");
  });

  it("keeps every original cell for investigation", () => {
    const parsed = parseStatement(STATEMENT);
    expect(parsed.rows[0]!.raw["commission"]).toBe("38.70");
    expect(parsed.rows[0]!.raw["order_date"]).toBe("2026-08-19");
  });

  it("records the source line number so the operator can be pointed at a row", () => {
    const parsed = parseStatement(STATEMENT);
    expect(parsed.rows[0]!.lineNumber).toBe(2);
    expect(parsed.rows[1]!.lineNumber).toBe(3);
  });
});

describe("parseStatement — never assume column order", () => {
  it("reads the same data with the columns shuffled", () => {
    const shuffled = [
      "net_payout,order_id,commission,gross,order_date",
      "88.75,GF-001,38.70,129.00,2026-08-19",
    ].join("\n");

    const parsed = parseStatement(shuffled);
    expect(parsed.rows[0]!.platformOrderId).toBe("GF-001");
    expect(parsed.rows[0]!.netPayout).toBe(b("88.75"));
    expect(parsed.rows[0]!.commission).toBe(b("38.70"));
  });

  it("reads a statement whose columns were renamed between exports", () => {
    const renamed = ["Order Reference,Settlement Amount", "GF-001,88.75"].join("\n");
    const parsed = parseStatement(renamed);
    expect(parsed.rows[0]!.platformOrderId).toBe("GF-001");
    expect(parsed.rows[0]!.netPayout).toBe(b("88.75"));
  });

  it("tolerates unknown extra columns", () => {
    const extra = [
      "order_id,rider_name,net_payout,some_new_field",
      "GF-001,Somchai,88.75,whatever",
    ].join("\n");
    const parsed = parseStatement(extra);
    expect(parsed.rows[0]!.netPayout).toBe(b("88.75"));
    expect(parsed.rows[0]!.raw["rider_name"]).toBe("Somchai");
  });

  it("finds the header past a preamble of merchant details and blank lines", () => {
    const withPreamble = [
      "Matcha Stall Co.,,",
      "Statement period,2026-08-01 to 2026-08-15,",
      "",
      "order_id,gross,net_payout",
      "GF-001,129.00,88.75",
    ].join("\n");

    const parsed = parseStatement(withPreamble);
    expect(parsed.headerLineNumber).toBe(4);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe("parseStatement — refuses to guess", () => {
  it("throws when the payout column is absent, naming what it looked for", () => {
    const noPayout = ["order_id,gross", "GF-001,129.00"].join("\n");
    expect(() => parseStatement(noPayout)).toThrow(StatementParseError);
    try {
      parseStatement(noPayout);
    } catch (err) {
      // A loud failure at import is recoverable; a wrong match is not.
      expect(String(err)).toContain("netPayoutSatang");
      expect(String(err)).toContain("net_payout");
    }
  });

  it("throws when the order reference column is absent", () => {
    expect(() => parseStatement(["gross,net_payout", "129.00,88.75"].join("\n"))).toThrow(
      StatementParseError,
    );
  });

  it("throws on an empty file", () => {
    expect(() => parseStatement("")).toThrow(StatementParseError);
  });
});

describe("parseStatement — warnings, never silent drops", () => {
  it("warns about a trailing total row rather than importing it as an order", () => {
    const withTotal = [
      "order_id,net_payout",
      "GF-001,88.75",
      ",167.87",
    ].join("\n");

    const parsed = parseStatement(withTotal);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]!.reason).toContain("order reference");
  });

  it("warns about an unreadable amount instead of treating it as zero", () => {
    const bad = ["order_id,net_payout", "GF-001,pending"].join("\n");
    const parsed = parseStatement(bad);

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.warnings[0]!.reason).toContain("payout amount");
    // The original row survives so the operator can look at it.
    expect(parsed.warnings[0]!.raw["net_payout"]).toBe("pending");
  });

  it("skips genuinely blank separator lines without warning", () => {
    const spaced = ["order_id,net_payout", "GF-001,88.75", "", "GF-002,79.12"].join("\n");
    const parsed = parseStatement(spaced);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.warnings).toHaveLength(0);
  });
});

describe("parseStatement — funded discounts stay separate", () => {
  it("reads platform-funded and merchant-funded promotions into different fields", () => {
    // PLAN.md: merchantFundedDiscount captured separately from platform promos.
    // Conflating them makes revenue impossible to reconcile to the payout.
    const promos = [
      "order_id,net_payout,platform_funded_discount,merchant_funded_discount",
      "GF-001,88.75,20.00,15.00",
    ].join("\n");

    const parsed = parseStatement(promos);
    expect(parsed.rows[0]!.platformFundedDiscount).toBe(b("20"));
    expect(parsed.rows[0]!.merchantFundedDiscount).toBe(b("15"));
  });

  it("leaves an absent promo column null rather than zero", () => {
    const parsed = parseStatement(STATEMENT);
    expect(parsed.rows[0]!.platformFundedDiscount).toBeNull();
    expect(parsed.rows[0]!.merchantFundedDiscount).toBeNull();
  });
});
