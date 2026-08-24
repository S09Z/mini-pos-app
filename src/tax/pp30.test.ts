import { describe, expect, it } from "vitest";
import { fromBaht, satang, sum, type Satang } from "../money.js";
import {
  Pp30Error,
  buildPp30,
  outputTaxEntries,
  periodOf,
  pp30Series,
  type InputTaxEntry,
  type OutputTaxEntry,
  type SaleForTax,
  type VoidForTax,
} from "./pp30.js";

const sale = (id: string, at: string, net: number, vat: number): SaleForTax => ({
  id,
  receiptNo: `A-${id}`,
  at,
  net: fromBaht(net),
  vat: fromBaht(vat),
});

const purchase = (
  id: string,
  at: string,
  net: number,
  vat: number,
  over: Partial<InputTaxEntry> = {},
): InputTaxEntry => ({
  id,
  at,
  supplier: "Marukyu Koyamaen",
  invoiceNo: `S-${id}`,
  net: fromBaht(net),
  vat: fromBaht(vat),
  claimable: true,
  disallowedReason: null,
  ...over,
});

describe("periodOf", () => {
  it("is a Bangkok month, not a UTC one", () => {
    // 17:30Z on 31 January is 00:30 ICT on 1 February. Grouping on the UTC
    // month would file this sale in the wrong PP.30 return entirely.
    expect(periodOf("2026-01-31T17:30:00Z")).toBe("2026-02");
    expect(periodOf("2026-02-01T00:30:00+07:00")).toBe("2026-02");
  });
});

describe("outputTaxEntries", () => {
  const jan = sale("1", "2026-01-15T10:00:00+07:00", 100, 7);

  it("a sale voided in the same month nets to zero", () => {
    const voids: VoidForTax[] = [
      { saleId: "1", receiptNo: "A-2", at: "2026-01-15T10:05:00+07:00" },
    ];
    const entries = outputTaxEntries([jan], voids);
    expect(sum(entries.map((e) => e.vat))).toBe(satang(0));
    expect(sum(entries.map((e) => e.net))).toBe(satang(0));
  });

  it("a sale voided in a LATER month stays in its own month; the reversal lands in the void's month", () => {
    // This is the case a naive `where not voided` filter gets wrong. January's
    // PP.30 was already filed with that VAT declared; the correction belongs in
    // February, where the credit note was actually issued.
    const voids: VoidForTax[] = [
      { saleId: "1", receiptNo: "A-2", at: "2026-02-03T10:00:00+07:00" },
    ];
    const entries = outputTaxEntries([jan], voids);

    const janReturn = buildPp30("2026-01", entries, []);
    const febReturn = buildPp30("2026-02", entries, []);

    expect(janReturn.outputVat).toBe(fromBaht(7));
    expect(febReturn.outputVat).toBe(fromBaht(-7));
  });

  it("marks the reversal so it can be read as one, and points at the original sale", () => {
    const voids: VoidForTax[] = [
      { saleId: "1", receiptNo: "A-2", at: "2026-02-03T10:00:00+07:00" },
    ];
    const reversal = outputTaxEntries([jan], voids).find((e) => e.source === "VOID")!;
    expect(reversal.saleId).toBe("1");
    expect(reversal.vat).toBe(fromBaht(-7));
  });

  it("refuses a void that points at no sale — a dangling reversal would understate output tax", () => {
    expect(() =>
      outputTaxEntries([jan], [{ saleId: "ghost", receiptNo: "A-9", at: "2026-02-03T10:00:00+07:00" }]),
    ).toThrow(Pp30Error);
  });
});

describe("buildPp30", () => {
  const output: OutputTaxEntry[] = outputTaxEntries(
    [
      sale("1", "2026-01-05T10:00:00+07:00", 1_000, 70),
      sale("2", "2026-01-20T10:00:00+07:00", 2_000, 140),
      sale("3", "2026-02-02T10:00:00+07:00", 500, 35),
    ],
    [],
  );

  it("sums only the period asked for", () => {
    const jan = buildPp30("2026-01", output, []);
    expect(jan.sales.net).toBe(fromBaht(3_000));
    expect(jan.outputVat).toBe(fromBaht(210));
    expect(jan.sales.entries).toBe(2);
  });

  it("payable is output minus input", () => {
    const jan = buildPp30("2026-01", output, [purchase("p1", "2026-01-10T10:00:00+07:00", 1_000, 70)]);
    expect(jan.inputVat).toBe(fromBaht(70));
    expect(jan.payable).toBe(fromBaht(140));
    expect(jan.creditCarriedForward).toBe(satang(0));
  });

  it("more input than output becomes a credit carried forward, never a negative payable", () => {
    const jan = buildPp30("2026-01", output, [purchase("p1", "2026-01-10T10:00:00+07:00", 5_000, 350)]);
    expect(jan.payable).toBe(satang(0));
    expect(jan.creditCarriedForward).toBe(fromBaht(140));
  });

  it("exactly one of payable and credit-carried-forward is non-zero, for any combination", () => {
    for (let outVat = 0; outVat <= 200; outVat += 25) {
      for (let inVat = 0; inVat <= 200; inVat += 25) {
        for (const cbf of [0, 50]) {
          const r = buildPp30(
            "2026-01",
            outputTaxEntries([sale("x", "2026-01-05T10:00:00+07:00", 0, outVat)], []),
            [purchase("p", "2026-01-05T10:00:00+07:00", 0, inVat)],
            fromBaht(cbf),
          );
          expect(r.payable >= 0).toBe(true);
          expect(r.creditCarriedForward >= 0).toBe(true);
          expect(r.payable === 0 || r.creditCarriedForward === 0).toBe(true);
          // The two together always restate the same signed figure.
          expect(r.payable - r.creditCarriedForward).toBe(
            fromBaht(outVat) - fromBaht(inVat) - fromBaht(cbf),
          );
        }
      }
    }
  });

  it("excludes disallowed input tax from the claim but still reports it", () => {
    const jan = buildPp30("2026-01", output, [
      purchase("p1", "2026-01-10T10:00:00+07:00", 1_000, 70),
      purchase("p2", "2026-01-11T10:00:00+07:00", 500, 35, {
        claimable: false,
        disallowedReason: "No tax invoice from the supplier",
      }),
    ]);
    expect(jan.inputVat).toBe(fromBaht(70));
    expect(jan.purchases.disallowedVat).toBe(fromBaht(35));
    expect(jan.purchases.disallowedEntries).toBe(1);
  });

  it("rejects a period that is not YYYY-MM", () => {
    expect(() => buildPp30("2026-1", output, [])).toThrow(Pp30Error);
    expect(() => buildPp30("2026-01-05", output, [])).toThrow(Pp30Error);
  });

  it("a month with no activity is a valid nil return, not an error", () => {
    const march = buildPp30("2026-03", output, []);
    expect(march.outputVat).toBe(satang(0));
    expect(march.payable).toBe(satang(0));
    expect(march.sales.entries).toBe(0);
  });
});

describe("pp30Series", () => {
  const output = outputTaxEntries(
    [
      sale("1", "2026-01-05T10:00:00+07:00", 1_000, 70),
      // Nothing at all in February.
      sale("2", "2026-03-05T10:00:00+07:00", 1_000, 70),
    ],
    [],
  );
  const input: InputTaxEntry[] = [purchase("p1", "2026-01-10T10:00:00+07:00", 5_000, 350)];

  it("covers every month between the first and last, including the empty ones", () => {
    expect(pp30Series(output, input).map((r) => r.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("carries a credit forward through a month with no activity at all", () => {
    const [jan, feb, mar] = pp30Series(output, input);
    expect(jan!.creditCarriedForward).toBe(fromBaht(280));
    expect(feb!.creditBroughtForward).toBe(fromBaht(280));
    expect(feb!.creditCarriedForward).toBe(fromBaht(280)); // untouched by a nil month
    expect(mar!.creditBroughtForward).toBe(fromBaht(280));
    // March's ฿70 of output tax is absorbed by the credit, leaving ฿210.
    expect(mar!.payable).toBe(satang(0));
    expect(mar!.creditCarriedForward).toBe(fromBaht(210));
  });

  it("each month's carried-forward credit is the next month's brought-forward, without exception", () => {
    const series = pp30Series(output, input);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.creditBroughtForward).toBe(series[i - 1]!.creditCarriedForward);
    }
  });

  it("an empty ledger is an empty series, not a crash", () => {
    expect(pp30Series([], [])).toEqual([]);
  });

  it("total VAT settled across the series equals output minus input over the whole ledger", () => {
    const series = pp30Series(output, input);
    const paid: Satang = sum(series.map((r) => r.payable));
    const finalCredit = series[series.length - 1]!.creditCarriedForward;
    const totalOutput = sum(output.map((e) => e.vat));
    const totalInput = sum(input.filter((e) => e.claimable).map((e) => e.vat));
    expect(paid - finalCredit).toBe(totalOutput - totalInput);
  });
});
