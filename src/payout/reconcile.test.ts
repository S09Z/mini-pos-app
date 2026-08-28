import { describe, expect, it } from "vitest";
import { formatTHB, fromBahtString, negate, satang, type Satang } from "../money.js";
import { parseStatement } from "./parse.js";
import { matchStatement, type ExpectedPayout, type MatchResult } from "./match.js";
import {
  reconcileBatch,
  describeReconciliation,
  reasonsFor,
  type ResolvedException,
} from "./reconcile.js";

const b = (s: string): Satang => fromBahtString(s);

const expected = (orderId: string, payoutBaht: string): ExpectedPayout => ({
  saleId: `sale-${orderId}`,
  receiptNo: `A-${orderId}`,
  channelId: "GRAB",
  platformOrderId: orderId,
  netPayout: b(payoutBaht),
  gpAmount: b("38.70"),
  createdAt: "2026-08-19T05:00:00.000Z",
});

const match = (lines: readonly string[], sales: readonly ExpectedPayout[]): MatchResult =>
  matchStatement(parseStatement(["order_id,net_payout,status", ...lines].join("\n")).rows, sales);

const resolve = (orderId: string, reason: string): ResolvedException => ({
  platformOrderId: orderId,
  kind: "NO_SUCH_ORDER",
  variance: satang(0),
  reason,
  note: "",
});

describe("reconcileBatch — a clean cycle", () => {
  const clean = match(["GF-001,88.75,OK"], [expected("GF-001", "88.75")]);

  it("reconciles when the deposit matches and nothing is outstanding", () => {
    const result = reconcileBatch(clean, [], b("88.75"));
    expect(result.reconciled).toBe(true);
    expect(result.unexplainedVariance).toBe(satang(0));
  });

  it("is NOT reconciled until the deposit is entered, however tidy the queue", () => {
    // A cycle nobody checked against the bank has not been reconciled.
    const result = reconcileBatch(clean, [], null);
    expect(result.reconciled).toBe(false);
    expect(result.openExceptions).toBe(0);
  });

  it("says what is still needed", () => {
    const result = reconcileBatch(clean, [], null);
    expect(describeReconciliation(result, formatTHB)).toContain("deposit");
  });
});

describe("reconcileBatch — explained vs unexplained", () => {
  const cycle = match(
    ["GF-001,88.75,OK", "GF-999,50.00,CANCELLED"],
    [expected("GF-001", "88.75")],
  );

  it("counts an unworked exception as unexplained", () => {
    const result = reconcileBatch(cycle, [], b("138.75"));
    expect(result.openExceptions).toBe(1);
    expect(result.unexplainedVariance).toBe(b("50"));
    expect(result.reconciled).toBe(false);
  });

  it("moves it to explained once a reason is attached", () => {
    const result = reconcileBatch(cycle, [resolve("GF-999", "CANCELLED")], b("138.75"));
    expect(result.resolvedExceptions).toBe(1);
    expect(result.openExceptions).toBe(0);
    expect(result.explainedVariance).toBe(b("50"));
    expect(result.unexplainedVariance).toBe(satang(0));
    expect(result.reconciled).toBe(true);
  });

  it("does not move the figures when an exception is explained", () => {
    // Resolving attaches a reason; it never edits the variance.
    const open = reconcileBatch(cycle, [], b("138.75"));
    const closed = reconcileBatch(cycle, [resolve("GF-999", "CANCELLED")], b("138.75"));

    expect(closed.statementTotal).toBe(open.statementTotal);
    expect(closed.expectedFromSales).toBe(open.expectedFromSales);
    expect(closed.statementVariance).toBe(open.statementVariance);
  });

  it("ignores a resolution with no reason on it", () => {
    const unresolved: ResolvedException = { ...resolve("GF-999", "X"), reason: null };
    const result = reconcileBatch(cycle, [unresolved], b("138.75"));
    expect(result.openExceptions).toBe(1);
  });
});

describe("reconcileBatch — the two gaps are kept apart", () => {
  const cycle = match(["GF-001,88.75,OK"], [expected("GF-001", "88.75")]);

  it("separates the statement gap from the bank gap", () => {
    // The statement is perfect but the bank paid ฿10 less. A specific, real
    // failure that folding the two totals together would hide entirely.
    const result = reconcileBatch(cycle, [], b("78.75"));

    expect(result.statementVariance).toBe(satang(0));
    expect(result.depositVariance).toBe(negate(b("10")));
    expect(result.unexplainedVariance).toBe(negate(b("10")));
    expect(result.reconciled).toBe(false);
  });

  it("leaves the bank gap null until a deposit is entered", () => {
    expect(reconcileBatch(cycle, [], null).depositVariance).toBeNull();
  });

  it("catches a short deposit even when every exception is explained", () => {
    const withException = match(["GF-001,88.75,OK", "GF-999,50.00,X"], [expected("GF-001", "88.75")]);
    const result = reconcileBatch(withException, [resolve("GF-999", "CANCELLED")], b("100.00"));

    expect(result.openExceptions).toBe(0);
    expect(result.unexplainedVariance).not.toBe(satang(0));
    expect(result.reconciled).toBe(false);
  });
});

describe("reconcileBatch — a realistic messy cycle driven to zero", () => {
  const messy = match(
    [
      "GF-001,88.75,OK", // clean
      "GF-002,70.00,OK", // underpaid 18.75, promo funded differently
      "GF-999,50.00,CANCELLED", // never rang up
    ],
    [
      expected("GF-001", "88.75"),
      expected("GF-002", "88.75"),
      expected("GF-003", "79.12"), // sold, never paid
    ],
  );
  const deposit = b("208.75"); // 88.75 + 70.00 + 50.00

  it("starts with three open exceptions", () => {
    const result = reconcileBatch(messy, [], deposit);
    expect(result.openExceptions).toBe(3);
    expect(result.reconciled).toBe(false);
  });

  it("reaches zero unexplained variance once every exception is worked", () => {
    const result = reconcileBatch(
      messy,
      [
        { ...resolve("GF-002", "PROMO_FUNDING"), kind: "AMOUNT_MISMATCH" },
        { ...resolve("GF-999", "CANCELLED"), kind: "NO_SUCH_ORDER" },
        { ...resolve("GF-003", "NEXT_CYCLE"), kind: "MISSING_FROM_STATEMENT" },
      ],
      deposit,
    );

    expect(result.openExceptions).toBe(0);
    expect(result.unexplainedVariance).toBe(satang(0));
    expect(result.reconciled).toBe(true);
    expect(describeReconciliation(result, formatTHB)).toBe("Reconciled — no unexplained variance");
  });

  it("is still not reconciled if only some are worked", () => {
    const result = reconcileBatch(messy, [resolve("GF-999", "CANCELLED")], deposit);
    expect(result.openExceptions).toBe(2);
    expect(result.reconciled).toBe(false);
  });
});

describe("describeReconciliation", () => {
  const cycle = match(["GF-001,88.75,OK"], [expected("GF-001", "88.75")]);

  it("names the direction of an unexplained gap", () => {
    expect(describeReconciliation(reconcileBatch(cycle, [], b("78.75")), formatTHB)).toContain(
      "less than expected",
    );
    expect(describeReconciliation(reconcileBatch(cycle, [], b("98.75")), formatTHB)).toContain(
      "more than expected",
    );
  });

  it("counts the outstanding exceptions when there are some", () => {
    const withException = match(["GF-999,50.00,X"], []);
    expect(describeReconciliation(reconcileBatch(withException, [], b("50")), formatTHB)).toContain(
      "1 exception",
    );
  });

  it("renders magnitudes unsigned, since the words carry the direction", () => {
    const text = describeReconciliation(reconcileBatch(cycle, [], b("78.75")), formatTHB);
    expect(text).not.toContain("-฿");
  });
});

describe("reasonsFor", () => {
  it("offers cancellation for an order we never rang", () => {
    expect(reasonsFor("NO_SUCH_ORDER").map((r) => r.key)).toContain("CANCELLED");
  });

  it("offers next-cycle for a sale missing from the statement", () => {
    expect(reasonsFor("MISSING_FROM_STATEMENT").map((r) => r.key)).toContain("NEXT_CYCLE");
  });

  it("offers promo funding for an amount mismatch", () => {
    expect(reasonsFor("AMOUNT_MISMATCH").map((r) => r.key)).toContain("PROMO_FUNDING");
  });

  it("offers re-statement for a duplicate", () => {
    expect(reasonsFor("DUPLICATE_IN_STATEMENT").map((r) => r.key)).toContain("RESTATEMENT");
  });

  it("always offers 'disputed', because not every gap resolves the same day", () => {
    for (const kind of [
      "NO_SUCH_ORDER",
      "MISSING_FROM_STATEMENT",
      "AMOUNT_MISMATCH",
      "DUPLICATE_IN_STATEMENT",
    ] as const) {
      expect(reasonsFor(kind).map((r) => r.key)).toContain("DISPUTED");
    }
  });

  it("gives every kind at least one reason to pick", () => {
    for (const kind of [
      "NO_SUCH_ORDER",
      "MISSING_FROM_STATEMENT",
      "AMOUNT_MISMATCH",
      "DUPLICATE_IN_STATEMENT",
    ] as const) {
      expect(reasonsFor(kind).length).toBeGreaterThan(0);
    }
  });
});
