import { describe, expect, it } from "vitest";
import { fromBahtString, type Satang } from "../money.js";
import { WALK_IN, GRAB, type ChannelPrice } from "./types.js";
import { priceFor, validateChannelPrices, priceListFor, PricingError } from "./pricing.js";

const b = (s: string): Satang => fromBahtString(s);

const GRAB_LATTE: ChannelPrice = {
  menuItemId: "matcha-latte",
  channelId: GRAB.id,
  price: b("125"),
  validFrom: "2026-01-01T00:00:00+07:00",
  validTo: null,
};

const PRICES: readonly ChannelPrice[] = [GRAB_LATTE];
const DURING = new Date("2026-08-19T05:00:00Z");

describe("priceFor", () => {
  it("uses the channel price when one is on file", () => {
    const resolved = priceFor(PRICES, "matcha-latte", GRAB.id, b("90"), DURING);
    expect(resolved.price).toBe(b("125"));
    expect(resolved.fellBackToBase).toBe(false);
  });

  it("falls back to the counter price and says so", () => {
    // The flag matters: at 30% GP, selling a ฿90 counter price on delivery is
    // very often a loss, and nothing on the tile would reveal it.
    const resolved = priceFor(PRICES, "usucha", GRAB.id, b("80"), DURING);
    expect(resolved.price).toBe(b("80"));
    expect(resolved.fellBackToBase).toBe(true);
  });

  it("does not leak one channel's price onto another", () => {
    const resolved = priceFor(PRICES, "matcha-latte", WALK_IN.id, b("90"), DURING);
    expect(resolved.price).toBe(b("90"));
    expect(resolved.fellBackToBase).toBe(true);
  });

  it("does not leak one item's price onto another", () => {
    expect(priceFor(PRICES, "hojicha", GRAB.id, b("75"), DURING).price).toBe(b("75"));
  });

  it("ignores a price that has not started yet", () => {
    const future: ChannelPrice[] = [{ ...GRAB_LATTE, validFrom: "2027-01-01T00:00:00+07:00" }];
    expect(priceFor(future, "matcha-latte", GRAB.id, b("90"), DURING).fellBackToBase).toBe(true);
  });

  it("ignores a price that has already ended", () => {
    const expired: ChannelPrice[] = [{ ...GRAB_LATTE, validTo: "2026-06-01T00:00:00+07:00" }];
    expect(priceFor(expired, "matcha-latte", GRAB.id, b("90"), DURING).fellBackToBase).toBe(true);
  });

  it("is half-open — a sale at the changeover instant gets the new price", () => {
    const changeover = "2026-08-19T00:00:00+07:00";
    const table: ChannelPrice[] = [
      { ...GRAB_LATTE, price: b("115"), validTo: changeover },
      { ...GRAB_LATTE, price: b("125"), validFrom: changeover },
    ];
    const justBefore = new Date(Date.parse(changeover) - 1);
    const atInstant = new Date(Date.parse(changeover));

    expect(priceFor(table, "matcha-latte", GRAB.id, b("90"), justBefore).price).toBe(b("115"));
    expect(priceFor(table, "matcha-latte", GRAB.id, b("90"), atInstant).price).toBe(b("125"));
  });

  it("reproduces a historical price for a reprint after a rise", () => {
    const table: ChannelPrice[] = [
      { ...GRAB_LATTE, price: b("115"), validTo: "2026-07-01T00:00:00+07:00" },
      { ...GRAB_LATTE, price: b("125"), validFrom: "2026-07-01T00:00:00+07:00" },
    ];
    const inJune = new Date("2026-06-15T05:00:00Z");
    expect(priceFor(table, "matcha-latte", GRAB.id, b("90"), inJune).price).toBe(b("115"));
  });

  it("throws on an invalid date", () => {
    expect(() => priceFor(PRICES, "matcha-latte", GRAB.id, b("90"), new Date("nope"))).toThrow(
      PricingError,
    );
  });
});

describe("validateChannelPrices", () => {
  it("accepts a clean table", () => {
    expect(() => validateChannelPrices(PRICES)).not.toThrow();
  });

  it("accepts consecutive non-overlapping periods", () => {
    const table: ChannelPrice[] = [
      { ...GRAB_LATTE, price: b("115"), validTo: "2026-07-01T00:00:00+07:00" },
      { ...GRAB_LATTE, price: b("125"), validFrom: "2026-07-01T00:00:00+07:00" },
    ];
    expect(() => validateChannelPrices(table)).not.toThrow();
  });

  it("rejects overlapping periods for the same item and channel", () => {
    const table: ChannelPrice[] = [
      { ...GRAB_LATTE, price: b("115"), validTo: "2026-09-01T00:00:00+07:00" },
      { ...GRAB_LATTE, price: b("125"), validFrom: "2026-07-01T00:00:00+07:00" },
    ];
    expect(() => validateChannelPrices(table)).toThrow(PricingError);
  });

  it("does not confuse different channels or items", () => {
    const table: ChannelPrice[] = [
      GRAB_LATTE,
      { ...GRAB_LATTE, channelId: "LINEMAN" },
      { ...GRAB_LATTE, menuItemId: "usucha" },
    ];
    expect(() => validateChannelPrices(table)).not.toThrow();
  });

  it("rejects a negative price", () => {
    expect(() => validateChannelPrices([{ ...GRAB_LATTE, price: -1 as Satang }])).toThrow(PricingError);
  });

  it("rejects validTo at or before validFrom", () => {
    const table: ChannelPrice[] = [{ ...GRAB_LATTE, validTo: GRAB_LATTE.validFrom }];
    expect(() => validateChannelPrices(table)).toThrow(PricingError);
  });
});

describe("priceListFor", () => {
  const menu = [
    { id: "matcha-latte", priceSatang: b("90") },
    { id: "usucha", priceSatang: b("80") },
  ];

  it("returns a price for every menu item", () => {
    const list = priceListFor(PRICES, menu, GRAB.id, DURING);
    expect([...list.keys()].sort()).toEqual(["matcha-latte", "usucha"]);
  });

  it("mixes channel prices and fallbacks correctly in one list", () => {
    const list = priceListFor(PRICES, menu, GRAB.id, DURING);
    expect(list.get("matcha-latte")?.price).toBe(b("125"));
    expect(list.get("matcha-latte")?.fellBackToBase).toBe(false);
    expect(list.get("usucha")?.price).toBe(b("80"));
    expect(list.get("usucha")?.fellBackToBase).toBe(true);
  });

  it("gives counter prices with no channel rows at all", () => {
    const list = priceListFor([], menu, WALK_IN.id, DURING);
    expect(list.get("matcha-latte")?.price).toBe(b("90"));
    expect([...list.values()].every((p) => p.fellBackToBase)).toBe(true);
  });
});
