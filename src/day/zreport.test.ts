import { describe, expect, it } from "vitest";
import { fromBahtString, satang, type Satang } from "../money.js";
import { bangkokDayBounds } from "./period.js";
import {
  buildZReport,
  type ReportableSale,
  type ReportableSaleLine,
  type ReportableVoid,
} from "./zreport.js";

const b = (s: string): Satang => fromBahtString(s);
const DAY = bangkokDayBounds("2026-08-19");

/** 10:00 ICT on the report day. */
const at = (hourICT: number, minute = 0): string =>
  new Date(Date.parse(DAY.startISO) + hourICT * 3_600_000 + minute * 60_000).toISOString();

function sale(
  id: string,
  grossBaht: string,
  hourICT: number,
  opts: { vat?: string } = {},
): ReportableSale {
  const gross = b(grossBaht);
  const vat = opts.vat === undefined ? satang(0) : b(opts.vat);
  return {
    id,
    receiptNo: `A-${id}`,
    createdAt: at(hourICT),
    grossSatang: gross,
    netSatang: satang(gross - vat),
    vatSatang: vat,
    tenderedSatang: gross,
    changeSatang: satang(0),
  };
}

function line(
  saleId: string,
  menuItemId: string,
  name: string,
  qty: number,
  grossBaht: string,
  cogsBaht: string | null,
): ReportableSaleLine {
  return {
    saleId,
    menuItemId,
    name,
    qty,
    grossSatang: b(grossBaht),
    cogsSatang: cogsBaht === null ? null : b(cogsBaht),
  };
}

describe("buildZReport — totals", () => {
  it("reports contribution as net revenue less cost of goods", () => {
    const sales = [sale("s1", "90", 10)];
    const lines = [line("s1", "matcha-latte", "Matcha Latte", 1, "90", "20")];

    const report = buildZReport(DAY, sales, lines, []);
    expect(report.totals.gross).toBe(b("90"));
    expect(report.totals.costOfGoods).toBe(b("20"));
    expect(report.totals.contribution).toBe(b("70"));
  });

  it("computes contribution against net, not gross — the VAT was never yours", () => {
    const sales = [sale("s1", "107", 10, { vat: "7" })];
    const lines = [line("s1", "x", "X", 1, "107", "20")];

    const report = buildZReport(DAY, sales, lines, []);
    expect(report.totals.net).toBe(b("100"));
    expect(report.totals.contribution).toBe(b("80")); // 100 net − 20 cost
  });

  it("reports margin in basis points of net revenue", () => {
    const report = buildZReport(DAY, [sale("s1", "100", 10)], [line("s1", "x", "X", 1, "100", "25")], []);
    expect(report.totals.contributionMarginBp).toBe(7_500); // 75%
  });

  it("counts sales and items separately", () => {
    const sales = [sale("s1", "160", 10), sale("s2", "75", 11)];
    const lines = [
      line("s1", "usucha", "Usucha", 2, "160", "10"),
      line("s2", "hojicha", "Hojicha", 1, "75", "8"),
    ];
    const report = buildZReport(DAY, sales, lines, []);
    expect(report.totals.saleCount).toBe(2);
    expect(report.totals.itemCount).toBe(3);
  });

  it("averages the sale value", () => {
    const sales = [sale("s1", "100", 10), sale("s2", "50", 11)];
    const report = buildZReport(DAY, sales, [], []);
    expect(report.totals.averageSale).toBe(b("75"));
  });

  it("has a zero average on a day with no sales rather than dividing by zero", () => {
    const report = buildZReport(DAY, [], [], []);
    expect(report.totals.averageSale).toBe(satang(0));
    expect(report.totals.contributionMarginBp).toBeNull();
  });
});

describe("buildZReport — unknown cost is never zero cost", () => {
  it("flags uncosted lines rather than reporting them as pure margin", () => {
    const sales = [sale("s1", "90", 10)];
    const lines = [line("s1", "mystery", "Mystery", 1, "90", null)];

    const report = buildZReport(DAY, sales, lines, []);
    expect(report.totals.costComplete).toBe(false);
    expect(report.totals.uncostedLines).toBe(1);
    // Margin is withheld entirely — a 100% figure here would be a flattering lie.
    expect(report.totals.contributionMarginBp).toBeNull();
  });

  it("is cost-complete when every line carries a frozen cost", () => {
    const report = buildZReport(DAY, [sale("s1", "90", 10)], [line("s1", "x", "X", 1, "90", "20")], []);
    expect(report.totals.costComplete).toBe(true);
    expect(report.totals.uncostedLines).toBe(0);
    expect(report.totals.contributionMarginBp).not.toBeNull();
  });

  it("treats an ABSENT cogs field the same as an explicit null", () => {
    // A row written before the field existed has no key at all, so a
    // `=== null` check misses it and hands undefined to satang(). This
    // crashed the whole Day screen rather than reporting unknown cost.
    // No cogsSatang key at all — exactly what IndexedDB hands back for a row
    // written before the field existed.
    const legacy: ReportableSaleLine = {
      saleId: "s1",
      menuItemId: "x",
      name: "X",
      qty: 1,
      grossSatang: b("90"),
    };

    expect(() => buildZReport(DAY, [sale("s1", "90", 10)], [legacy], [])).not.toThrow();
    const report = buildZReport(DAY, [sale("s1", "90", 10)], [legacy], []);
    expect(report.totals.uncostedLines).toBe(1);
    expect(report.totals.costComplete).toBe(false);
    expect(report.totals.costOfGoods).toBe(satang(0));
    expect(report.totals.contributionMarginBp).toBeNull();
  });

  it("survives an absent cogs field in the hourly and per-item roll-ups too", () => {
    // No cogsSatang key at all — exactly what IndexedDB hands back for a row
    // written before the field existed.
    const legacy: ReportableSaleLine = {
      saleId: "s1",
      menuItemId: "x",
      name: "X",
      qty: 1,
      grossSatang: b("90"),
    };

    const report = buildZReport(DAY, [sale("s1", "90", 10)], [legacy], []);
    expect(report.byHour).toHaveLength(1);
    expect(report.byItem[0]!.costComplete).toBe(false);
  });

  it("still sums the costs it does know", () => {
    const lines = [
      line("s1", "a", "A", 1, "50", "10"),
      line("s1", "b", "B", 1, "40", null),
    ];
    const report = buildZReport(DAY, [sale("s1", "90", 10)], lines, []);
    expect(report.totals.costOfGoods).toBe(b("10"));
    expect(report.totals.costComplete).toBe(false);
  });
});

describe("buildZReport — voids", () => {
  const sales = [sale("s1", "90", 10), sale("s2", "80", 11)];
  const lines = [
    line("s1", "latte", "Matcha Latte", 1, "90", "20"),
    line("s2", "usucha", "Usucha", 1, "80", "10"),
  ];
  const voids: ReportableVoid[] = [
    { saleId: "s2", receiptNo: "A-9", createdAt: at(12), actor: "owner" },
  ];

  it("excludes a voided sale from takings", () => {
    const report = buildZReport(DAY, sales, lines, voids);
    expect(report.totals.gross).toBe(b("90"));
    expect(report.totals.saleCount).toBe(1);
  });

  it("excludes a voided sale's cost as well as its revenue", () => {
    const report = buildZReport(DAY, sales, lines, voids);
    expect(report.totals.costOfGoods).toBe(b("20"));
  });

  it("still records the void and its value — netting it away would hide the pattern", () => {
    const report = buildZReport(DAY, sales, lines, voids);
    expect(report.totals.voidCount).toBe(1);
    expect(report.totals.voidedValue).toBe(b("80"));
    expect(report.voids).toHaveLength(1);
  });

  it("removes a sale voided on a later day from the day it was rung", () => {
    const lateVoid: ReportableVoid[] = [
      { saleId: "s2", receiptNo: "A-9", createdAt: "2026-08-25T04:00:00.000Z", actor: "owner" },
    ];
    const report = buildZReport(DAY, sales, lines, lateVoid);
    expect(report.totals.gross).toBe(b("90"));
    expect(report.totals.voidCount).toBe(1);
  });

  it("ignores voids belonging to other days' sales", () => {
    const foreign: ReportableVoid[] = [
      { saleId: "not-today", receiptNo: "A-99", createdAt: at(12), actor: "owner" },
    ];
    const report = buildZReport(DAY, sales, lines, foreign);
    expect(report.totals.voidCount).toBe(0);
    expect(report.totals.gross).toBe(b("170"));
  });
});

describe("buildZReport — day boundary", () => {
  it("includes a sale rung at 00:30 ICT, which is the previous date in UTC", () => {
    const lateNight: ReportableSale = { ...sale("s1", "90", 0), createdAt: "2026-08-18T17:30:00.000Z" };
    const report = buildZReport(DAY, [lateNight], [], []);
    expect(report.totals.saleCount).toBe(1);
  });

  it("excludes a sale from the previous local day", () => {
    const yesterday: ReportableSale = { ...sale("s1", "90", 0), createdAt: "2026-08-18T16:59:59.000Z" };
    const report = buildZReport(DAY, [yesterday], [], []);
    expect(report.totals.saleCount).toBe(0);
  });

  it("excludes a sale from the next local day", () => {
    const tomorrow: ReportableSale = { ...sale("s1", "90", 0), createdAt: "2026-08-19T17:00:00.000Z" };
    expect(buildZReport(DAY, [tomorrow], [], []).totals.saleCount).toBe(0);
  });
});

describe("buildZReport — by hour", () => {
  it("buckets on Bangkok-local hours", () => {
    const sales = [sale("s1", "90", 10), sale("s2", "80", 10), sale("s3", "75", 14)];
    const report = buildZReport(DAY, sales, [], []);

    expect(report.byHour.map((h) => h.hour)).toEqual([10, 14]);
    expect(report.byHour[0]!.saleCount).toBe(2);
    expect(report.byHour[0]!.gross).toBe(b("170"));
  });

  it("omits hours with no trade rather than padding 24 empty rows", () => {
    const report = buildZReport(DAY, [sale("s1", "90", 10)], [], []);
    expect(report.byHour).toHaveLength(1);
  });

  it("hour grosses sum to the day gross", () => {
    const sales = [sale("s1", "90", 8), sale("s2", "80", 12), sale("s3", "75", 19)];
    const report = buildZReport(DAY, sales, [], []);
    const total = report.byHour.reduce((acc, h) => acc + h.gross, 0);
    expect(satang(total)).toBe(report.totals.gross);
  });

  it("is ordered by hour", () => {
    const sales = [sale("s1", "10", 19), sale("s2", "10", 7), sale("s3", "10", 13)];
    const hours = buildZReport(DAY, sales, [], []).byHour.map((h) => h.hour);
    expect(hours).toEqual([...hours].sort((a, b) => a - b));
  });
});

describe("buildZReport — by item", () => {
  it("sorts by contribution, not by revenue", () => {
    // Hojicha sells for less but keeps more of it.
    const sales = [sale("s1", "165", 10)];
    const lines = [
      line("s1", "latte", "Matcha Latte", 1, "90", "60"), // contributes 30
      line("s1", "hojicha", "Hojicha", 1, "75", "8"), // contributes 67
    ];
    const report = buildZReport(DAY, sales, lines, []);

    expect(report.byItem[0]!.name).toBe("Hojicha");
    expect(report.byItem[0]!.contribution).toBe(b("67"));
    // Revenue ordering would have put the latte first.
    expect(report.byItem[1]!.gross).toBeGreaterThan(report.byItem[0]!.gross);
  });

  it("rolls up repeat sales of the same item", () => {
    const sales = [sale("s1", "90", 10), sale("s2", "90", 11)];
    const lines = [
      line("s1", "latte", "Matcha Latte", 1, "90", "20"),
      line("s2", "latte", "Matcha Latte", 2, "90", "40"),
    ];
    const report = buildZReport(DAY, sales, lines, []);

    expect(report.byItem).toHaveLength(1);
    expect(report.byItem[0]!.qty).toBe(3);
    expect(report.byItem[0]!.costOfGoods).toBe(b("60"));
  });

  it("marks an item cost-incomplete when any of its lines lack cost", () => {
    const lines = [
      line("s1", "latte", "Matcha Latte", 1, "90", "20"),
      line("s1", "latte", "Matcha Latte", 1, "90", null),
    ];
    const report = buildZReport(DAY, [sale("s1", "180", 10)], lines, []);
    expect(report.byItem[0]!.costComplete).toBe(false);
  });

  it("item grosses sum to the day gross", () => {
    const sales = [sale("s1", "165", 10)];
    const lines = [
      line("s1", "latte", "Matcha Latte", 1, "90", "20"),
      line("s1", "hojicha", "Hojicha", 1, "75", "8"),
    ];
    const report = buildZReport(DAY, sales, lines, []);
    expect(satang(report.byItem.reduce((a, i) => a + i.gross, 0))).toBe(report.totals.gross);
  });
});

describe("buildZReport — expected cash", () => {
  it("is the gross of non-voided sales", () => {
    const sales = [sale("s1", "90", 10), sale("s2", "80", 11)];
    const voids: ReportableVoid[] = [
      { saleId: "s2", receiptNo: "A-9", createdAt: at(12), actor: "owner" },
    ];
    expect(buildZReport(DAY, sales, [], voids).expectedCash).toBe(b("90"));
  });

  it("is zero on a day with no sales", () => {
    expect(buildZReport(DAY, [], [], []).expectedCash).toBe(satang(0));
  });
});
