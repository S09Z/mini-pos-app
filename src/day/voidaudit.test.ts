import { describe, expect, it } from "vitest";
import { fromBahtString, satang, type Satang } from "../money.js";
import {
  auditVoids,
  DEFAULT_THRESHOLDS,
  type AuditableVoid,
} from "./voidaudit.js";

const b = (s: string): Satang => fromBahtString(s);
const BASE = Date.parse("2026-08-19T05:00:00.000Z");

const v = (
  id: string,
  minutesIn: number,
  valueBaht: string,
  actor = "owner",
): AuditableVoid => ({
  saleId: id,
  receiptNo: `A-${id}`,
  createdAt: new Date(BASE + minutesIn * 60_000).toISOString(),
  actor,
  valueSatang: b(valueBaht),
});

describe("auditVoids — totals and grouping", () => {
  it("totals count and value", () => {
    const audit = auditVoids([v("1", 0, "90"), v("2", 60, "80")], 20, b("2000"));
    expect(audit.totalCount).toBe(2);
    expect(audit.totalValue).toBe(b("170"));
  });

  it("groups by actor", () => {
    const voids = [v("1", 0, "90", "owner"), v("2", 5, "80", "staff-a"), v("3", 10, "20", "staff-a")];
    const audit = auditVoids(voids, 50, b("5000"));

    expect(audit.byActor).toHaveLength(2);
    expect(audit.byActor[0]!.actor).toBe("staff-a"); // most voids first
    expect(audit.byActor[0]!.count).toBe(2);
    expect(audit.byActor[0]!.value).toBe(b("100"));
  });

  it("produces a single group today, since only the owner PIN exists", () => {
    const audit = auditVoids([v("1", 0, "90"), v("2", 60, "80")], 40, b("4000"));
    expect(audit.byActor).toHaveLength(1);
    expect(audit.byActor[0]!.actor).toBe("owner");
  });

  it("computes the void rate against sales rung", () => {
    const audit = auditVoids([v("1", 0, "90")], 20, b("2000"));
    expect(audit.rateBp).toBe(500); // 1 in 20 = 5%
  });

  it("has a zero rate on a day with no sales rather than dividing by zero", () => {
    expect(auditVoids([], 0, satang(0)).rateBp).toBe(0);
  });

  it("raises no flags on a clean day", () => {
    expect(auditVoids([], 50, b("5000")).flags).toEqual([]);
  });
});

describe("auditVoids — HIGH_RATE", () => {
  it("flags when voids exceed the rate threshold", () => {
    // 3 of 20 sales = 15%, over the 10% default.
    const voids = [v("1", 0, "20"), v("2", 120, "20"), v("3", 240, "20")];
    const audit = auditVoids(voids, 20, b("2000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_RATE")).toBe(true);
  });

  it("does not flag a normal rate", () => {
    const audit = auditVoids([v("1", 0, "20")], 50, b("5000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_RATE")).toBe(false);
  });

  it("fires exactly at the threshold", () => {
    // 1 of 10 = 10%, equal to the default.
    const audit = auditVoids([v("1", 0, "20")], 10, b("2000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_RATE")).toBe(true);
  });

  it("states the numbers in the detail, for a human reading at closing time", () => {
    const voids = [v("1", 0, "20"), v("2", 120, "20"), v("3", 240, "20")];
    const flag = auditVoids(voids, 20, b("2000")).flags.find((f) => f.kind === "HIGH_RATE");
    expect(flag?.detail).toContain("3 of 20");
  });
});

describe("auditVoids — BURST", () => {
  it("flags three voids by one actor inside ten minutes", () => {
    const voids = [v("1", 0, "20"), v("2", 3, "20"), v("3", 7, "20")];
    const audit = auditVoids(voids, 200, b("20000"));
    const burst = audit.flags.find((f) => f.kind === "BURST");
    expect(burst).toBeDefined();
    expect(burst?.actor).toBe("owner");
  });

  it("does not flag the same three spread across the day", () => {
    const voids = [v("1", 0, "20"), v("2", 120, "20"), v("3", 300, "20")];
    const audit = auditVoids(voids, 200, b("20000"));
    expect(audit.flags.some((f) => f.kind === "BURST")).toBe(false);
  });

  it("does not flag three different people voicing once each in the same window — that is a rush", () => {
    const voids = [
      v("1", 0, "20", "owner"),
      v("2", 2, "20", "staff-a"),
      v("3", 4, "20", "staff-b"),
    ];
    const audit = auditVoids(voids, 200, b("20000"));
    expect(audit.flags.some((f) => f.kind === "BURST")).toBe(false);
  });

  it("flags each bursting actor once, not once per void", () => {
    const voids = [v("1", 0, "20"), v("2", 1, "20"), v("3", 2, "20"), v("4", 3, "20"), v("5", 4, "20")];
    const audit = auditVoids(voids, 500, b("50000"));
    expect(audit.flags.filter((f) => f.kind === "BURST")).toHaveLength(1);
  });

  it("respects a custom window", () => {
    const voids = [v("1", 0, "20"), v("2", 20, "20"), v("3", 40, "20")];
    const tight = auditVoids(voids, 200, b("20000"), DEFAULT_THRESHOLDS);
    const loose = auditVoids(voids, 200, b("20000"), { ...DEFAULT_THRESHOLDS, burstWindowMinutes: 60 });

    expect(tight.flags.some((f) => f.kind === "BURST")).toBe(false);
    expect(loose.flags.some((f) => f.kind === "BURST")).toBe(true);
  });

  it("ignores unparseable timestamps rather than throwing mid-report", () => {
    const voids: AuditableVoid[] = [
      { saleId: "x", receiptNo: "A-1", createdAt: "nonsense", actor: "owner", valueSatang: b("20") },
    ];
    expect(() => auditVoids(voids, 10, b("1000"))).not.toThrow();
  });
});

describe("auditVoids — HIGH_VALUE_SHARE", () => {
  it("flags when a large share of the day's value was voided", () => {
    // ฿500 voided against ฿1000 kept = 33% of everything rung.
    const audit = auditVoids([v("1", 0, "500")], 20, b("1000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_VALUE_SHARE")).toBe(true);
  });

  it("does not flag a small share", () => {
    const audit = auditVoids([v("1", 0, "20")], 50, b("5000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_VALUE_SHARE")).toBe(false);
  });

  it("catches one big void hidden inside an otherwise normal void count", () => {
    // Only 1 void in 50 sales — the rate is fine, but it was a huge one.
    const audit = auditVoids([v("1", 0, "3000")], 50, b("5000"));
    expect(audit.flags.some((f) => f.kind === "HIGH_RATE")).toBe(false);
    expect(audit.flags.some((f) => f.kind === "HIGH_VALUE_SHARE")).toBe(true);
  });

  it("does not divide by zero when nothing was taken at all", () => {
    expect(() => auditVoids([], 0, satang(0))).not.toThrow();
    expect(auditVoids([], 0, satang(0)).flags).toEqual([]);
  });
});

describe("auditVoids — flags are prompts, not verdicts", () => {
  it("can raise several flags for one day", () => {
    const voids = [v("1", 0, "500"), v("2", 2, "500"), v("3", 5, "500")];
    const audit = auditVoids(voids, 10, b("1000"));
    const kinds = audit.flags.map((f) => f.kind).sort();
    expect(kinds).toEqual(["BURST", "HIGH_RATE", "HIGH_VALUE_SHARE"]);
  });

  it("every flag carries a human-readable detail", () => {
    const voids = [v("1", 0, "500"), v("2", 2, "500"), v("3", 5, "500")];
    for (const flag of auditVoids(voids, 10, b("1000")).flags) {
      expect(flag.detail.length).toBeGreaterThan(0);
    }
  });
});
