import { describe, expect, it } from "vitest";
import { fromBahtString, negate, satang, type Satang } from "../money.js";
import { parseStatement, type StatementRow } from "./parse.js";
import {
  matchStatement,
  normaliseOrderId,
  exceptionsExplainVariance,
  type ExpectedPayout,
} from "./match.js";

const b = (s: string): Satang => fromBahtString(s);

const expected = (
  orderId: string,
  payoutBaht: string,
  overrides: Partial<ExpectedPayout> = {},
): ExpectedPayout => ({
  saleId: `sale-${orderId}`,
  receiptNo: `A-${orderId}`,
  channelId: "GRAB",
  platformOrderId: orderId,
  netPayout: b(payoutBaht),
  gpAmount: b("38.70"),
  createdAt: "2026-08-19T05:00:00.000Z",
  ...overrides,
});

const statement = (lines: readonly string[]): readonly StatementRow[] =>
  parseStatement(["order_id,net_payout,status", ...lines].join("\n")).rows;

describe("normaliseOrderId", () => {
  it("ignores case and padding differences between exports", () => {
    expect(normaliseOrderId(" gf-001 ")).toBe("GF-001");
    expect(normaliseOrderId("GF 001")).toBe("GF001");
  });
});

describe("matchStatement — clean cycle", () => {
  it("matches every row and reports zero variance", () => {
    const result = matchStatement(
      statement(["GF-001,88.75,COMPLETED", "GF-002,79.12,COMPLETED"]),
      [expected("GF-001", "88.75"), expected("GF-002", "79.12")],
    );

    expect(result.matched).toHaveLength(2);
    expect(result.exceptions).toHaveLength(0);
    expect(result.totalVariance).toBe(satang(0));
  });

  it("matches across case and padding differences in the reference", () => {
    const result = matchStatement(statement([" gf-001 ,88.75,OK"]), [expected("GF-001", "88.75")]);
    expect(result.matched).toHaveLength(1);
  });

  it("totals both sides", () => {
    const result = matchStatement(
      statement(["GF-001,88.75,OK", "GF-002,79.12,OK"]),
      [expected("GF-001", "88.75"), expected("GF-002", "79.12")],
    );
    expect(result.statementTotal).toBe(b("167.87"));
    expect(result.expectedTotal).toBe(b("167.87"));
  });
});

describe("matchStatement — NO_SUCH_ORDER", () => {
  it("flags a statement row we never rang up", () => {
    const result = matchStatement(statement(["GF-999,50.00,CANCELLED"]), [expected("GF-001", "88.75")]);
    const found = result.exceptions.find((e) => e.kind === "NO_SUCH_ORDER");

    expect(found).toBeDefined();
    expect(found!.platformOrderId).toBe("GF-999");
    expect(found!.variance).toBe(b("50"));
  });

  it("mentions the platform's own status, which usually explains it", () => {
    const result = matchStatement(statement(["GF-999,50.00,CANCELLED"]), []);
    expect(result.exceptions[0]!.detail).toContain("CANCELLED");
  });

  it("keeps the statement row for investigation", () => {
    const result = matchStatement(statement(["GF-999,50.00,REFUND"]), []);
    expect(result.exceptions[0]!.statement).not.toBeNull();
    expect(result.exceptions[0]!.statement!.lineNumber).toBe(2);
  });
});

describe("matchStatement — MISSING_FROM_STATEMENT", () => {
  it("flags a sale the statement never mentions", () => {
    // The expensive one: nothing else in the system would ever complain.
    const result = matchStatement(statement(["GF-001,88.75,OK"]), [
      expected("GF-001", "88.75"),
      expected("GF-002", "79.12"),
    ]);
    const found = result.exceptions.find((e) => e.kind === "MISSING_FROM_STATEMENT");

    expect(found).toBeDefined();
    expect(found!.platformOrderId).toBe("GF-002");
  });

  it("records it as money not received", () => {
    const result = matchStatement([], [expected("GF-002", "79.12")]);
    expect(result.exceptions[0]!.variance).toBe(negate(b("79.12")));
  });

  it("names the receipt so it can be found in the till record", () => {
    const result = matchStatement([], [expected("GF-002", "79.12")]);
    expect(result.exceptions[0]!.detail).toContain("A-GF-002");
  });
});

describe("matchStatement — AMOUNT_MISMATCH", () => {
  it("flags a row paid at the wrong amount", () => {
    const result = matchStatement(statement(["GF-001,70.00,OK"]), [expected("GF-001", "88.75")]);
    const found = result.exceptions.find((e) => e.kind === "AMOUNT_MISMATCH");

    expect(found).toBeDefined();
    expect(found!.variance).toBe(negate(b("18.75")));
  });

  it("is not counted as a clean match", () => {
    const result = matchStatement(statement(["GF-001,70.00,OK"]), [expected("GF-001", "88.75")]);
    expect(result.matched).toHaveLength(0);
  });

  it("handles being overpaid as well as underpaid", () => {
    const result = matchStatement(statement(["GF-001,100.00,OK"]), [expected("GF-001", "88.75")]);
    expect(result.exceptions[0]!.variance).toBe(b("11.25"));
  });

  it("points at funded discounts, which is usually the cause", () => {
    const result = matchStatement(statement(["GF-001,70.00,OK"]), [expected("GF-001", "88.75")]);
    expect(result.exceptions[0]!.detail).toContain("promotion");
  });
});

describe("matchStatement — DUPLICATE_IN_STATEMENT", () => {
  it("flags the same order appearing twice", () => {
    const result = matchStatement(statement(["GF-001,88.75,OK", "GF-001,88.75,OK"]), [
      expected("GF-001", "88.75"),
    ]);
    const found = result.exceptions.find((e) => e.kind === "DUPLICATE_IN_STATEMENT");

    expect(found).toBeDefined();
    expect(found!.variance).toBe(b("88.75"));
  });

  it("matches the first occurrence and flags only the second", () => {
    const result = matchStatement(statement(["GF-001,88.75,OK", "GF-001,88.75,OK"]), [
      expected("GF-001", "88.75"),
    ]);
    expect(result.matched).toHaveLength(1);
    expect(result.exceptions).toHaveLength(1);
  });

  it("names both line numbers, since re-imported statements are the usual cause", () => {
    const result = matchStatement(statement(["GF-001,88.75,OK", "GF-001,88.75,OK"]), [
      expected("GF-001", "88.75"),
    ]);
    expect(result.exceptions[0]!.detail).toContain("lines 2 and 3");
  });
});

describe("matchStatement — the variance always adds up", () => {
  it("exceptions account for the whole gap on a mixed cycle", () => {
    const result = matchStatement(
      statement([
        "GF-001,88.75,OK", // clean
        "GF-002,70.00,OK", // underpaid by 18.75
        "GF-999,50.00,CANCELLED", // never rang
      ]),
      [
        expected("GF-001", "88.75"),
        expected("GF-002", "88.75"),
        expected("GF-003", "79.12"), // never paid
      ],
    );

    expect(exceptionsExplainVariance(result)).toBe(true);
  });

  it("holds for a clean cycle too", () => {
    const result = matchStatement(statement(["GF-001,88.75,OK"]), [expected("GF-001", "88.75")]);
    expect(exceptionsExplainVariance(result)).toBe(true);
  });

  it("holds when everything is an exception", () => {
    const result = matchStatement(statement(["GF-999,50.00,X"]), [expected("GF-001", "88.75")]);
    expect(exceptionsExplainVariance(result)).toBe(true);
  });

  it("holds with duplicates in the mix", () => {
    const result = matchStatement(
      statement(["GF-001,88.75,OK", "GF-001,88.75,OK", "GF-002,10.00,OK"]),
      [expected("GF-001", "88.75"), expected("GF-002", "10.00")],
    );
    expect(exceptionsExplainVariance(result)).toBe(true);
  });
});

describe("matchStatement — queue ordering", () => {
  it("puts the biggest money at stake first", () => {
    // A queue ordered by import order buries a ฿500 problem under ฿1 ones.
    const result = matchStatement(statement(["GF-A,1.00,X", "GF-B,500.00,X", "GF-C,20.00,X"]), []);
    expect(result.exceptions.map((e) => e.platformOrderId)).toEqual(["GF-B", "GF-C", "GF-A"]);
  });

  it("ranks by absolute value, so a large shortfall outranks a small overpayment", () => {
    const result = matchStatement(statement(["GF-A,5.00,X"]), [expected("GF-B", "300.00")]);
    expect(result.exceptions[0]!.platformOrderId).toBe("GF-B");
  });
});

describe("matchStatement — empty inputs", () => {
  it("an empty statement makes every sale an exception", () => {
    const result = matchStatement([], [expected("GF-001", "88.75")]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]!.kind).toBe("MISSING_FROM_STATEMENT");
  });

  it("no sales and no statement reconciles trivially", () => {
    const result = matchStatement([], []);
    expect(result.exceptions).toHaveLength(0);
    expect(result.totalVariance).toBe(satang(0));
  });
});
