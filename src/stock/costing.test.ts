import { describe, expect, it } from "vitest";
import { fromBahtString, negate, satang, type Satang } from "../money.js";
import { fromUnitString, negateQty, ZERO_QTY, type Quantity } from "./units.js";
import {
  unitCost,
  unitCostOfPurchase,
  blendCost,
  costOf,
  costOfGoods,
  stockValue,
  CostingError,
  type UnitCost,
} from "./costing.js";

const g = (s: string): Quantity => fromUnitString(s);
const b = (s: string): Satang => fromBahtString(s);

describe("unitCost", () => {
  it("rejects non-integer, non-finite, and negative costs", () => {
    expect(() => unitCost(1.5)).toThrow(CostingError);
    expect(() => unitCost(NaN)).toThrow(CostingError);
    expect(() => unitCost(-1)).toThrow(CostingError);
  });
});

describe("unitCostOfPurchase", () => {
  it("prices matcha at ฿2,000 per 100g as 2,000 satang per gram", () => {
    // 2,000 satang/g expressed in millisatang per gram.
    expect(unitCostOfPurchase(b("2000"), g("100"))).toBe(2_000_000);
  });

  it("keeps precision on cheap bulk ingredients that would otherwise round to nothing", () => {
    // Sugar at ฿30/kg = 0.003 satang per gram. Without the millisatang scale
    // this is zero, and a kilo of sugar would cost nothing forever.
    const cost = unitCostOfPurchase(b("30"), g("1000"));
    expect(cost).toBe(3_000);
    expect(cost).toBeGreaterThan(0);
  });

  it("prices countable things per piece", () => {
    // ฿100 for 50 cups = ฿2 each = 200 satang = 200,000 millisatang per cup.
    expect(unitCostOfPurchase(b("100"), g("50"))).toBe(200_000);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => unitCostOfPurchase(b("100"), ZERO_QTY)).toThrow(CostingError);
    expect(() => unitCostOfPurchase(b("100"), negateQty(g("1")))).toThrow(CostingError);
  });

  it("rejects a negative purchase cost", () => {
    expect(() => unitCostOfPurchase(negate(b("100")), g("10"))).toThrow(CostingError);
  });
});

describe("blendCost", () => {
  it("takes the new price outright when nothing is on hand", () => {
    expect(blendCost(ZERO_QTY, 999_999, g("100"), b("2000"))).toBe(2_000_000);
  });

  it("does not let a negative on-hand drag the average", () => {
    // A negative on-hand means an unrecorded purchase — a discrepancy to
    // surface, not a weight to price the next sale with.
    expect(blendCost(negateQty(g("10")), 999_999, g("100"), b("2000"))).toBe(2_000_000);
  });

  it("blends proportionally to quantity", () => {
    // 100g on hand at 2,000 satang/g, buy 100g at 3,000 satang/g -> 2,500.
    const blended = blendCost(g("100"), 2_000_000, g("100"), b("3000"));
    expect(blended).toBe(2_500_000);
  });

  it("weights a large existing stock more heavily than a small purchase", () => {
    // 900g at 2,000/g plus 100g at 3,000/g -> 2,100, not the midpoint.
    const blended = blendCost(g("900"), 2_000_000, g("100"), b("3000"));
    expect(blended).toBe(2_100_000);
  });

  it("leaves the average unchanged when repurchasing at the same price", () => {
    expect(blendCost(g("100"), 2_000_000, g("100"), b("2000"))).toBe(2_000_000);
  });

  it("always lands between the old and new unit cost", () => {
    for (const onHandStr of ["1", "50", "100", "5000"]) {
      const blended = blendCost(g(onHandStr), 2_000_000, g("100"), b("3000"));
      expect(blended).toBeGreaterThanOrEqual(2_000_000);
      expect(blended).toBeLessThanOrEqual(3_000_000);
    }
  });

  it("rejects a non-positive purchase", () => {
    expect(() => blendCost(g("100"), 2_000_000, ZERO_QTY, b("2000"))).toThrow(CostingError);
  });
});

describe("costOf", () => {
  it("costs 4g of matcha at 2,000 satang/g as ฿80", () => {
    expect(costOf(g("4"), 2_000_000)).toBe(b("80"));
  });

  it("costs 200ml of milk at ฿50/L as ฿10", () => {
    const milkCost = unitCostOfPurchase(b("50"), g("1000"));
    expect(costOf(g("200"), milkCost)).toBe(b("10"));
  });

  it("is zero for a zero quantity", () => {
    expect(costOf(ZERO_QTY, 2_000_000)).toBe(satang(0));
  });

  it("negates exactly, so a costed void restock reverses its depletion", () => {
    const qty = g("4.125");
    expect(costOf(negateQty(qty), 2_000_000)).toBe(negate(costOf(qty, 2_000_000)));
  });

  it("scales linearly across a range", () => {
    for (let n = 1; n <= 20; n++) {
      expect(costOf(g(String(4 * n)), 2_000_000)).toBe(satang(costOf(g("4"), 2_000_000) * n));
    }
  });
});

describe("costOfGoods", () => {
  const costs = new Map<string, UnitCost>([
    ["matcha", 2_000_000], // 2,000 satang/g
    ["milk", 5_000], // 5 satang/ml
    ["cup", 200_000], // 200 satang/piece
  ]);

  it("sums the parts — unlike VAT, there is no document total to tie back to", () => {
    // One latte: 4g matcha (฿80) + 200ml milk (฿10) + 1 cup (฿2) = ฿92.
    const cogs = costOfGoods(
      [
        { ingredientId: "matcha", qty: g("4") },
        { ingredientId: "milk", qty: g("200") },
        { ingredientId: "cup", qty: g("1") },
      ],
      costs,
    );
    expect(cogs).toBe(b("92"));
  });

  it("treats an unpriced ingredient as zero rather than blocking the sale", () => {
    const cogs = costOfGoods(
      [
        { ingredientId: "matcha", qty: g("4") },
        { ingredientId: "mystery-syrup", qty: g("15") },
      ],
      costs,
    );
    expect(cogs).toBe(b("80"));
  });

  it("is zero for an empty requirement set", () => {
    expect(costOfGoods([], costs)).toBe(satang(0));
  });
});

describe("stockValue", () => {
  it("values what is sitting in the tins", () => {
    const onHand = new Map<string, Quantity>([
      ["matcha", g("100")], // ฿2,000
      ["milk", g("2000")], // ฿100
    ]);
    const costs = new Map<string, UnitCost>([
      ["matcha", 2_000_000],
      ["milk", 5_000],
    ]);
    expect(stockValue(onHand, costs)).toBe(b("2100"));
  });

  it("skips ingredients with no known cost", () => {
    const onHand = new Map<string, Quantity>([["mystery", g("100")]]);
    expect(stockValue(onHand, new Map())).toBe(satang(0));
  });
});
