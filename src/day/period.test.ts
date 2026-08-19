import { describe, expect, it } from "vitest";
import {
  bangkokDayOf,
  bangkokHourOf,
  bangkokDayBounds,
  isInDay,
  bangkokToday,
  ICT_OFFSET_MINUTES,
  PeriodError,
} from "./period.js";

describe("bangkokDayOf", () => {
  it("a sale at 00:30 ICT belongs to the local day, not the previous UTC day", () => {
    // 2026-08-19T00:30+07:00 is 2026-08-18T17:30Z. Grouping on the UTC date
    // would file this under the 18th and break the drawer count.
    expect(bangkokDayOf("2026-08-18T17:30:00.000Z")).toBe("2026-08-19");
  });

  it("an instant just before local midnight stays on the earlier day", () => {
    // 2026-08-18T23:59:59+07:00 === 2026-08-18T16:59:59Z
    expect(bangkokDayOf("2026-08-18T16:59:59.000Z")).toBe("2026-08-18");
  });

  it("flips exactly at local midnight", () => {
    expect(bangkokDayOf("2026-08-18T16:59:59.999Z")).toBe("2026-08-18");
    expect(bangkokDayOf("2026-08-18T17:00:00.000Z")).toBe("2026-08-19");
  });

  it("handles a month boundary", () => {
    // 2026-09-01T00:30+07:00 === 2026-08-31T17:30Z
    expect(bangkokDayOf("2026-08-31T17:30:00.000Z")).toBe("2026-09-01");
  });

  it("handles a year boundary", () => {
    expect(bangkokDayOf("2026-12-31T17:30:00.000Z")).toBe("2027-01-01");
  });

  it("throws on an unparseable instant", () => {
    expect(() => bangkokDayOf("not-a-date")).toThrow(PeriodError);
  });
});

describe("bangkokHourOf", () => {
  it("reports the local hour, not the UTC hour", () => {
    expect(bangkokHourOf("2026-08-18T17:30:00.000Z")).toBe(0); // 00:30 ICT
    expect(bangkokHourOf("2026-08-18T03:00:00.000Z")).toBe(10); // 10:00 ICT
  });

  it("covers the full 0–23 range across a local day", () => {
    const bounds = bangkokDayBounds("2026-08-19");
    const start = Date.parse(bounds.startISO);
    const seen = new Set<number>();
    for (let h = 0; h < 24; h++) {
      seen.add(bangkokHourOf(new Date(start + h * 3_600_000).toISOString()));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(24).keys()]);
  });
});

describe("bangkokDayBounds", () => {
  it("spans local midnight to local midnight, expressed as UTC instants", () => {
    const bounds = bangkokDayBounds("2026-08-19");
    expect(bounds.startISO).toBe("2026-08-18T17:00:00.000Z");
    expect(bounds.endISO).toBe("2026-08-19T17:00:00.000Z");
  });

  it("is exactly 24 hours long", () => {
    const bounds = bangkokDayBounds("2026-08-19");
    expect(Date.parse(bounds.endISO) - Date.parse(bounds.startISO)).toBe(24 * 3_600_000);
  });

  it("consecutive days abut without gap or overlap", () => {
    expect(bangkokDayBounds("2026-08-19").endISO).toBe(bangkokDayBounds("2026-08-20").startISO);
  });

  it("rejects a malformed day string", () => {
    expect(() => bangkokDayBounds("19-08-2026")).toThrow(PeriodError);
    expect(() => bangkokDayBounds("2026-8-9")).toThrow(PeriodError);
    expect(() => bangkokDayBounds("")).toThrow(PeriodError);
  });
});

describe("isInDay", () => {
  const bounds = bangkokDayBounds("2026-08-19");

  it("is half-open — local midnight belongs to the new day", () => {
    expect(isInDay(bounds.startISO, bounds)).toBe(true);
    expect(isInDay(bounds.endISO, bounds)).toBe(false);
  });

  it("excludes the instant just before the day starts", () => {
    expect(isInDay("2026-08-18T16:59:59.999Z", bounds)).toBe(false);
  });

  it("includes a late-night sale that is the previous date in UTC", () => {
    expect(isInDay("2026-08-18T17:30:00.000Z", bounds)).toBe(true);
  });

  it("every instant falls in exactly one day", () => {
    const instants = [
      "2026-08-18T16:00:00.000Z",
      "2026-08-18T17:00:00.000Z",
      "2026-08-19T06:00:00.000Z",
      "2026-08-19T17:00:00.000Z",
    ];
    for (const instant of instants) {
      const day = bangkokDayOf(instant);
      expect(isInDay(instant, bangkokDayBounds(day))).toBe(true);
    }
  });
});

describe("bangkokToday", () => {
  it("agrees with bangkokDayOf for the same instant", () => {
    const now = new Date("2026-08-18T17:30:00.000Z");
    expect(bangkokToday(now)).toBe(bangkokDayOf(now.toISOString()));
    expect(bangkokToday(now)).toBe("2026-08-19");
  });
});

describe("ICT_OFFSET_MINUTES", () => {
  it("is +07:00", () => {
    expect(ICT_OFFSET_MINUTES).toBe(420);
  });
});
