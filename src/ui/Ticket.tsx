import { formatTHB, sum, type Satang } from "../money.js";
import { Scoreboard } from "./Scoreboard.js";
import type { CartLine } from "../db/sales.js";

export function Ticket({
  cart,
  onIncrement,
  onDecrement,
  onCharge,
  channelName,
  /** Delivery orders are settled by the platform — there is no cash to tender. */
  isDelivery = false,
  blockedReason,
}: {
  cart: readonly CartLine[];
  onIncrement: (menuItemId: string) => void;
  onDecrement: (menuItemId: string) => void;
  onCharge: () => void;
  channelName?: string;
  isDelivery?: boolean;
  blockedReason?: string;
}) {
  const total = sum(cart.map((l) => (l.unitPriceSatang * l.qty) as Satang));
  const empty = cart.length === 0;

  return (
    <aside className="flex h-full w-[400pt] flex-col border-l border-rule">
      <h2 className="border-b border-rule p-4 text-13 tracking-wide">
        TICKET{channelName !== undefined && isDelivery ? ` · ${channelName.toUpperCase()}` : ""}
      </h2>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <p className="p-4 text-15 opacity-60">Tap an item to start a sale.</p>
        ) : (
          <ul>
            {cart.map((line) => (
              <li key={line.menuItemId} className="flex items-center gap-3 border-b border-rule p-4">
                <div className="flex-1">
                  <div className="text-15">{line.name}</div>
                  <div className="text-11 opacity-60">
                    {line.qty} × {formatTHB(line.unitPriceSatang)}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onDecrement(line.menuItemId)}
                    aria-label={`Remove one ${line.name}`}
                    className="h-[44pt] w-[44pt] rounded-[4pt] border border-rule text-18"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-15 tabular-nums">{line.qty}</span>
                  <button
                    type="button"
                    onClick={() => onIncrement(line.menuItemId)}
                    aria-label={`Add one more ${line.name}`}
                    className="h-[44pt] w-[44pt] rounded-[4pt] border border-rule text-18"
                  >
                    +
                  </button>
                </div>

                <span className="w-20 text-right text-15 tabular-nums">
                  {formatTHB((line.unitPriceSatang * line.qty) as Satang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-rule p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-13 tracking-wide opacity-60">TOTAL</span>
        </div>
        <div className="mb-4 text-matcha">
          <Scoreboard amount={total} size="total" />
        </div>
        <button
          type="button"
          disabled={empty || blockedReason !== undefined}
          onClick={onCharge}
          className="h-[72pt] w-full rounded-[4pt] bg-ink text-18 font-medium text-paper disabled:opacity-30"
        >
          {/* The button names the outcome. A delivery order is recorded, not
              charged — the platform already took the customer's money. */}
          {isDelivery ? `Record ${formatTHB(total)} order` : `Charge ${formatTHB(total)}`}
        </button>
        {blockedReason !== undefined && (
          <p className="mt-2 text-13 text-beni">{blockedReason}</p>
        )}
      </div>
    </aside>
  );
}
