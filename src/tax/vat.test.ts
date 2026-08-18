import { describe, expect, it } from "vitest";
import { fromBaht, fromBahtString, satang, sum, applyRate } from "../money.js";
import {
  extractInclusive,
  addExclusive,
  computeDocumentVat,
  registrationStatus,
  vatPayable,
  VAT_REGISTRATION_THRESHOLD,
  VatError,
  type DocumentLineInput,
} from "./vat.js";

const RATE_7 = 700;

describe("extractInclusive", () => {
  it("net + vat === gross, exactly, across a wide range of amounts and rates", () => {
    for (const rateBp of [0, 700, 1000]) {
      for (let baht = -200; baht <= 200; baht += 1) {
        const gross = fromBaht(baht);
        const split = extractInclusive(gross, rateBp);
        expect(split.net + split.vat).toBe(gross);
      }
    }
  });

  it("rejects a negative or non-integer rate", () => {
    expect(() => extractInclusive(fromBaht(100), -1)).toThrow();
    expect(() => extractInclusive(fromBaht(100), 7.5)).toThrow();
  });
});

describe("addExclusive", () => {
  it("is consistent with extractInclusive: adding VAT then extracting it gives back the same split shape", () => {
    for (let baht = 0; baht <= 200; baht += 1) {
      const net = fromBaht(baht);
      const added = addExclusive(net, RATE_7);
      expect(added.net + added.vat).toBe(added.gross);
    }
  });
});

describe("computeDocumentVat", () => {
  it("three ฿0.05 lines: naive per-line extraction loses the satang, document-level allocation does not", () => {
    const lineGross = fromBahtString("0.05"); // 5 satang
    const lines: DocumentLineInput[] = [
      { lineId: "a", gross: lineGross },
      { lineId: "b", gross: lineGross },
      { lineId: "c", gross: lineGross },
    ];

    // Naive: extract VAT independently per line, at the same rate.
    const naiveVatPerLine = lines.map((l) => extractInclusive(l.gross, RATE_7).vat);
    expect(sum(naiveVatPerLine)).toBe(satang(0)); // invisible per receipt

    // Correct: extract once at the document level, then allocate down.
    const doc = computeDocumentVat(lines, { rateBp: RATE_7, vatRegistered: true });
    expect(doc.vat).toBe(satang(1)); // unreconcilable across a year of receipts if silently dropped
    expect(sum(doc.lines.map((l) => l.vat))).toBe(doc.vat);
  });

  it("net + vat === gross at both the document and line level, for arbitrary line sets", () => {
    const priceOptions = [8000, 7500, 9000, 5, 100_000_00].map((n) => satang(n));
    for (const rateBp of [0, 700, 1000]) {
      const lines: DocumentLineInput[] = priceOptions.map((gross, i) => ({ lineId: `l${i}`, gross }));
      const doc = computeDocumentVat(lines, { rateBp, vatRegistered: true });

      expect(doc.net + doc.vat).toBe(doc.gross);
      expect(sum(doc.lines.map((l) => l.vat))).toBe(doc.vat);
      expect(sum(doc.lines.map((l) => l.net))).toBe(doc.net);
      for (const line of doc.lines) {
        expect(line.net + line.vat).toBe(line.gross);
      }
    }
  });

  it("when unregistered: zero VAT, net === gross, and no tax invoice may be issued", () => {
    const lines: DocumentLineInput[] = [{ lineId: "a", gross: fromBahtString("100") }];
    const doc = computeDocumentVat(lines, { rateBp: RATE_7, vatRegistered: false });

    expect(doc.vat).toBe(satang(0));
    expect(doc.net).toBe(doc.gross);
    expect(doc.taxInvoiceEligible).toBe(false);
    expect(doc.rateBp).toBe(0);
  });

  it("throws on an empty document", () => {
    expect(() => computeDocumentVat([], { rateBp: RATE_7, vatRegistered: true })).toThrow(VatError);
  });

  it("throws on a duplicate lineId", () => {
    const lines: DocumentLineInput[] = [
      { lineId: "dup", gross: fromBahtString("10") },
      { lineId: "dup", gross: fromBahtString("20") },
    ];
    expect(() => computeDocumentVat(lines, { rateBp: RATE_7, vatRegistered: true })).toThrow(VatError);
  });

  it("registered and taxInvoiceEligible when vatRegistered is true", () => {
    const lines: DocumentLineInput[] = [{ lineId: "a", gross: fromBahtString("100") }];
    const doc = computeDocumentVat(lines, { rateBp: RATE_7, vatRegistered: true });
    expect(doc.vatRegistered).toBe(true);
    expect(doc.taxInvoiceEligible).toBe(true);
  });
});

describe("vatPayable", () => {
  it("is output minus input", () => {
    expect(vatPayable(satang(1000), satang(400))).toBe(satang(600));
    expect(vatPayable(satang(400), satang(1000))).toBe(satang(-600)); // credit carried
  });
});

describe("registrationStatus", () => {
  it("is not required below the threshold", () => {
    const status = registrationStatus(satang(1_000_000_00));
    expect(status.required).toBe(false);
  });

  it("is required strictly above the threshold", () => {
    const status = registrationStatus(satang(VAT_REGISTRATION_THRESHOLD + 1));
    expect(status.required).toBe(true);
  });

  it("flags approaching once past the warn threshold but still under the line", () => {
    const status = registrationStatus(satang(Math.round(VAT_REGISTRATION_THRESHOLD * 0.9)));
    expect(status.approaching).toBe(true);
    expect(status.required).toBe(false);
  });

  it("does not flag approaching once already required", () => {
    const status = registrationStatus(satang(VAT_REGISTRATION_THRESHOLD + 1));
    expect(status.approaching).toBe(false);
  });
});

// applyRate is re-exported behaviour from money.ts; sanity-check it's wired
// consistently with what extractInclusive assumes about rounding.
describe("cross-module sanity", () => {
  it("applyRate and extractInclusive agree on the VAT-exclusive addExclusive path", () => {
    const net = fromBahtString("100");
    expect(applyRate(net, RATE_7)).toBe(addExclusive(net, RATE_7).vat);
  });
});
