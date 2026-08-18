import { describe, expect, it } from "vitest";
import {
  quantity,
  fromUnitString,
  toUnits,
  formatQty,
  addQty,
  subQty,
  sumQty,
  negateQty,
  scaleQty,
  howManyFit,
  QuantityError,
  ZERO_QTY,
  MILLI,
  type Quantity,
} from "./units.js";

describe("quantity", () => {
  it("accepts integers", () => {
    expect(quantity(0)).toBe(0);
    expect(quantity(-4000)).toBe(-4000);
  });

  it("rejects non-integers, NaN, and Infinity", () => {
    expect(() => quantity(1.5)).toThrow(QuantityError);
    expect(() => quantity(NaN)).toThrow(QuantityError);
    expect(() => quantity(Infinity)).toThrow(QuantityError);
  });

  it("rejects unsafe integers", () => {
    expect(() => quantity(Number.MAX_SAFE_INTEGER + 10)).toThrow(QuantityError);
  });
});

describe("fromUnitString", () => {
  it("parses whole and fractional amounts", () => {
    expect(fromUnitString("4")).toBe(4000);
    expect(fromUnitString("200")).toBe(200_000);
    expect(fromUnitString("0.5")).toBe(500);
    expect(fromUnitString("4.25")).toBe(4250);
  });

  it("rounds half away from zero below milli-unit precision, symmetrically", () => {
    expect(fromUnitString("1.0004")).toBe(1000);
    expect(fromUnitString("1.0005")).toBe(1001);
    expect(fromUnitString("-1.0005")).toBe(-1001);
  });

  it("rejects garbage input", () => {
    expect(() => fromUnitString("abc")).toThrow(QuantityError);
    expect(() => fromUnitString("1.2.3")).toThrow(QuantityError);
    expect(() => fromUnitString("")).toThrow(QuantityError);
    expect(() => fromUnitString("4g")).toThrow(QuantityError);
  });

  it("round-trips through toUnits for exact values", () => {
    for (const s of ["0", "1", "4", "4.5", "200", "1000.125"]) {
      expect(toUnits(fromUnitString(s))).toBe(Number(s));
    }
  });
});

describe("formatQty", () => {
  it("trims trailing zeros so a glance reads fast", () => {
    expect(formatQty(fromUnitString("4"), "g")).toBe("4g");
    expect(formatQty(fromUnitString("4.5"), "g")).toBe("4.5g");
    expect(formatQty(fromUnitString("200"), "ml")).toBe("200ml");
  });

  it("omits the unit suffix for countable things", () => {
    expect(formatQty(fromUnitString("3"), "piece")).toBe("3");
  });

  it("formats negatives with a leading minus", () => {
    expect(formatQty(negateQty(fromUnitString("4")), "g")).toBe("-4g");
  });

  it("keeps sub-unit precision visible when it exists", () => {
    expect(formatQty(quantity(1), "g")).toBe("0.001g");
  });
});

describe("arithmetic", () => {
  it("add and sub are inverses", () => {
    const a = fromUnitString("4");
    const b = fromUnitString("200");
    expect(subQty(addQty(a, b), b)).toBe(a);
  });

  it("sum matches manual reduction", () => {
    const xs: Quantity[] = [fromUnitString("4"), fromUnitString("2.5"), fromUnitString("0.25")];
    expect(sumQty(xs)).toBe(addQty(addQty(xs[0]!, xs[1]!), xs[2]!));
  });

  it("sum of empty is zero", () => {
    expect(sumQty([])).toBe(ZERO_QTY);
  });

  it("negate is its own inverse", () => {
    const a = fromUnitString("4");
    expect(negateQty(negateQty(a))).toBe(a);
  });

  it("a restock is the exact negation of its depletion — the void case", () => {
    const depletion = fromUnitString("4.125");
    expect(addQty(depletion, negateQty(depletion))).toBe(ZERO_QTY);
  });

  it("scale multiplies by an integer factor", () => {
    expect(scaleQty(fromUnitString("4"), 3)).toBe(fromUnitString("12"));
  });

  it("scale rejects a non-integer factor", () => {
    expect(() => scaleQty(fromUnitString("4"), 1.5)).toThrow(QuantityError);
  });

  it("depleting the same recipe N times equals depleting it once scaled by N — no float drift", () => {
    // The invariant that matters for reconciliation: 500 sales of a 4.125g
    // drink must leave exactly the same on-hand as one 2062.5g depletion.
    const per = fromUnitString("4.125");
    let accumulated = ZERO_QTY;
    for (let i = 0; i < 500; i++) accumulated = addQty(accumulated, per);
    expect(accumulated).toBe(scaleQty(per, 500));
  });
});

describe("howManyFit", () => {
  it("floors — half a latte is not sellable", () => {
    expect(howManyFit(fromUnitString("10"), fromUnitString("4"))).toBe(2);
    expect(howManyFit(fromUnitString("8"), fromUnitString("4"))).toBe(2);
  });

  it("is zero when nothing is available", () => {
    expect(howManyFit(ZERO_QTY, fromUnitString("4"))).toBe(0);
    expect(howManyFit(negateQty(fromUnitString("1")), fromUnitString("4"))).toBe(0);
  });

  it("is Infinity when the recipe needs none of the ingredient", () => {
    // So a fold over ingredients is not capped by one the drink does not use.
    expect(howManyFit(fromUnitString("10"), ZERO_QTY)).toBe(Infinity);
  });

  it("rejects a negative per-unit requirement", () => {
    expect(() => howManyFit(fromUnitString("10"), negateQty(fromUnitString("1")))).toThrow(QuantityError);
  });
});

describe("MILLI", () => {
  it("is the milli-units-per-display-unit scale", () => {
    expect(MILLI).toBe(1000);
    expect(fromUnitString("1")).toBe(MILLI);
  });
});
