import type { ChannelRecord } from "../db/schema.js";
import { WALK_IN } from "../channel/types.js";

/**
 * The channel switch and its indicator.
 *
 * DESIGN.md is emphatic about why this exists: "a persistent channel indicator
 * makes it impossible to ring a delivery order at counter prices". Ringing a
 * delivery order at the counter price is invisible on the receipt and shows up
 * a month later as a channel that mysteriously lost money.
 *
 * So on a delivery channel the whole bar inverts to `--ink` and stays that way
 * for the entire ticket. It is not a badge in a corner; it changes the look of
 * the screen the operator is staring at. Green is not used — green means money
 * here, and only money.
 */
export function ChannelBar({
  channels,
  activeId,
  onSelect,
  platformOrderId,
  onPlatformOrderIdChange,
  locked,
}: {
  channels: readonly ChannelRecord[];
  activeId: string;
  onSelect: (channelId: string) => void;
  platformOrderId: string;
  onPlatformOrderIdChange: (value: string) => void;
  /** True once the ticket has lines — switching channel mid-ticket would reprice it silently. */
  locked: boolean;
}) {
  const active = channels.find((c) => c.id === activeId);
  const isDelivery = activeId !== WALK_IN.id;

  return (
    <div
      className={[
        "flex items-center gap-3 border-b px-4 py-2",
        isDelivery ? "border-ink bg-ink text-paper" : "border-rule",
      ].join(" ")}
    >
      <span className="text-11 tracking-wide opacity-70">CHANNEL</span>

      <div className="flex gap-2">
        {channels
          .filter((c) => c.active)
          .map((channel) => {
            const selected = channel.id === activeId;
            return (
              <button
                key={channel.id}
                type="button"
                disabled={locked && !selected}
                onClick={() => onSelect(channel.id)}
                aria-pressed={selected}
                title={
                  locked && !selected
                    ? "Clear the ticket before switching channel — prices differ"
                    : channel.name
                }
                className={[
                  "h-[44pt] rounded-[4pt] border px-4 text-13",
                  selected
                    ? isDelivery
                      ? "border-paper bg-paper text-ink font-medium"
                      : "border-ink bg-ink text-paper font-medium"
                    : isDelivery
                      ? "border-paper/40 text-paper"
                      : "border-rule",
                  locked && !selected ? "opacity-30" : "",
                ].join(" ")}
              >
                {channel.name}
              </button>
            );
          })}
      </div>

      {isDelivery && (
        <>
          {/* Manual order entry: most small stalls key these in from the
              platform's own tablet, and the reference is unrecoverable once
              that screen moves on. */}
          <label className="ml-auto flex items-center gap-2">
            <span className="text-11 opacity-70">Order no.</span>
            <input
              value={platformOrderId}
              onChange={(e) => onPlatformOrderIdChange(e.target.value)}
              placeholder="from the platform tablet"
              className="h-[44pt] w-56 rounded-[4pt] border border-paper/40 bg-transparent px-3 text-15 text-paper placeholder:text-paper/40"
            />
          </label>
          <span className="text-11 opacity-70">
            {active?.gpRateBp !== undefined ? `${(active.gpRateBp / 100).toFixed(0)}% GP` : ""}
          </span>
        </>
      )}
    </div>
  );
}
