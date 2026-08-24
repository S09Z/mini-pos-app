import { describe, expect, it } from "vitest";
import { fromBaht, satang } from "../money.js";
import {
  HEAD_OFFICE_BRANCH,
  REGISTRATION_DEADLINE_DAYS,
  RegistrationError,
  formatBranch,
  isValidThaiTaxId,
  registrationAt,
  trailingRevenue,
  validateRegistrationLedger,
  vatWatchdog,
  type RegistrationEvent,
  type RevenuePoint,
} from "./registration.js";
import { VAT_REGISTRATION_THRESHOLD } from "./vat.js";

/** A real, checksum-valid 13-digit Thai tax ID shape. Not a live number. */
const TAX_ID = "0105536000020";

const registered = (effectiveFrom: string, over: Partial<RegistrationEvent> = {}): RegistrationEvent => ({
  id: `reg-${effectiveFrom}`,
  kind: "REGISTERED",
  effectiveFrom,
  taxId: TAX_ID,
  branchCode: HEAD_OFFICE_BRANCH,
  posMachineNumber: "POS-01-2569",
  note: "",
  ...over,
});

describe("isValidThaiTaxId", () => {
  it("accepts a well-formed id and rejects a mangled check digit", () => {
    expect(isValidThaiTaxId(TAX_ID)).toBe(true);

    // Every single-digit corruption of the check digit must fail — that is the
    // entire point of the checksum, and a typo'd tax ID on an invoice is the
    // customer's problem to discover months later.
    const head = TAX_ID.slice(0, 12);
    const good = Number(TAX_ID[12]);
    for (let d = 0; d <= 9; d++) {
      if (d === good) continue;
      expect(isValidThaiTaxId(`${head}${d}`)).toBe(false);
    }
  });

  it("rejects anything that is not exactly 13 digits", () => {
    expect(isValidThaiTaxId("")).toBe(false);
    expect(isValidThaiTaxId("010553600002")).toBe(false); // 12
    expect(isValidThaiTaxId(`${TAX_ID}0`)).toBe(false); // 14
    expect(isValidThaiTaxId("01055-6000021")).toBe(false);
    expect(isValidThaiTaxId("010553600002X")).toBe(false);
  });
});

describe("formatBranch", () => {
  it("names the head office verbatim in Thai and numbers a branch", () => {
    expect(formatBranch(HEAD_OFFICE_BRANCH)).toBe("สำนักงานใหญ่");
    expect(formatBranch("00001")).toBe("สาขาที่ 00001");
  });

  it("rejects a branch code that is not five digits", () => {
    expect(() => formatBranch("1")).toThrow(RegistrationError);
  });
});

describe("registrationAt", () => {
  it("is unregistered before any event", () => {
    const events = [registered("2026-10-01T00:00:00+07:00")];
    expect(registrationAt(events, new Date("2026-09-30T23:59:59+07:00")).registered).toBe(false);
  });

  it("treats the effective instant as inclusive, like a decree boundary", () => {
    const events = [registered("2026-10-01T00:00:00+07:00")];
    expect(registrationAt(events, new Date("2026-10-01T00:00:00+07:00")).registered).toBe(true);
  });

  it("uses Bangkok-local instants: 00:30 ICT on the effective day is registered", () => {
    const events = [registered("2026-10-01T00:00:00+07:00")];
    // 17:30Z on 30 September is 00:30 ICT on 1 October — the same trap rates.ts
    // documents. A naive UTC-date comparison would call this unregistered.
    expect(registrationAt(events, new Date("2026-09-30T17:30:00Z")).registered).toBe(true);
  });

  it("carries the tax ID, branch and machine number of the event in force", () => {
    const events = [
      registered("2026-10-01T00:00:00+07:00", { posMachineNumber: "POS-01" }),
      registered("2027-01-01T00:00:00+07:00", { id: "reg-2", posMachineNumber: "POS-02" }),
    ];
    expect(registrationAt(events, new Date("2026-12-31T00:00:00+07:00")).posMachineNumber).toBe("POS-01");
    expect(registrationAt(events, new Date("2027-06-01T00:00:00+07:00")).posMachineNumber).toBe("POS-02");
  });

  it("a deregistration ends the period and clears the identity", () => {
    const events: RegistrationEvent[] = [
      registered("2026-10-01T00:00:00+07:00"),
      {
        id: "dereg",
        kind: "DEREGISTERED",
        effectiveFrom: "2027-04-01T00:00:00+07:00",
        taxId: TAX_ID,
        branchCode: HEAD_OFFICE_BRANCH,
        posMachineNumber: "",
        note: "closed",
      },
    ];
    const after = registrationAt(events, new Date("2027-05-01T00:00:00+07:00"));
    expect(after.registered).toBe(false);
    expect(after.taxId).toBe(null);
  });

  it("does not care what order the ledger arrives in", () => {
    const a = registered("2026-10-01T00:00:00+07:00");
    const b = registered("2027-01-01T00:00:00+07:00", { id: "reg-2", posMachineNumber: "POS-02" });
    const at = new Date("2027-06-01T00:00:00+07:00");
    expect(registrationAt([b, a], at)).toEqual(registrationAt([a, b], at));
  });
});

describe("validateRegistrationLedger", () => {
  it("rejects a registration event with an invalid tax ID", () => {
    expect(() => validateRegistrationLedger([registered("2026-10-01T00:00:00+07:00", { taxId: "1234567890123" })])).toThrow(
      RegistrationError,
    );
  });

  it("rejects two events at the same instant — the state would be ambiguous", () => {
    expect(() =>
      validateRegistrationLedger([
        registered("2026-10-01T00:00:00+07:00"),
        registered("2026-10-01T00:00:00+07:00", { id: "other" }),
      ]),
    ).toThrow(RegistrationError);
  });

  it("rejects a registration with no POS machine number — an abbreviated invoice needs one", () => {
    expect(() =>
      validateRegistrationLedger([registered("2026-10-01T00:00:00+07:00", { posMachineNumber: "" })]),
    ).toThrow(RegistrationError);
  });
});

describe("trailingRevenue", () => {
  const points = (...isoAmounts: readonly (readonly [string, number])[]): RevenuePoint[] =>
    isoAmounts.map(([at, baht], i) => ({ id: `s${i}`, at, gross: fromBaht(baht) }));

  it("counts the trailing twelve months and drops what falls out of the window", () => {
    const p = points(
      ["2025-08-01T10:00:00+07:00", 100], // 12 months and 22 days before — out
      ["2025-09-01T10:00:00+07:00", 200], // inside
      ["2026-08-01T10:00:00+07:00", 300], // inside
    );
    expect(trailingRevenue(p, new Date("2026-08-23T23:59:59+07:00"))).toBe(fromBaht(500));
  });

  it("the window edge is inclusive at the start and at `asOf`", () => {
    const asOf = new Date("2026-08-23T00:00:00+07:00");
    const edge = points(["2025-08-23T00:00:00+07:00", 50], ["2026-08-23T00:00:00+07:00", 50]);
    expect(trailingRevenue(edge, asOf)).toBe(fromBaht(100));
  });

  it("ignores a future-dated point rather than counting revenue not yet earned", () => {
    const p = points(["2026-12-01T10:00:00+07:00", 999]);
    expect(trailingRevenue(p, new Date("2026-08-23T00:00:00+07:00"))).toBe(satang(0));
  });
});

describe("vatWatchdog", () => {
  /** One takings figure on the 1st of each month, 2025-09 through 2026-08. */
  const monthly = (baht: number, months: number): RevenuePoint[] =>
    Array.from({ length: months }, (_, i) => {
      const monthIndex = 8 + i; // 8 === September 2025
      const year = 2025 + Math.floor(monthIndex / 12);
      const month = String((monthIndex % 12) + 1).padStart(2, "0");
      return { id: `m${i}`, at: `${year}-${month}-01T10:00:00+07:00`, gross: fromBaht(baht) };
    });

  it("is quiet well below the threshold", () => {
    const w = vatWatchdog(monthly(50_000, 12), new Date("2026-08-23T00:00:00+07:00"));
    expect(w.required).toBe(false);
    expect(w.approaching).toBe(false);
    expect(w.headroom).toBeGreaterThan(satang(0));
  });

  it("warns before the line, not after it", () => {
    // 12 × ฿130,000 = ฿1.56M — under 1.8M, over the 83% warning mark.
    const w = vatWatchdog(monthly(130_000, 12), new Date("2026-08-23T00:00:00+07:00"));
    expect(w.required).toBe(false);
    expect(w.approaching).toBe(true);
    expect(w.usedBp).toBeGreaterThanOrEqual(8_300);
  });

  it("names the instant the threshold was crossed and the 30-day deadline that follows", () => {
    const w = vatWatchdog(monthly(200_000, 12), new Date("2026-08-23T00:00:00+07:00"));
    expect(w.required).toBe(true);
    expect(w.crossedAt).not.toBe(null);

    // 1,800,000 / 200,000 = 9 months of takings, so the 10th point crosses it.
    expect(w.crossedAt).toBe("2026-06-01T10:00:00+07:00");
    const deadline = Date.parse(w.registerBy!);
    expect(deadline - Date.parse(w.crossedAt!)).toBe(REGISTRATION_DEADLINE_DAYS * 86_400_000);
  });

  it("headroom never goes negative — over the line it is zero, and `required` carries the news", () => {
    const w = vatWatchdog(monthly(200_000, 12), new Date("2026-08-23T00:00:00+07:00"));
    expect(w.headroom).toBe(satang(0));
    expect(w.trailing12m).toBeGreaterThan(VAT_REGISTRATION_THRESHOLD);
  });

  it("an empty history is quiet, not an error — a first-day install has no revenue", () => {
    const w = vatWatchdog([], new Date("2026-08-23T00:00:00+07:00"));
    expect(w.trailing12m).toBe(satang(0));
    expect(w.required).toBe(false);
    expect(w.crossedAt).toBe(null);
    expect(w.registerBy).toBe(null);
  });
});
