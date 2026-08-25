import { describe, expect, it } from "vitest";
import type { RecipeLine } from "../channel/types.js";
import { WALK_IN, GRAB } from "../channel/types.js";
import { fromUnitString, ZERO_QTY, type Quantity } from "./units.js";
import {
  resolveRecipe,
  requirementsForCart,
  maxProducible,
  shortfalls,
  RecipeError,
} from "./recipe.js";

const g = (s: string): number => fromUnitString(s);

/** One latte: 4g matcha, 200ml milk, 1 cup. Delivery swaps the cup and adds a lid. */
const LINES: readonly RecipeLine[] = [
  { menuItemId: "matcha-latte", ingredientId: "matcha", qty: g("4"), channelId: null },
  { menuItemId: "matcha-latte", ingredientId: "milk", qty: g("200"), channelId: null },
  { menuItemId: "matcha-latte", ingredientId: "cup", qty: g("1"), channelId: null },
  // Delivery: same cup ingredient, but two of them (double-walled for transit).
  { menuItemId: "matcha-latte", ingredientId: "cup", qty: g("2"), channelId: GRAB.id },
  // Delivery only: a sealed lid, which has no base line at all.
  { menuItemId: "matcha-latte", ingredientId: "lid", qty: g("1"), channelId: GRAB.id },
  { menuItemId: "usucha", ingredientId: "matcha", qty: g("2"), channelId: null },
  { menuItemId: "usucha", ingredientId: "cup", qty: g("1"), channelId: null },
];

const onHandMap = (entries: Record<string, string>): Map<string, Quantity> =>
  new Map(Object.entries(entries).map(([k, v]) => [k, fromUnitString(v)]));

describe("resolveRecipe", () => {
  it("returns the base recipe on a channel with no overrides", () => {
    const resolved = resolveRecipe(LINES, "matcha-latte", WALK_IN.id);
    expect(resolved).toEqual([
      { ingredientId: "cup", qty: g("1") },
      { ingredientId: "matcha", qty: g("4") },
      { ingredientId: "milk", qty: g("200") },
    ]);
  });

  it("a channel line REPLACES the base line for the same ingredient", () => {
    const resolved = resolveRecipe(LINES, "matcha-latte", GRAB.id);
    const cup = resolved.find((r) => r.ingredientId === "cup");
    expect(cup?.qty).toBe(g("2")); // not 1, and not 3 — replaced, not added to
  });

  it("a channel line ADDS an ingredient that has no base line", () => {
    const resolved = resolveRecipe(LINES, "matcha-latte", GRAB.id);
    expect(resolved.find((r) => r.ingredientId === "lid")?.qty).toBe(g("1"));
  });

  it("leaves untouched base ingredients alone on an overridden channel", () => {
    const resolved = resolveRecipe(LINES, "matcha-latte", GRAB.id);
    expect(resolved.find((r) => r.ingredientId === "matcha")?.qty).toBe(g("4"));
    expect(resolved.find((r) => r.ingredientId === "milk")?.qty).toBe(g("200"));
  });

  it("does not leak one channel's override onto another channel", () => {
    const walkIn = resolveRecipe(LINES, "matcha-latte", WALK_IN.id);
    expect(walkIn.some((r) => r.ingredientId === "lid")).toBe(false);
    expect(walkIn.find((r) => r.ingredientId === "cup")?.qty).toBe(g("1"));
  });

  it("does not leak one menu item's recipe onto another", () => {
    const usucha = resolveRecipe(LINES, "usucha", WALK_IN.id);
    expect(usucha.some((r) => r.ingredientId === "milk")).toBe(false);
    expect(usucha.find((r) => r.ingredientId === "matcha")?.qty).toBe(g("2"));
  });

  it("returns an empty recipe for an unmodelled item", () => {
    expect(resolveRecipe(LINES, "not-a-drink", WALK_IN.id)).toEqual([]);
  });

  it("rejects a float quantity smuggled in via a hand-edited row", () => {
    const bad: RecipeLine[] = [
      { menuItemId: "x", ingredientId: "matcha", qty: 4.5, channelId: null },
    ];
    expect(() => resolveRecipe(bad, "x", WALK_IN.id)).toThrow();
  });

  it("is deterministic — the same inputs give the same ordering", () => {
    expect(resolveRecipe(LINES, "matcha-latte", GRAB.id)).toEqual(
      resolveRecipe(LINES, "matcha-latte", GRAB.id),
    );
  });
});

describe("requirementsForCart", () => {
  it("aggregates the same ingredient across different drinks", () => {
    // 2 lattes (4g each) + 1 usucha (2g) = 10g of matcha from one tin.
    const reqs = requirementsForCart(
      LINES,
      [
        { menuItemId: "matcha-latte", qty: 2 },
        { menuItemId: "usucha", qty: 1 },
      ],
      WALK_IN.id,
    );
    expect(reqs.find((r) => r.ingredientId === "matcha")?.qty).toBe(g("10"));
    expect(reqs.find((r) => r.ingredientId === "cup")?.qty).toBe(g("3"));
    // Only the lattes take milk: 2 × 200ml. The usucha contributes none.
    expect(reqs.find((r) => r.ingredientId === "milk")?.qty).toBe(g("400"));
  });

  it("scales by line quantity", () => {
    const one = requirementsForCart(LINES, [{ menuItemId: "matcha-latte", qty: 1 }], WALK_IN.id);
    const three = requirementsForCart(LINES, [{ menuItemId: "matcha-latte", qty: 3 }], WALK_IN.id);
    for (const req of one) {
      const scaled = three.find((r) => r.ingredientId === req.ingredientId);
      expect(scaled?.qty).toBe(req.qty * 3);
    }
  });

  it("applies channel overrides through the cart path too", () => {
    const reqs = requirementsForCart(LINES, [{ menuItemId: "matcha-latte", qty: 2 }], GRAB.id);
    expect(reqs.find((r) => r.ingredientId === "cup")?.qty).toBe(g("4")); // 2 per drink
    expect(reqs.find((r) => r.ingredientId === "lid")?.qty).toBe(g("2"));
  });

  it("an empty cart requires nothing", () => {
    expect(requirementsForCart(LINES, [], WALK_IN.id)).toEqual([]);
  });

  it("rejects a fractional or negative cart quantity", () => {
    expect(() => requirementsForCart(LINES, [{ menuItemId: "usucha", qty: 1.5 }], WALK_IN.id)).toThrow(
      RecipeError,
    );
    expect(() => requirementsForCart(LINES, [{ menuItemId: "usucha", qty: -1 }], WALK_IN.id)).toThrow(
      RecipeError,
    );
  });
});

describe("maxProducible", () => {
  const latte = () => resolveRecipe(LINES, "matcha-latte", WALK_IN.id);

  it("is limited by whichever ingredient runs out first", () => {
    // 100g matcha => 25 drinks, 1000ml milk => 5 drinks, 50 cups => 50 drinks.
    const onHand = onHandMap({ matcha: "100", milk: "1000", cup: "50" });
    expect(maxProducible(latte(), onHand)).toBe(5); // milk binds
  });

  it("is zero when an ingredient is missing entirely", () => {
    const onHand = onHandMap({ matcha: "100", cup: "50" }); // no milk at all
    expect(maxProducible(latte(), onHand)).toBe(0);
  });

  it("is zero when an ingredient is present but insufficient for even one", () => {
    const onHand = onHandMap({ matcha: "100", milk: "199", cup: "50" });
    expect(maxProducible(latte(), onHand)).toBe(0);
  });

  it("floors rather than rounding — 2.9 drinks' worth is 2 drinks", () => {
    const onHand = onHandMap({ matcha: "100", milk: "580", cup: "50" });
    expect(maxProducible(latte(), onHand)).toBe(2);
  });

  it("an unmodelled item is unknown, not sold out — never block a sale on missing reference data", () => {
    expect(maxProducible([], onHandMap({}))).toBe(Infinity);
  });
});

describe("shortfalls", () => {
  it("names only the ingredients that would go negative, and by how much", () => {
    const reqs = resolveRecipe(LINES, "matcha-latte", WALK_IN.id);
    const onHand = onHandMap({ matcha: "100", milk: "150", cup: "0" });
    const short = shortfalls(reqs, onHand);

    expect(short.map((s) => s.ingredientId).sort()).toEqual(["cup", "milk"]);
    expect(short.find((s) => s.ingredientId === "milk")?.qty).toBe(g("50"));
    expect(short.find((s) => s.ingredientId === "cup")?.qty).toBe(g("1"));
  });

  it("is empty when everything is covered", () => {
    const reqs = resolveRecipe(LINES, "matcha-latte", WALK_IN.id);
    expect(shortfalls(reqs, onHandMap({ matcha: "100", milk: "1000", cup: "50" }))).toEqual([]);
  });

  it("treats an exactly-sufficient amount as covered", () => {
    const reqs = resolveRecipe(LINES, "usucha", WALK_IN.id);
    expect(shortfalls(reqs, onHandMap({ matcha: "2", cup: "1" }))).toEqual([]);
  });

  it("counts a completely absent ingredient as fully short", () => {
    const reqs = resolveRecipe(LINES, "usucha", WALK_IN.id);
    const short = shortfalls(reqs, new Map([["matcha", ZERO_QTY]]));
    expect(short.find((s) => s.ingredientId === "cup")?.qty).toBe(g("1"));
  });
});
