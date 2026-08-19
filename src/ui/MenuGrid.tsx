import { formatTHB, type Satang } from "../money.js";
import type { MenuItemRecord } from "../db/schema.js";
import type { MenuItemStock } from "../stock/availability.js";
import type { ResolvedPrice } from "../channel/pricing.js";

export function MenuGrid({
  items,
  stock,
  prices,
  ingredientNames,
  onSelect,
  warnOnCounterPrice = false,
  disabled = false,
}: {
  items: readonly MenuItemRecord[];
  stock: ReadonlyMap<string, MenuItemStock>;
  /** Channel-resolved prices. Falls back to the counter price, flagged. */
  prices: ReadonlyMap<string, ResolvedPrice>;
  ingredientNames: ReadonlyMap<string, string>;
  onSelect: (item: MenuItemRecord, price: Satang) => void;
  /**
   * Only true on a delivery channel. At the counter the counter price *is*
   * the right price, and a warning that fires when nothing is wrong teaches
   * the operator to ignore warnings — the failure DESIGN.md calls out.
   */
  warnOnCounterPrice?: boolean;
  /**
   * True while the price map is still catching up with a channel switch.
   * Tapping in that window would capture the previous channel's price into
   * the cart, so the grid refuses rather than ringing the wrong amount.
   */
  disabled?: boolean;
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

        const resolved = prices.get(item.id);
        const price = (resolved?.price ?? item.priceSatang) as Satang;
        // On a delivery channel with no channel price on file, the counter
        // price is very often a loss at 30% GP — and nothing else on the tile
        // would reveal it.
        const usingCounterPrice = warnOnCounterPrice && resolved?.fellBackToBase === true;

        return (
          <button
            key={item.id}
            type="button"
            disabled={soldOut || disabled}
            onClick={() => onSelect(item, price)}
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
              {formatTHB(price)}
            </span>
            {usingCounterPrice && (
              <span className="rounded-[4pt] bg-kincha px-1 text-11 text-paper">
                Counter price — no channel price set
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
