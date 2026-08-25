import { describe, expect, it } from "vitest";
import { fromUnitString, negateQty, quantity, ZERO_QTY, type Quantity } from "./units.js";
import type { Requirement } from "./recipe.js";
import {
  onHandFrom,
  onHandByIngredient,
  depletionDrafts,
  restockDrafts,
  wasteDraft,
  purchaseDraft,
  countAdjustmentDraft,
  stockStatus,
  movementsByKind,
  assertWellSigned,
  LedgerError,
  type StockMovement,
  type MovementDraft,
} from "./ledger.js";

const AT = "2026-08-18T09:00:00.000Z";
const g = (s: string): Quantity => fromUnitString(s);

/** Stamp ids onto drafts the way the storage layer does. */
const stamp = (drafts: readonly MovementDraft[], prefix = "m"): StockMovement[] =>
  drafts.map((d, i) => ({ ...d, id: `${prefix}-${i}` }));

describe("assertWellSigned", () => {
  it("rejects a purchase that would remove stock", () => {
    expect(() => assertWellSigned("PURCHASE", negateQty(g("1")))).toThrow(LedgerError);
  });

  it("rejects a waste event that would add stock", () => {
    expect(() => assertWellSigned("WASTE", g("1"))).toThrow(LedgerError);
  });

  it("allows a count adjustment in either direction", () => {
    expect(() => assertWellSigned("COUNT_ADJUSTMENT", g("1"))).not.toThrow();
    expect(() => assertWellSigned("COUNT_ADJUSTMENT", negateQty(g("1")))).not.toThrow();
  });
});

describe("onHandFrom", () => {
  it("is the sum of every movement, and nothing else", () => {
    const movements = stamp([
      purchaseDraft("matcha", g("100"), AT),
      wasteDraft("matcha", g("8"), "SPILLED", AT),
      ...depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "sale-1", AT),
    ]);
    expect(onHandFrom(movements)).toBe(g("88"));
  });

  it("an empty ledger is zero on hand", () => {
    expect(onHandFrom([])).toBe(ZERO_QTY);
  });

  it("can go negative — an unrecorded purchase is a discrepancy to surface, not to clamp", () => {
    const movements = stamp(depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "s", AT));
    expect(onHandFrom(movements)).toBe(negateQty(g("4")));
  });

  it("500 depletions of a fractional recipe reconcile exactly", () => {
    const drafts: MovementDraft[] = [purchaseDraft("matcha", g("10000"), AT)];
    for (let i = 0; i < 500; i++) {
      drafts.push(...depletionDrafts([{ ingredientId: "matcha", qty: g("4.125") }], `s-${i}`, AT));
    }
    // 10000 - (500 × 4.125) = 10000 - 2062.5 = 7937.5
    expect(onHandFrom(stamp(drafts))).toBe(g("7937.5"));
  });
});

describe("onHandByIngredient", () => {
  it("keeps ingredients separate", () => {
    const movements = stamp([
      purchaseDraft("matcha", g("100"), AT),
      purchaseDraft("milk", g("2000"), AT),
      ...depletionDrafts(
        [
          { ingredientId: "matcha", qty: g("4") },
          { ingredientId: "milk", qty: g("200") },
        ],
        "sale-1",
        AT,
      ),
    ]);
    const onHand = onHandByIngredient(movements);
    expect(onHand.get("matcha")).toBe(g("96"));
    expect(onHand.get("milk")).toBe(g("1800"));
  });

  it("omits ingredients with no movements rather than inventing a zero", () => {
    expect(onHandByIngredient([]).size).toBe(0);
  });
});

describe("depletionDrafts", () => {
  it("produces one negative movement per required ingredient, linked to the sale", () => {
    const reqs: Requirement[] = [
      { ingredientId: "matcha", qty: g("4") },
      { ingredientId: "milk", qty: g("200") },
    ];
    const drafts = depletionDrafts(reqs, "sale-42", AT);

    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.kind).toBe("SALE_DEPLETION");
      expect(draft.delta).toBeLessThan(0);
      expect(draft.saleId).toBe("sale-42");
    }
    expect(drafts.find((d) => d.ingredientId === "matcha")?.delta).toBe(negateQty(g("4")));
  });

  it("skips zero-quantity requirements rather than writing empty rows", () => {
    const drafts = depletionDrafts([{ ingredientId: "water", qty: ZERO_QTY }], "s", AT);
    expect(drafts).toEqual([]);
  });
});

describe("restockDrafts — the void path", () => {
  it("exactly negates the original depletions, so a void nets the ledger to zero", () => {
    const reqs: Requirement[] = [
      { ingredientId: "matcha", qty: g("4") },
      { ingredientId: "milk", qty: g("200") },
    ];
    const depletions = stamp(depletionDrafts(reqs, "sale-42", AT));
    const restocks = stamp(restockDrafts(depletions, AT), "r");

    expect(onHandFrom([...depletions, ...restocks])).toBe(ZERO_QTY);
  });

  it("restocks what was actually taken, even if the recipe has since changed", () => {
    // Sale took 4g under the old recipe.
    const depletions = stamp(depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "s", AT));
    // Recipe later changed to 6g — irrelevant, the void puts back the 4g taken.
    const restocks = restockDrafts(depletions, AT);
    expect(restocks[0]!.delta).toBe(g("4"));
  });

  it("keeps the link to the original sale", () => {
    const depletions = stamp(depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "sale-9", AT));
    expect(restockDrafts(depletions, AT)[0]!.saleId).toBe("sale-9");
  });

  it("refuses to restock anything that is not a sale depletion", () => {
    const waste = stamp([wasteDraft("matcha", g("4"), "SPILLED", AT)]);
    expect(() => restockDrafts(waste, AT)).toThrow(LedgerError);
  });
});

describe("wasteDraft", () => {
  it("removes stock and records why", () => {
    const draft = wasteDraft("matcha", g("8"), "SPILLED", AT, "knocked the tin over");
    expect(draft.delta).toBe(negateQty(g("8")));
    expect(draft.wasteReason).toBe("SPILLED");
    expect(draft.note).toBe("knocked the tin over");
  });

  it("supports all three reasons PLAN.md names", () => {
    for (const reason of ["SPILLED", "EXPIRED", "STAFF_DRINK"] as const) {
      expect(wasteDraft("matcha", g("1"), reason, AT).wasteReason).toBe(reason);
    }
  });

  it("rejects a zero or negative waste quantity", () => {
    expect(() => wasteDraft("matcha", ZERO_QTY, "SPILLED", AT)).toThrow(LedgerError);
    expect(() => wasteDraft("matcha", negateQty(g("1")), "SPILLED", AT)).toThrow(LedgerError);
  });
});

describe("purchaseDraft", () => {
  it("adds stock", () => {
    expect(purchaseDraft("matcha", g("100"), AT).delta).toBe(g("100"));
  });

  it("rejects a zero or negative purchase", () => {
    expect(() => purchaseDraft("matcha", ZERO_QTY, AT)).toThrow(LedgerError);
    expect(() => purchaseDraft("matcha", negateQty(g("1")), AT)).toThrow(LedgerError);
  });
});

describe("countAdjustmentDraft", () => {
  it("records the variance as its own event rather than overwriting the count", () => {
    // Ledger says 100g, the tin actually holds 88g.
    const draft = countAdjustmentDraft("matcha", g("88"), g("100"), AT, "monthly count");
    expect(draft).not.toBeNull();
    expect(draft!.kind).toBe("COUNT_ADJUSTMENT");
    expect(draft!.delta).toBe(negateQty(g("12"))); // the discrepancy is preserved, not erased
  });

  it("applying the adjustment brings the derived on-hand to the counted figure", () => {
    const ledger = stamp([purchaseDraft("matcha", g("100"), AT)]);
    const adjustment = countAdjustmentDraft("matcha", g("88"), onHandFrom(ledger), AT)!;
    expect(onHandFrom([...ledger, { ...adjustment, id: "adj" }])).toBe(g("88"));
  });

  it("handles a count that is higher than the ledger", () => {
    expect(countAdjustmentDraft("matcha", g("110"), g("100"), AT)!.delta).toBe(g("10"));
  });

  it("returns null for a clean count, so the ledger stays free of zero rows", () => {
    expect(countAdjustmentDraft("matcha", g("100"), g("100"), AT)).toBeNull();
  });

  it("rejects a negative physical count", () => {
    expect(() => countAdjustmentDraft("matcha", negateQty(g("1")), g("100"), AT)).toThrow(LedgerError);
  });
});

describe("stockStatus", () => {
  it("is OUT at or below zero", () => {
    expect(stockStatus(ZERO_QTY, g("20"))).toBe("OUT");
    expect(stockStatus(negateQty(g("5")), g("20"))).toBe("OUT");
  });

  it("is LOW at or below the reorder point, inclusive — it should fire with stock left to sell", () => {
    expect(stockStatus(g("20"), g("20"))).toBe("LOW");
    expect(stockStatus(g("19"), g("20"))).toBe("LOW");
  });

  it("is OK above the reorder point", () => {
    expect(stockStatus(g("21"), g("20"))).toBe("OK");
  });

  it("never reports LOW when the reorder point is zero and stock remains", () => {
    expect(stockStatus(g("1"), ZERO_QTY)).toBe("OK");
  });
});

describe("movementsByKind — the variance investigation", () => {
  it("shows where the stock went, which is the entire point of the ledger", () => {
    const movements = stamp([
      purchaseDraft("matcha", g("100"), AT),
      ...depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "s-1", AT),
      ...depletionDrafts([{ ingredientId: "matcha", qty: g("4") }], "s-2", AT),
      wasteDraft("matcha", g("8"), "SPILLED", AT),
    ]);
    const byKind = movementsByKind(movements);

    expect(byKind.get("PURCHASE")).toBe(g("100"));
    expect(byKind.get("SALE_DEPLETION")).toBe(negateQty(g("8")));
    expect(byKind.get("WASTE")).toBe(negateQty(g("8")));
    // "You bought 100, sold 8 worth, spilled 8, and are still 12 short" —
    // a sentence a stored on-hand figure could never produce.
    expect(onHandFrom(movements)).toBe(g("84"));
  });

  it("sums to the same figure as onHandFrom", () => {
    const movements = stamp([
      purchaseDraft("matcha", g("100"), AT),
      wasteDraft("matcha", g("3"), "EXPIRED", AT),
    ]);
    const total = quantity([...movementsByKind(movements).values()].reduce((a, b) => a + b, 0));
    expect(total).toBe(onHandFrom(movements));
  });
});
