import { describe, expect, it } from "vitest";
import {
  rateAt,
  validateRateTable,
  TH_VAT_RATES,
  TH_VAT_STATUTORY_BP,
  TaxRateError,
  type TaxRate,
} from "./rates.js";

describe("validateRateTable", () => {
  it("accepts the real TH_VAT_RATES table", () => {
    expect(() => validateRateTable(TH_VAT_RATES)).not.toThrow();
  });

  it("rejects an invalid rateBp", () => {
    const bad: TaxRate[] = [
      { code: "X", rateBp: -1, validFrom: "2024-01-01T00:00:00+07:00", validTo: null, authority: "test" },
    ];
    expect(() => validateRateTable(bad)).toThrow(TaxRateError);
  });

  it("rejects validTo at or before validFrom", () => {
    const bad: TaxRate[] = [
      {
        code: "X",
        rateBp: 700,
        validFrom: "2024-01-01T00:00:00+07:00",
        validTo: "2024-01-01T00:00:00+07:00",
        authority: "test",
      },
    ];
    expect(() => validateRateTable(bad)).toThrow(TaxRateError);
  });

  it("rejects overlapping periods for the same code", () => {
    const bad: TaxRate[] = [
      {
        code: "X",
        rateBp: 700,
        validFrom: "2024-01-01T00:00:00+07:00",
        validTo: "2025-01-01T00:00:00+07:00",
        authority: "a",
      },
      {
        code: "X",
        rateBp: 1000,
        validFrom: "2024-06-01T00:00:00+07:00",
        validTo: null,
        authority: "b",
      },
    ];
    expect(() => validateRateTable(bad)).toThrow(TaxRateError);
  });

  it("does not confuse periods across different codes", () => {
    const ok: TaxRate[] = [
      { code: "A", rateBp: 700, validFrom: "2024-01-01T00:00:00+07:00", validTo: null, authority: "a" },
      { code: "B", rateBp: 1000, validFrom: "2020-01-01T00:00:00+07:00", validTo: null, authority: "b" },
    ];
    expect(() => validateRateTable(ok)).not.toThrow();
  });
});

describe("rateAt", () => {
  it("resolves the rate in force for a date well inside a known decree", () => {
    const resolved = rateAt("VAT_TH", new Date("2026-01-01T00:00:00Z"));
    expect(resolved.rateBp).toBe(700);
    expect(resolved.provisional).toBe(false);
    expect(resolved.authority).toContain("799");
  });

  it("a sale rung at 00:30 ICT on 1 October is 30 September in UTC — boundary is Bangkok-local", () => {
    // 2025-10-01T00:00:00+07:00 is exactly the boundary between decree 780 and 799.
    const justBefore = rateAt("VAT_TH", new Date("2025-09-30T16:59:59.999Z"));
    const atBoundary = rateAt("VAT_TH", new Date("2025-09-30T17:00:00.000Z")); // == 2025-10-01T00:00:00+07:00

    expect(justBefore.authority).toContain("780");
    expect(atBoundary.authority).toContain("799");
  });

  it("carries the last known decree forward, flagged provisional, past the end of the table", () => {
    const resolved = rateAt("VAT_TH", new Date("2028-01-01T00:00:00Z"));
    expect(resolved.provisional).toBe(true);
    expect(resolved.rateBp).toBe(700); // last known rate, not the 10% statutory default
    expect(resolved.authority).toMatch(/expired/i);
    expect(resolved.authority).toMatch(/carried forward/i);
  });

  it("does not block the sale past the last known decree — it still returns a usable rate", () => {
    expect(() => rateAt("VAT_TH", new Date("2099-01-01T00:00:00Z"))).not.toThrow();
  });

  it("falls back to the statutory rate, flagged provisional, before the table begins", () => {
    const resolved = rateAt("VAT_TH", new Date("2020-01-01T00:00:00Z"));
    expect(resolved.provisional).toBe(true);
    expect(resolved.rateBp).toBe(TH_VAT_STATUTORY_BP);
  });

  it("throws on an invalid Date", () => {
    expect(() => rateAt("VAT_TH", new Date("not-a-date"))).toThrow(TaxRateError);
  });

  it("throws when no table exists for the given code", () => {
    expect(() => rateAt("NOT_A_REAL_CODE", new Date())).toThrow(TaxRateError);
  });
});
