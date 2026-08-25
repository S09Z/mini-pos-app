import { useState } from "react";
import { formatTHB, fromBahtString, type Satang } from "../money.js";
import { formatQty, fromUnitString, quantity, type Quantity } from "../stock/units.js";
import { stockStatus, type WasteReason } from "../stock/ledger.js";
import type { IngredientRecord } from "../db/schema.js";

type PanelAction = "waste" | "purchase" | "count";

const WASTE_REASONS: readonly { key: WasteReason; label: string }[] = [
  { key: "SPILLED", label: "Spilled" },
  { key: "EXPIRED", label: "Expired" },
  { key: "STAFF_DRINK", label: "Staff drink" },
];

export interface StockActions {
  recordWaste: (ingredientId: string, qty: Quantity, reason: WasteReason) => Promise<void>;
  recordPurchase: (ingredientId: string, qty: Quantity, totalCost: Satang) => Promise<void>;
  recordCount: (ingredientId: string, counted: Quantity) => Promise<void>;
}

/**
 * DESIGN.md screen 5. Recording waste is a single tap from the list, with the
 * three reasons on screen at once — PLAN.md is explicit that if this is harder
 * to reach than selling, it will never be used, and unrecorded waste is
 * exactly what makes a count impossible to explain.
 *
 * Inline panels rather than modals: this is a thing done several times a day.
 */
export function StockScreen({
  ingredients,
  actions,
}: {
  ingredients: readonly IngredientRecord[];
  actions: StockActions;
}) {
  const [open, setOpen] = useState<{ id: string; action: PanelAction } | null>(null);

  if (ingredients.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-18">No ingredients yet.</p>
        <p className="text-13 opacity-60">Add what you stock to start tracking it.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <h2 className="border-b border-rule p-4 text-13 tracking-wide">STOCK</h2>

      <ul>
        {ingredients.map((ingredient) => {
          const onHand = quantity(ingredient.onHand);
          const status = stockStatus(onHand, quantity(ingredient.reorderPoint));
          const isOpen = open?.id === ingredient.id;

          return (
            <li key={ingredient.id} className="border-b border-rule">
              <div className="flex items-center gap-4 p-4">
                <div className="w-48">
                  <div className="text-18">{ingredient.name}</div>
                  <div className="text-11 opacity-60">
                    Reorder at {formatQty(quantity(ingredient.reorderPoint), ingredient.unit)}
                  </div>
                </div>

                <div
                  className="w-32 text-24 tabular-nums"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {formatQty(onHand, ingredient.unit)}
                </div>

                {/* Status always carries words, never colour alone. */}
                <div className="w-28">
                  {status === "OUT" && (
                    <span className="rounded-[4pt] border border-beni px-2 py-1 text-11 text-beni">Out</span>
                  )}
                  {status === "LOW" && (
                    <span className="rounded-[4pt] bg-kincha px-2 py-1 text-11 text-paper">Low</span>
                  )}
                </div>

                <div className="ml-auto flex gap-2">
                  {(["waste", "purchase", "count"] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => setOpen(isOpen && open.action === action ? null : { id: ingredient.id, action })}
                      aria-expanded={isOpen && open.action === action}
                      className={[
                        "h-[44pt] rounded-[4pt] border border-rule px-3 text-13",
                        isOpen && open.action === action ? "bg-ink text-paper" : "",
                      ].join(" ")}
                    >
                      {action === "waste" ? "Record waste" : action === "purchase" ? "Add purchase" : "Count"}
                    </button>
                  ))}
                </div>
              </div>

              {isOpen && (
                <StockPanel
                  ingredient={ingredient}
                  action={open.action}
                  actions={actions}
                  onDone={() => setOpen(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StockPanel({
  ingredient,
  action,
  actions,
  onDone,
}: {
  ingredient: IngredientRecord;
  action: PanelAction;
  actions: StockActions;
  onDone: () => void;
}) {
  const [qtyText, setQtyText] = useState("");
  const [costText, setCostText] = useState("");
  const [reason, setReason] = useState<WasteReason>("SPILLED");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The button names the outcome, per DESIGN.md — "Record 8g spilled" rather
   * than a bare "Record waste". It also keeps this button distinguishable
   * from the row control that opened the panel, which shares the plain name.
   */
  const outcomeLabel = ((): string => {
    let qtyLabel: string;
    try {
      qtyLabel = qtyText === "" ? "" : formatQty(fromUnitString(qtyText), ingredient.unit);
    } catch {
      qtyLabel = "";
    }
    if (action === "waste") {
      const reasonLabel = (WASTE_REASONS.find((r) => r.key === reason)?.label ?? "").toLowerCase();
      return qtyLabel === "" ? "Record waste" : `Record ${qtyLabel} ${reasonLabel}`;
    }
    if (action === "purchase") {
      let costLabel = "";
      try {
        costLabel = costText === "" ? "" : formatTHB(fromBahtString(costText));
      } catch {
        costLabel = "";
      }
      if (qtyLabel === "") return "Add purchase";
      return costLabel === "" ? `Add ${qtyLabel}` : `Add ${qtyLabel} for ${costLabel}`;
    }
    return qtyLabel === "" ? "Save count" : `Save count of ${qtyLabel}`;
  })();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const qty = fromUnitString(qtyText);
      if (action === "waste") {
        await actions.recordWaste(ingredient.id, qty, reason);
      } else if (action === "purchase") {
        await actions.recordPurchase(ingredient.id, qty, fromBahtString(costText));
      } else {
        await actions.recordCount(ingredient.id, qty);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-rule bg-ink/5 p-4">
      {action === "waste" && (
        <div className="mb-3 flex gap-2">
          {WASTE_REASONS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setReason(r.key)}
              aria-pressed={reason === r.key}
              className={[
                "h-[44pt] rounded-[4pt] border border-rule px-4 text-13",
                reason === r.key ? "bg-ink text-paper" : "",
              ].join(" ")}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-11 opacity-60">
            {action === "count" ? `Counted (${ingredient.unit})` : `Quantity (${ingredient.unit})`}
          </span>
          <input
            autoFocus
            inputMode="decimal"
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value)}
            placeholder="0"
            className="h-[44pt] w-40 rounded-[4pt] border border-rule px-3 text-18 tabular-nums"
          />
        </label>

        {action === "purchase" && (
          <label className="flex flex-col gap-1">
            <span className="text-11 opacity-60">Total paid (฿)</span>
            <input
              inputMode="decimal"
              value={costText}
              onChange={(e) => setCostText(e.target.value)}
              placeholder="0.00"
              className="h-[44pt] w-40 rounded-[4pt] border border-rule px-3 text-18 tabular-nums"
            />
          </label>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || qtyText === "" || (action === "purchase" && costText === "")}
          className="h-[44pt] rounded-[4pt] bg-ink px-6 text-13 font-medium text-paper disabled:opacity-30"
        >
          {outcomeLabel}
        </button>
        <button type="button" onClick={onDone} className="h-[44pt] rounded-[4pt] border border-rule px-4 text-13">
          Cancel
        </button>
      </div>

      {action === "count" && (
        <p className="mt-2 text-11 opacity-60">
          The app currently shows {formatQty(quantity(ingredient.onHand), ingredient.unit)}. Any
          difference is recorded as its own adjustment, never silently corrected.
        </p>
      )}
      {action === "purchase" && (
        <p className="mt-2 text-11 opacity-60">
          Current cost {formatTHB(Math.round(ingredient.costPerUnit / 1000) as Satang)} per{" "}
          {ingredient.unit}. A purchase re-blends this as a weighted average.
        </p>
      )}
      {error && <p className="mt-2 text-13 text-beni">{error}</p>}
    </div>
  );
}
