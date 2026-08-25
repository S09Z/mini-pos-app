import { describe, expect, it } from "vitest";
import { fromUnitString, ZERO_QTY, type Quantity } from "./units.js";
import type { Requirement } from "./recipe.js";
import { menuItemStock, menuStockByItem } from "./availability.js";

const g = (s: string): Quantity => fromUnitString(s);
const map = (entries: Record<string, string>): Map<string, Quantity> =>
  new Map(Object.entries(entries).map(([k, v]) => [k, fromUnitString(v)]));

/** One latte: 4g matcha, 200ml milk, 1 cup. */
const LATTE: readonly Requirement[] = [
  { ingredientId: "matcha", qty: g("4") },
  { ingredientId: "milk", qty: g("200") },
  { ingredientId: "cup", qty: g("1") },
];

const NO_REORDER = map({ matcha: "0", milk: "0", cup: "0" });

describe("menuItemStock", () => {
  it("is OK with plenty of everything", () => {
    const result = menuItemStock(LATTE, map({ matcha: "100", milk: "4000", cup: "50" }), NO_REORDER);
    expect(result.status).toBe("OK");
    expect(result.limitingIngredientId).toBeNull();
  });

  it("reports how many more drinks the stock covers, bound by the scarcest ingredient", () => {
    // matcha 100g -> 25, milk 1000ml -> 5, cup 50 -> 50.
    const result = menuItemStock(LATTE, map({ matcha: "100", milk: "1000", cup: "50" }), NO_REORDER);
    expect(result.maxProducible).toBe(5);
  });

  it("is OUT when the next one cannot be made, and names the blocking ingredient", () => {
    const result = menuItemStock(LATTE, map({ matcha: "100", milk: "50", cup: "50" }), NO_REORDER);
    expect(result.status).toBe("OUT");
    expect(result.maxProducible).toBe(0);
    expect(result.limitingIngredientId).toBe("milk");
  });

  it("names the truly blocking ingredient, not merely the first in the recipe", () => {
    // Matcha is listed first and is fine; the cups are what ran out.
    const result = menuItemStock(LATTE, map({ matcha: "100", milk: "4000", cup: "0" }), NO_REORDER);
    expect(result.status).toBe("OUT");
    expect(result.limitingIngredientId).toBe("cup");
  });

  it("is OUT when an ingredient is missing from stock entirely", () => {
    const result = menuItemStock(LATTE, map({ matcha: "100", cup: "50" }), NO_REORDER);
    expect(result.status).toBe("OUT");
    expect(result.limitingIngredientId).toBe("milk");
  });

  it("is LOW when an ingredient hits its reorder point, even with drinks still sellable", () => {
    const result = menuItemStock(
      LATTE,
      map({ matcha: "20", milk: "4000", cup: "50" }),
      map({ matcha: "20", milk: "0", cup: "0" }),
    );
    expect(result.status).toBe("LOW");
    expect(result.maxProducible).toBe(5); // still sellable — the warning is early by design
    expect(result.limitingIngredientId).toBe("matcha");
  });

  it("fires on the operator's own reorder point rather than a guess about runway", () => {
    const plenty = map({ matcha: "100", milk: "4000", cup: "50" });
    expect(menuItemStock(LATTE, plenty, NO_REORDER).status).toBe("OK");
    // Same stock, but the operator says 100g of matcha is their reorder point.
    expect(menuItemStock(LATTE, plenty, map({ matcha: "100" })).status).toBe("LOW");
  });

  it("prefers OUT over LOW when both would apply", () => {
    const result = menuItemStock(
      LATTE,
      map({ matcha: "20", milk: "0", cup: "50" }),
      map({ matcha: "20" }),
    );
    expect(result.status).toBe("OUT");
  });

  it("treats an unmodelled item as OK and unlimited — missing reference data never delists a drink", () => {
    const result = menuItemStock([], map({}), map({}));
    expect(result.status).toBe("OK");
    expect(result.maxProducible).toBe(Infinity);
    expect(result.limitingIngredientId).toBeNull();
  });

  it("treats exactly-enough-for-one as sellable, not sold out", () => {
    const result = menuItemStock(LATTE, map({ matcha: "4", milk: "200", cup: "1" }), NO_REORDER);
    expect(result.status).toBe("OK");
    expect(result.maxProducible).toBe(1);
  });

  it("is OUT at exactly zero of a needed ingredient", () => {
    const result = menuItemStock(LATTE, new Map([["matcha", ZERO_QTY]]), NO_REORDER);
    expect(result.status).toBe("OUT");
  });
});

describe("menuStockByItem", () => {
  it("evaluates each menu item against the same stock independently", () => {
    const usucha: readonly Requirement[] = [
      { ingredientId: "matcha", qty: g("2") },
      { ingredientId: "cup", qty: g("1") },
    ];
    const byItem = menuStockByItem(
      new Map([
        ["matcha-latte", LATTE],
        ["usucha", usucha],
      ]),
      map({ matcha: "10", milk: "0", cup: "50" }),
      NO_REORDER,
    );

    // No milk: the latte is out, but the usucha does not use milk and is fine.
    expect(byItem.get("matcha-latte")?.status).toBe("OUT");
    expect(byItem.get("usucha")?.status).toBe("OK");
    expect(byItem.get("usucha")?.maxProducible).toBe(5);
  });

  it("returns an entry for every item it was given", () => {
    const byItem = menuStockByItem(new Map([["x", []]]), map({}), map({}));
    expect([...byItem.keys()]).toEqual(["x"]);
  });
});
