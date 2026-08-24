import { describe, expect, it } from "vitest";
import {
  satang,
  fromBaht,
  fromBahtString,
  toBaht,
  formatTHB,
  add,
  sub,
  sum,
  negate,
  scale,
  applyRate,
  allocate,
  MoneyError,
  ZERO,
  type Satang,
} from "./money.js";

describe("satang", () => {
  it("accepts integers", () => {
    expect(satang(0)).toBe(0);
    expect(satang(-500)).toBe(-500);
  });

  it("rejects non-integers, NaN, and Infinity", () => {
    expect(() => satang(1.5)).toThrow(MoneyError);
    expect(() => satang(NaN)).toThrow(MoneyError);
    expect(() => satang(Infinity)).toThrow(MoneyError);
  });

  it("rejects unsafe integers", () => {
    expect(() => satang(Number.MAX_SAFE_INTEGER + 10)).toThrow(MoneyError);
  });
});

describe("fromBaht / fromBahtString", () => {
  it("agree for exact amounts", () => {
    for (const baht of [0, 1, 80, 75.5, 220.25, 9999.99]) {
      expect(fromBaht(baht)).toBe(fromBahtString(baht.toFixed(2)));
    }
  });

  it("fromBaht(1.005) rounds down to 100 satang — pinned IEEE754 gotcha", () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE754, so Math.round gives 100.
    expect(fromBaht(1.005)).toBe(100);
  });

  it("fromBahtString('1.005') correctly yields 101 — this is why it's the input-boundary function", () => {
    expect(fromBahtString("1.005")).toBe(101);
  });

  it("fromBahtString rounds half away from zero beyond satang precision", () => {
    expect(fromBahtString("1.004")).toBe(100);
    expect(fromBahtString("1.006")).toBe(101);
    expect(fromBahtString("-1.005")).toBe(-101);
  });

  it("fromBahtString parses whole numbers and negative amounts", () => {
    expect(fromBahtString("5")).toBe(500);
    expect(fromBahtString("-5")).toBe(-500);
    expect(fromBahtString("0.01")).toBe(1);
  });

  it("fromBahtString rejects garbage input", () => {
    expect(() => fromBahtString("abc")).toThrow(MoneyError);
    expect(() => fromBahtString("1.2.3")).toThrow(MoneyError);
    expect(() => fromBahtString("")).toThrow(MoneyError);
  });

  it("fromBaht rejects non-finite input", () => {
    expect(() => fromBaht(NaN)).toThrow(MoneyError);
    expect(() => fromBaht(Infinity)).toThrow(MoneyError);
  });
});

describe("toBaht / formatTHB", () => {
  it("round-trips through baht", () => {
    expect(toBaht(fromBahtString("155.00"))).toBe(155);
  });

  it("formats with the symbol and two decimals", () => {
    expect(formatTHB(fromBahtString("155"))).toBe("฿155.00");
    expect(formatTHB(fromBahtString("0.05"))).toBe("฿0.05");
  });

  it("formats negative amounts with a leading minus before the symbol", () => {
    expect(formatTHB(negate(fromBahtString("155")))).toBe("-฿155.00");
  });

  it("can omit the symbol", () => {
    expect(formatTHB(fromBahtString("155"), { symbol: false })).toBe("155.00");
  });

  it("thousands are grouped", () => {
    expect(formatTHB(fromBahtString("12345.67"))).toBe("฿12,345.67");
  });
});

describe("add / sub / sum / negate / scale", () => {
  it("add and sub are inverses", () => {
    const a = fromBahtString("80");
    const b = fromBahtString("75");
    expect(sub(add(a, b), b)).toBe(a);
  });

  it("sum matches manual reduction", () => {
    const xs: Satang[] = [fromBahtString("80"), fromBahtString("75"), fromBahtString("90")];
    expect(sum(xs)).toBe(add(add(xs[0]!, xs[1]!), xs[2]!));
  });

  it("sum of empty array is zero", () => {
    expect(sum([])).toBe(ZERO);
  });

  it("negate is its own inverse", () => {
    const a = fromBahtString("155");
    expect(negate(negate(a))).toBe(a);
  });

  it("a refund is the exact negation of its sale", () => {
    const sale = fromBahtString("155.37");
    const refund = negate(sale);
    expect(add(sale, refund)).toBe(ZERO);
  });

  it("scale multiplies by an integer quantity", () => {
    expect(scale(fromBahtString("80"), 3)).toBe(fromBahtString("240"));
  });

  it("scale rejects a non-integer quantity", () => {
    expect(() => scale(fromBahtString("80"), 1.5)).toThrow(MoneyError);
  });
});

describe("applyRate", () => {
  it("rounds half away from zero, symmetrically for positive and negative amounts", () => {
    for (let baht = -500; baht <= 500; baht++) {
      if (baht === 0) continue; // ±0 carries no meaningful sign here
      const a = fromBaht(baht);
      const bp = 700;
      expect(applyRate(negate(a), bp)).toBe(negate(applyRate(a, bp)));
    }
  });

  it("rejects a non-integer basis-point rate", () => {
    expect(() => applyRate(fromBahtString("100"), 7.5)).toThrow(MoneyError);
  });
});

describe("allocate", () => {
  it("always sums back to the total, across a range of totals and weight sets", () => {
    const weightSets = [[1, 1, 1], [1, 2, 3], [5], [0, 0, 1], [1, 1, 1, 1, 1, 1, 1]];
    for (const weights of weightSets) {
      for (let totalBaht = -10; totalBaht <= 10; totalBaht++) {
        const total = fromBaht(totalBaht);
        const parts = allocate(total, weights);
        expect(sum(parts)).toBe(total);
      }
    }
  });

  it("allocates a single leftover satang to exactly one of three equal-weight lines", () => {
    // This is the building block behind the three ฿0.05-line VAT example in
    // tax/vat.test.ts: a document-level total of 1 satang, spread across three
    // equal-weight lines, must land on exactly one line rather than vanishing.
    const lineGross = fromBahtString("0.05"); // 5 satang
    const parts = allocate(satang(1), [lineGross, lineGross, lineGross]);
    expect(sum(parts)).toBe(satang(1));
    expect(parts.filter((p) => p === 1)).toHaveLength(1);
  });

  it("ties break toward the earlier index, so allocation is deterministic", () => {
    const first = allocate(satang(1), [1, 1]);
    const second = allocate(satang(1), [1, 1]);
    expect(first).toEqual(second);
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(0);
  });

  it("spreads evenly when all weights are zero", () => {
    const parts = allocate(satang(10), [0, 0, 0]);
    expect(sum(parts)).toBe(satang(10));
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });

  it("throws on zero weights, negative weights, or a negative-total mismatch with weight signs", () => {
    expect(() => allocate(satang(10), [])).toThrow(MoneyError);
    expect(() => allocate(satang(10), [-1, 2])).toThrow(MoneyError);
  });

  it("handles a negative total by allocating negative parts", () => {
    const parts = allocate(satang(-10), [1, 1]);
    expect(sum(parts)).toBe(satang(-10));
    expect(parts.every((p) => p <= 0)).toBe(true);
  });
});
