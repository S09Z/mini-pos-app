import { formatTHB, type Satang } from "../money.js";
import type { MenuItemRecord } from "../db/schema.js";
import type { MenuItemStock } from "../stock/availability.js";

export function MenuGrid({
  items,
  stock,
  ingredientNames,
  onSelect,
}: {
  items: readonly MenuItemRecord[];
  stock: ReadonlyMap<string, MenuItemStock>;
  ingredientNames: ReadonlyMap<string, string>;
  onSelect: (item: MenuItemRecord) => void;
}) {
  return (
    <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(160pt,1fr))] gap-4 overflow-y-auto p-6">
      {items.map((item) => {
        const itemStock = stock.get(item.id);
        // Sold out is derived from what is actually in the tins. The manual
        // flag still wins, so an item can be taken off sale for a reason the
        // recipe cannot express.
        const soldOut = item.soldOut || itemStock?.status === "OUT";
        const low = !soldOut && itemStock?.status === "LOW";
        const limiting = itemStock?.limitingIngredientId;
        const limitingName = limiting === undefined || limiting === null ? null : ingredientNames.get(limiting) ?? limiting;

        return (
          <button
            key={item.id}
            type="button"
            disabled={soldOut}
            onClick={() => onSelect(item)}
            className={[
              "flex min-h-[160pt] flex-col items-start justify-end gap-2 rounded-[4pt] border border-rule p-4 text-left",
              "active:bg-koicha active:text-paper active:transition-none",
              // Still visible when sold out — the operator needs to know it
              // exists in order to tell the customer.
              soldOut ? "opacity-40" : "",
            ].join(" ")}
          >
            {/* Never colour alone: both states carry words. */}
            {soldOut && (
              <span className="rounded-[4pt] border border-ink px-1 text-11">
                Sold out{limitingName ? ` — no ${limitingName.toLowerCase()}` : ""}
              </span>
            )}
            {low && (
              <span className="rounded-[4pt] bg-kincha px-1 text-11 text-paper">
                Low{limitingName ? `: ${limitingName.toLowerCase()}` : ""}
              </span>
            )}

            <span className="text-18 font-medium">{item.name}</span>
            <span
              className={["text-24 text-matcha", soldOut ? "line-through decoration-ink" : ""].join(" ")}
              style={{ fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatTHB(item.priceSatang as Satang)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
