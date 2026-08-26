import { describe, expect, it } from "vitest";
import { formatTHB, fromBahtString, negate, satang, type Satang } from "../money.js";
import {
  THB_DENOMINATIONS,
  tallyTotal,
  reconcileDrawer,
  describeVariance,
  DrawerError,
} from "./drawer.js";

const b = (s: string): Satang => fromBahtString(s);

describe("THB_DENOMINATIONS", () => {
  it("is ordered largest first, for counting down through the piles", () => {
    expect([...THB_DENOMINATIONS].sort((a, b2) => b2 - a)).toEqual([...THB_DENOMINATIONS]);
  });

  it("includes the satang coins, which are legal tender even if rarely seen", () => {
    expect(THB_DENOMINATIONS).toContain(satang(50));
    expect(THB_DENOMINATIONS).toContain(satang(25));
  });

  it("every denomination is a whole number of satang", () => {
    for (const d of THB_DENOMINATIONS) expect(Number.isInteger(d)).toBe(true);
  });
});

describe("tallyTotal", () => {
  it("totals a realistic drawer", () => {
    // 2×฿1000, 3×฿100, 5×฿20, 8×฿1 = 2000 + 300 + 100 + 8 = ฿2408
    const total = tallyTotal({ 100_000: 2, 10_000: 3, 2_000: 5, 100: 8 });
    expect(total).toBe(b("2408"));
  });

  it("an empty drawer totals zero", () => {
    expect(tallyTotal({})).toBe(satang(0));
  });

  it("ignores denominations counted as zero", () => {
    expect(tallyTotal({ 100_000: 0, 10_000: 1 })).toBe(b("100"));
  });

  it("handles satang coins without float error", () => {
    // 3 × 25 satang + 1 × 50 satang = ฿1.25
    expect(tallyTotal({ 25: 3, 50: 1 })).toBe(b("1.25"));
  });

  it("rejects a fractional or negative count", () => {
    expect(() => tallyTotal({ 10_000: 1.5 })).toThrow(DrawerError);
    expect(() => tallyTotal({ 10_000: -1 })).toThrow(DrawerError);
  });
});

describe("reconcileDrawer", () => {
  it("balances when the count matches", () => {
    const r = reconcileDrawer(b("2408"), b("2408"));
    expect(r.status).toBe("BALANCED");
    expect(r.variance).toBe(satang(0));
  });

  it("is SHORT when less was counted than expected", () => {
    const r = reconcileDrawer(b("2408"), b("2388"));
    expect(r.status).toBe("SHORT");
    expect(r.variance).toBe(negate(b("20")));
  });

  it("is OVER when more was counted than expected", () => {
    const r = reconcileDrawer(b("2408"), b("2428"));
    expect(r.status).toBe("OVER");
    expect(r.variance).toBe(b("20"));
  });

  it("flags even a one-satang discrepancy — materiality is the reader's call", () => {
    // There is deliberately no tolerance: a variance the system calls
    // "balanced" is a variance nobody will investigate.
    expect(reconcileDrawer(b("100"), b("100.01")).status).toBe("OVER");
    expect(reconcileDrawer(b("100"), b("99.99")).status).toBe("SHORT");
  });

  it("preserves the variance rather than correcting the expectation", () => {
    const r = reconcileDrawer(b("2408"), b("2388"));
    expect(r.expected).toBe(b("2408")); // untouched
    expect(r.declared).toBe(b("2388"));
  });

  it("variance always reconstructs the declared figure", () => {
    for (const [expected, declared] of [
      ["0", "0"],
      ["100", "80"],
      ["80", "100"],
      ["2408", "2408"],
    ] as const) {
      const r = reconcileDrawer(b(expected), b(declared));
      expect(satang(r.expected + r.variance)).toBe(r.declared);
    }
  });

  it("rejects a negative count", () => {
    expect(() => reconcileDrawer(b("100"), negate(b("1")))).toThrow(DrawerError);
  });

  it("handles an empty day with an empty drawer", () => {
    expect(reconcileDrawer(satang(0), satang(0)).status).toBe("BALANCED");
  });
});

describe("describeVariance", () => {
  it("says short or over rather than leaving the reader to decode a sign", () => {
    expect(describeVariance(reconcileDrawer(b("100"), b("80")), formatTHB)).toBe("฿20.00 short");
    expect(describeVariance(reconcileDrawer(b("80"), b("100")), formatTHB)).toBe("฿20.00 over");
  });

  it("states a clean count plainly", () => {
    expect(describeVariance(reconcileDrawer(b("100"), b("100")), formatTHB)).toBe("Drawer balances");
  });

  it("renders the magnitude unsigned, since the word carries the direction", () => {
    expect(describeVariance(reconcileDrawer(b("100"), b("80")), formatTHB)).not.toContain("-");
  });
});
