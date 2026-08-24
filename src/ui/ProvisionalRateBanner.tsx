import type { ResolvedRate } from "../tax/rates.js";

/**
 * DESIGN.md: "a thin `--kincha` bar above the ticket … Persistent, dismissible
 * for the session, not modal."
 *
 * It appears when `rateAt` has run past the last decree on file and carried the
 * previous rate forward. The sale is not blocked — a till that refuses to sell
 * because a decree has not been keyed in is worse than one that flags an
 * assumption — but the operator has to be told that today's VAT figure rests on
 * one.
 */
export function ProvisionalRateBanner({
  rate,
  onDismiss,
}: {
  rate: ResolvedRate;
  onDismiss: () => void;
}) {
  if (!rate.provisional) return null;

  return (
    <div className="flex items-center gap-3 bg-kincha px-4 py-2 text-paper">
      <p className="flex-1 text-13">
        VAT rate unconfirmed — check for a new decree. Charging{" "}
        <span className="tabular-nums">{(rate.rateBp / 100).toFixed(2)}%</span> under{" "}
        {rate.authority}.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="h-[44pt] shrink-0 rounded-[4pt] border border-paper px-3 text-13"
      >
        Dismiss for today
      </button>
    </div>
  );
}
