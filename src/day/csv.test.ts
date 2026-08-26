import { describe, expect, it } from "vitest";
import { fromBahtString, negate, satang, type Satang } from "../money.js";
import {
  csvMoney,
  csvPercent,
  csvField,
  csvRow,
  csvDocument,
  salesCsv,
  saleLinesCsv,
  daySummaryCsv,
  type ExportableSale,
  type ExportableLine,
} from "./csv.js";

const b = (s: string): Satang => fromBahtString(s);

describe("csvMoney", () => {
  it("emits a plain decimal a spreadsheet parses the same way everywhere", () => {
    expect(csvMoney(b("1234.50"))).toBe("1234.50");
  });

  it("has no currency symbol and no thousands separator", () => {
    const out = csvMoney(b("1234567.89"));
    expect(out).toBe("1234567.89");
    expect(out).not.toContain("฿");
    expect(out).not.toContain(",");
  });

  it("always uses two decimal places", () => {
    expect(csvMoney(b("5"))).toBe("5.00");
    expect(csvMoney(b("5.5"))).toBe("5.50");
    expect(csvMoney(satang(0))).toBe("0.00");
  });

  it("keeps the sign on a negative, for a short drawer", () => {
    expect(csvMoney(negate(b("20")))).toBe("-20.00");
  });
});

describe("csvPercent", () => {
  it("renders basis points as a percentage", () => {
    expect(csvPercent(700)).toBe("7.00");
    expect(csvPercent(7_500)).toBe("75.00");
    expect(csvPercent(0)).toBe("0.00");
  });
});

describe("csvField — formula injection", () => {
  it("neutralises a leading = so a menu name cannot execute in Excel", () => {
    expect(csvField("=cmd()")).toBe("'=cmd()");
  });

  it("neutralises the other trigger characters", () => {
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1+2")).toBe("'-1+2");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("guards a formula that also needs quoting", () => {
    expect(csvField("=A1,B2")).toBe("\"'=A1,B2\"");
  });

  it("does NOT guard a legitimate negative number — the variance column must still sum", () => {
    // `-` is a formula trigger, but a naive guard turns a -20.00 cash variance
    // into text and quietly breaks every SUM the accountant writes over it.
    expect(csvField("-20.00")).toBe("-20.00");
    expect(csvField("-2.00")).toBe("-2.00");
    expect(csvField("-1234567.89")).toBe("-1234567.89");
  });

  it("still guards something that merely starts like a negative number", () => {
    expect(csvField("-1+2")).toBe("'-1+2");
    expect(csvField("-1-2")).toBe("'-1-2");
    expect(csvField("-A1")).toBe("'-A1");
  });

  it("round-trips every money value this module can emit", () => {
    for (const value of [b("0"), b("20"), negate(b("20")), negate(b("0.01")), b("1234567.89")]) {
      const rendered = csvField(csvMoney(value));
      expect(rendered.startsWith("'")).toBe(false);
      expect(Number(rendered)).toBeCloseTo(value / 100, 2);
    }
  });

  it("leaves ordinary text alone", () => {
    expect(csvField("Matcha Latte")).toBe("Matcha Latte");
    expect(csvField("A-1043")).toBe("A-1043");
  });

  it("does not mangle Thai text", () => {
    expect(csvField("ชาเขียว")).toBe("ชาเขียว");
  });
});

describe("csvField — RFC 4180 quoting", () => {
  it("quotes a field containing a comma", () => {
    expect(csvField("Latte, iced")).toBe('"Latte, iced"');
  });

  it("doubles embedded quotes", () => {
    expect(csvField('12" cup')).toBe('"12"" cup"');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("leaves a plain field unquoted", () => {
    expect(csvField("plain")).toBe("plain");
  });
});

describe("csvDocument", () => {
  it("uses CRLF line endings", () => {
    expect(csvDocument([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });

  it("terminates the final line", () => {
    expect(csvDocument([["a"]]).endsWith("\r\n")).toBe(true);
  });

  it("round-trips a row through csvRow", () => {
    expect(csvRow(["a", "b,c"])).toBe('a,"b,c"');
  });
});

const sale = (id: string, receiptNo: string, overrides: Partial<ExportableSale> = {}): ExportableSale => ({
  id,
  receiptNo,
  createdAt: "2026-08-19T05:30:00.000Z", // 12:30 ICT
  grossSatang: b("107"),
  netSatang: b("100"),
  vatSatang: b("7"),
  rateBp: 700,
  authority: "Royal Decree No. 799 (B.E. 2568)",
  provisional: false,
  vatRegistered: true,
  tenderedSatang: b("200"),
  changeSatang: b("93"),
  ...overrides,
});

describe("salesCsv", () => {
  it("puts the frozen rate and authority on every row", () => {
    const csv = salesCsv([sale("s1", "A-1")], new Set());
    const [header, row] = csv.trim().split("\r\n");

    expect(header).toContain("vat_rate_percent");
    expect(header).toContain("vat_authority");
    expect(row).toContain("7.00");
    expect(row).toContain("Royal Decree No. 799");
  });

  it("records the Bangkok trading day, not the UTC date", () => {
    // 2026-08-18T17:30Z is 00:30 ICT on the 19th.
    const csv = salesCsv([sale("s1", "A-1", { createdAt: "2026-08-18T17:30:00.000Z" })], new Set());
    const row = csv.trim().split("\r\n")[1]!;
    expect(row).toContain("2026-08-19");
  });

  it("exports voided sales with a status rather than dropping them", () => {
    // Receipt numbers are sequential; omitting a void would look like a gap.
    const csv = salesCsv([sale("s1", "A-1"), sale("s2", "A-2")], new Set(["s2"]));
    const rows = csv.trim().split("\r\n");

    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("SOLD");
    expect(rows[2]).toContain("VOIDED");
  });

  it("flags a provisional rate", () => {
    const csv = salesCsv([sale("s1", "A-1", { provisional: true })], new Set());
    expect(csv.trim().split("\r\n")[1]).toContain("yes");
  });

  it("emits a header even with no sales", () => {
    const csv = salesCsv([], new Set());
    expect(csv.trim().split("\r\n")).toHaveLength(1);
    expect(csv).toContain("receipt_no");
  });
});

const line = (saleId: string, overrides: Partial<ExportableLine> = {}): ExportableLine => ({
  saleId,
  menuItemId: "matcha-latte",
  name: "Matcha Latte",
  qty: 1,
  unitPriceSatang: b("107"),
  grossSatang: b("107"),
  netSatang: b("100"),
  vatSatang: b("7"),
  cogsSatang: b("30"),
  ...overrides,
});

describe("saleLinesCsv", () => {
  it("computes contribution from net less cost", () => {
    const csv = saleLinesCsv([sale("s1", "A-1")], [line("s1")], new Set());
    const row = csv.trim().split("\r\n")[1]!;
    expect(row).toContain("30.00"); // cogs
    expect(row).toContain("70.00"); // contribution: 100 net − 30 cost
  });

  it("leaves cost and contribution EMPTY when cost is unknown — never zero", () => {
    // A zero would sum silently into a wrong total; an empty cell is a question.
    const csv = saleLinesCsv([sale("s1", "A-1")], [line("s1", { cogsSatang: null })], new Set());
    const fields = csv.trim().split("\r\n")[1]!.split(",");

    expect(fields[fields.length - 2]).toBe(""); // cogs
    expect(fields[fields.length - 1]).toBe(""); // contribution
    expect(csv).not.toContain(",0.00,0.00");
  });

  it("treats an ABSENT cogs field as unknown, not as zero cost", () => {
    // No cogsSatang key at all — a row predating the costing field.
    const legacy: ExportableLine = {
      saleId: "s1",
      menuItemId: "matcha-latte",
      name: "Matcha Latte",
      qty: 1,
      unitPriceSatang: b("107"),
      grossSatang: b("107"),
      netSatang: b("100"),
      vatSatang: b("7"),
    };

    const csv = saleLinesCsv([sale("s1", "A-1")], [legacy], new Set());
    const fields = csv.trim().split("\r\n")[1]!.split(",");
    expect(fields[fields.length - 2]).toBe("");
    expect(fields[fields.length - 1]).toBe("");
  });

  it("guards a menu name that is a live formula", () => {
    const csv = saleLinesCsv([sale("s1", "A-1")], [line("s1", { name: "=1+1" })], new Set());
    expect(csv).toContain("'=1+1");
  });

  it("skips a line whose sale is missing rather than emitting an orphan row", () => {
    const csv = saleLinesCsv([sale("s1", "A-1")], [line("nonexistent")], new Set());
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });

  it("marks lines of a voided sale", () => {
    const csv = saleLinesCsv([sale("s1", "A-1")], [line("s1")], new Set(["s1"]));
    expect(csv.trim().split("\r\n")[1]).toContain("VOIDED");
  });
});

describe("daySummaryCsv", () => {
  const base = {
    day: "2026-08-19",
    gross: b("2140"),
    net: b("2000"),
    vat: b("140"),
    costOfGoods: b("600"),
    contribution: b("1400"),
    contributionMarginBp: 7_000,
    costComplete: true,
    uncostedLines: 0,
    saleCount: 20,
    itemCount: 26,
    voidCount: 1,
    voidedValue: b("90"),
    expectedCash: b("2140"),
    declaredCash: b("2120") as Satang | null,
    cashVariance: negate(b("20")) as Satang | null,
  };

  it("lists contribution above gross takings", () => {
    const rows = daySummaryCsv(base).trim().split("\r\n");
    const measures = rows.map((r) => r.split(",")[0]);
    expect(measures.indexOf("contribution_thb")).toBeLessThan(measures.indexOf("gross_takings_thb"));
  });

  it("withholds the margin and says why when cost is incomplete", () => {
    const csv = daySummaryCsv({
      ...base,
      costComplete: false,
      uncostedLines: 3,
      contributionMarginBp: null,
    });
    expect(csv).toContain("withheld - cost of goods incomplete");
    expect(csv).toContain("3 line(s) had no recorded cost");
    expect(csv).toContain("UNDERSTATED");
  });

  it("states the cash variance and its direction", () => {
    const csv = daySummaryCsv(base);
    expect(csv).toContain("-20.00");
    expect(csv).toContain("negative is short");
  });

  it("leaves cash fields empty when the drawer was not counted", () => {
    const csv = daySummaryCsv({ ...base, declaredCash: null, cashVariance: null });
    expect(csv).toContain("drawer not counted");
    const declaredRow = csv.trim().split("\r\n").find((r) => r.startsWith("declared_cash_thb"))!;
    expect(declaredRow.split(",")[1]).toBe("");
  });

  it("says voided value is excluded from takings, so the two are not double counted", () => {
    expect(daySummaryCsv(base)).toContain("excluded from takings above");
  });

  it("names the trading day convention explicitly", () => {
    expect(daySummaryCsv(base)).toContain("+07:00");
  });
});
