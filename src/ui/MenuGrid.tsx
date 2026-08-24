import { formatTHB, type Satang } from "../money.js";
import type { MenuItemRecord } from "../db/schema.js";

export function MenuGrid({
  items,
  onSelect,
}: {
  items: readonly MenuItemRecord[];
  onSelect: (item: MenuItemRecord) => void;
}) {
  return (
    <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(160pt,1fr))] gap-4 overflow-y-auto p-6">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={item.soldOut}
          onClick={() => onSelect(item)}
          className={[
            "flex min-h-[160pt] flex-col items-start justify-end gap-2 rounded-[4pt] border border-rule p-4 text-left",
            "active:bg-koicha active:text-paper active:transition-none",
            item.soldOut ? "opacity-40" : "",
          ].join(" ")}
        >
          <span className="text-18 font-medium">{item.name}</span>
          <span
            className={["text-24 text-matcha", item.soldOut ? "line-through decoration-ink" : ""].join(" ")}
            style={{ fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums" }}
          >
            {formatTHB(item.priceSatang as Satang)}
          </span>
        </button>
      ))}
    </div>
  );
}
