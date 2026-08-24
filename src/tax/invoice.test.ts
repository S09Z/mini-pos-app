import { describe, expect, it } from "vitest";
import { fromBaht, satang, sum } from "../money.js";
import { computeDocumentVat } from "./vat.js";
import { HEAD_OFFICE_BRANCH } from "./registration.js";
import {
  ABBREVIATED_HEADING_TH,
  FULL_HEADING_TH,
  TaxInvoiceError,
  VAT_INCLUDED_NOTICE_TH,
  buildTaxInvoice,
  type InvoiceBuyer,
  type InvoiceSeller,
  type InvoiceSource,
} from "./invoice.js";

const SELLER_TAX_ID = "0105536000020";
const BUYER_TAX_ID = "0105536000020";

const SELLER: InvoiceSeller = {
  name: "Matcha Stall Co., Ltd.",
  address: "12 Soi Ari 4, Phaya Thai, Bangkok 10400",
  taxId: SELLER_TAX_ID,
  branchCode: HEAD_OFFICE_BRANCH,
  posMachineNumber: "POS-01-2569",
};

const BUYER: InvoiceBuyer = {
  name: "Acme (Thailand) Co., Ltd.",
  address: "999 Rama IV Road, Khlong Toei, Bangkok 10110",
  taxId: BUYER_TAX_ID,
};

/** Build a source from real domain output rather than hand-typed figures. */
function source(over: Partial<InvoiceSource> = {}): InvoiceSource {
  const cart = [
    { lineId: "iced-matcha", description: "Iced Matcha", qty: 2, unitPrice: fromBaht(80) },
    { lineId: "hojicha", description: "Hojicha", qty: 1, unitPrice: fromBaht(75) },
  ];
  const doc = computeDocumentVat(
    cart.map((l) => ({ lineId: l.lineId, gross: satang(l.unitPrice * l.qty) })),
    { rateBp: 700, vatRegistered: true },
  );

  return {
    saleId: "sale-1",
    receiptNo: "A-1043",
    issuedAt: "2026-08-23T11:20:00+07:00",
    vatRegistered: true,
    taxInvoiceEligible: true,
    rateBp: doc.rateBp,
    authority: "Royal Decree No. 799 (B.E. 2568)",
    provisional: false,
    gross: doc.gross,
    net: doc.net,
    vat: doc.vat,
    lines: cart.map((l, i) => ({
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      gross: doc.lines[i]!.gross,
      net: doc.lines[i]!.net,
      vat: doc.lines[i]!.vat,
    })),
    ...over,
  };
}

describe("buildTaxInvoice — rule 7: never issue while unregistered", () => {
  it("refuses when the sale was rung unregistered", () => {
    expect(() =>
      buildTaxInvoice(source({ vatRegistered: false, taxInvoiceEligible: false, vat: satang(0) }), {
        kind: "ABBREVIATED",
        invoiceNo: "TX-1",
        seller: SELLER,
      }),
    ).toThrow(TaxInvoiceError);
  });

  it("refuses even when the caller claims eligibility on an unregistered sale", () => {
    // The two flags disagreeing is itself a bug. Trusting the permissive one
    // is how a UI override sneaks in through the back door.
    expect(() =>
      buildTaxInvoice(source({ vatRegistered: false, taxInvoiceEligible: true }), {
        kind: "FULL",
        invoiceNo: "TX-1",
        seller: SELLER,
        buyer: BUYER,
      }),
    ).toThrow(TaxInvoiceError);
  });

  it("refuses a registered sale that carries no VAT rate", () => {
    expect(() =>
      buildTaxInvoice(source({ rateBp: 0, vat: satang(0), net: source().gross }), {
        kind: "ABBREVIATED",
        invoiceNo: "TX-1",
        seller: SELLER,
      }),
    ).toThrow(TaxInvoiceError);
  });
});

describe("buildTaxInvoice — abbreviated (ใบกำกับภาษีอย่างย่อ)", () => {
  const invoice = () =>
    buildTaxInvoice(source(), { kind: "ABBREVIATED", invoiceNo: "TX-1", seller: SELLER });

  it("carries the Thai heading verbatim and the machine number", () => {
    const inv = invoice();
    expect(inv.headingTh).toBe(ABBREVIATED_HEADING_TH);
    expect(inv.posMachineNumber).toBe("POS-01-2569");
  });

  it("states that the price includes VAT, because the figures shown are inclusive", () => {
    const inv = invoice();
    expect(inv.vatIncludedNotice).toBe(VAT_INCLUDED_NOTICE_TH);
    expect(inv.gross).toBe(fromBaht(235));
    expect(inv.net + inv.vat).toBe(inv.gross);
  });

  it("names the head office in Thai", () => {
    expect(invoice().branchLabel).toBe("สำนักงานใหญ่");
  });

  it("refuses without a POS machine number", () => {
    expect(() =>
      buildTaxInvoice(source(), {
        kind: "ABBREVIATED",
        invoiceNo: "TX-1",
        seller: { ...SELLER, posMachineNumber: "  " },
      }),
    ).toThrow(TaxInvoiceError);
  });

  it("refuses a buyer — an abbreviated invoice cannot identify one, so the caller meant FULL", () => {
    expect(() =>
      buildTaxInvoice(source(), {
        kind: "ABBREVIATED",
        invoiceNo: "TX-1",
        seller: SELLER,
        buyer: BUYER,
      }),
    ).toThrow(TaxInvoiceError);
  });

  it("has no buyer and cannot be used to claim input tax", () => {
    const inv = invoice();
    expect(inv.buyer).toBe(null);
    expect(inv.buyerCanClaimInputTax).toBe(false);
  });
});

describe("buildTaxInvoice — full (ใบกำกับภาษี)", () => {
  const invoice = (buyer: InvoiceBuyer = BUYER) =>
    buildTaxInvoice(source(), { kind: "FULL", invoiceNo: "TX-2", seller: SELLER, buyer });

  it("carries the Thai heading verbatim and shows VAT separately", () => {
    const inv = invoice();
    expect(inv.headingTh).toBe(FULL_HEADING_TH);
    // A full invoice states net and VAT as separate figures; the "price
    // includes VAT" notice belongs only on the abbreviated form.
    expect(inv.vatIncludedNotice).toBe(null);
    expect(inv.net).toBe(fromBaht(219.63));
    expect(inv.vat).toBe(fromBaht(15.37));
  });

  it("requires a buyer, with a name and an address", () => {
    for (const bad of [
      undefined,
      { ...BUYER, name: "" },
      { ...BUYER, address: "   " },
    ] as (InvoiceBuyer | undefined)[]) {
      expect(() =>
        buildTaxInvoice(source(), {
          kind: "FULL",
          invoiceNo: "TX-2",
          seller: SELLER,
          ...(bad === undefined ? {} : { buyer: bad }),
        }),
      ).toThrow(TaxInvoiceError);
    }
  });

  it("refuses a buyer tax ID that fails its checksum", () => {
    expect(() => invoice({ ...BUYER, taxId: "1234567890123" })).toThrow(TaxInvoiceError);
  });

  it("allows an individual with no tax ID, and says plainly that they cannot claim input tax", () => {
    const inv = invoice({ name: "Somchai P.", address: "Bangkok", taxId: null });
    expect(inv.buyer?.taxId).toBe(null);
    expect(inv.buyerCanClaimInputTax).toBe(false);
  });

  it("a company with a valid tax ID can claim", () => {
    expect(invoice().buyerCanClaimInputTax).toBe(true);
  });
});

describe("buildTaxInvoice — the figures are the sale's, never recomputed", () => {
  it("lines tie to the document, and the document ties to itself", () => {
    const inv = buildTaxInvoice(source(), {
      kind: "ABBREVIATED",
      invoiceNo: "TX-1",
      seller: SELLER,
    });
    expect(sum(inv.lines.map((l) => l.gross))).toBe(inv.gross);
    expect(sum(inv.lines.map((l) => l.net))).toBe(inv.net);
    expect(sum(inv.lines.map((l) => l.vat))).toBe(inv.vat);
  });

  it("refuses a source whose lines do not tie — the arithmetic must not be papered over", () => {
    const bad = source();
    const tampered: InvoiceSource = {
      ...bad,
      lines: bad.lines.map((l, i) => (i === 0 ? { ...l, vat: satang(l.vat + 1) } : l)),
    };
    expect(() =>
      buildTaxInvoice(tampered, { kind: "ABBREVIATED", invoiceNo: "TX-1", seller: SELLER }),
    ).toThrow(TaxInvoiceError);
  });

  it("refuses a negative document — a reversal is a credit note, which this does not issue", () => {
    const negative = source();
    expect(() =>
      buildTaxInvoice(
        {
          ...negative,
          gross: satang(-negative.gross),
          net: satang(-negative.net),
          vat: satang(-negative.vat),
          lines: negative.lines.map((l) => ({
            ...l,
            gross: satang(-l.gross),
            net: satang(-l.net),
            vat: satang(-l.vat),
          })),
        },
        { kind: "ABBREVIATED", invoiceNo: "TX-1", seller: SELLER },
      ),
    ).toThrow(TaxInvoiceError);
  });

  it("carries the rate authority and the provisional flag through to the printed document", () => {
    const inv = buildTaxInvoice(source({ provisional: true, authority: "carried forward" }), {
      kind: "ABBREVIATED",
      invoiceNo: "TX-1",
      seller: SELLER,
    });
    expect(inv.provisional).toBe(true);
    expect(inv.authority).toBe("carried forward");
  });
});

describe("buildTaxInvoice — originals and copies", () => {
  it("is an original by default and marks a reprint as a copy", () => {
    const original = buildTaxInvoice(source(), {
      kind: "ABBREVIATED",
      invoiceNo: "TX-1",
      seller: SELLER,
    });
    expect(original.originalityLabelTh).toBe("ต้นฉบับ");

    const reprint = buildTaxInvoice(source(), {
      kind: "ABBREVIATED",
      invoiceNo: "TX-1",
      seller: SELLER,
      copy: true,
    });
    // Same number, marked as a copy: two unmarked originals of one invoice
    // number is exactly the document a duplicate input-tax claim is built on.
    expect(reprint.invoiceNo).toBe(original.invoiceNo);
    expect(reprint.originalityLabelTh).toBe("สำเนา");
  });
});
