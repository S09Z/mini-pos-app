import { describe, expect, it } from "vitest";
import { fromBaht } from "../money.js";
import { buildPp30, outputTaxEntries, type InputTaxEntry } from "./pp30.js";
import { pp30Csv, pp30PurchasesCsv } from "./pp30csv.js";

const output = outputTaxEntries(
  [
    {
      id: "1",
      receiptNo: "A-1",
      at: "2026-01-05T10:00:00+07:00",
      net: fromBaht(1_000),
      vat: fromBaht(70),
    },
  ],
  [],
);

const purchases: InputTaxEntry[] = [
  {
    id: "p1",
    at: "2026-01-10T10:00:00+07:00",
    supplier: "Marukyu Koyamaen",
    invoiceNo: "S-1",
    net: fromBaht(500),
    vat: fromBaht(35),
    claimable: true,
    disallowedReason: null,
  },
  {
    id: "p2",
    at: "2026-01-11T10:00:00+07:00",
    // A supplier name is operator-entered, so it is an injection vector.
    supplier: "=cmd()|'/c calc'!A1",
    invoiceNo: "S-2",
    net: fromBaht(100),
    vat: fromBaht(7),
    claimable: false,
    disallowedReason: "No tax invoice",
  },
];

describe("pp30Csv", () => {
  const csv = () => pp30Csv(buildPp30("2026-01", output, purchases));

  it("states every figure the return needs, as plain decimals", () => {
    const text = csv();
    expect(text).toContain("Output VAT,70.00");
    expect(text).toContain("Input VAT claimed,35.00");
    expect(text).toContain("VAT payable,35.00");
  });

  it("reports disallowed input tax rather than hiding it", () => {
    expect(csv()).toContain("Input VAT disallowed,7.00");
  });

  it("carries the caveat into the file, where the accountant will actually read it", () => {
    expect(csv()).toContain("draft");
  });
});

describe("pp30PurchasesCsv", () => {
  it("guards a supplier name that would execute as a formula, and guards it exactly once", () => {
    const text = pp30PurchasesCsv("2026-01", purchases);
    expect(text).toContain(",'=cmd()|'/c calc'!A1,");
    expect(text).not.toContain("''=cmd");
  });

  it("lists only the period asked for", () => {
    const february = pp30PurchasesCsv("2026-02", purchases);
    expect(february).not.toContain("Marukyu");
  });

  it("says why a disallowed purchase was excluded", () => {
    expect(pp30PurchasesCsv("2026-01", purchases)).toContain("No tax invoice");
  });
});
