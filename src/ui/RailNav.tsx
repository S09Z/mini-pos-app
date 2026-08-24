export type Tab = "sell" | "stock" | "day" | "payouts" | "tax" | "settings";

const TABS: readonly { key: Tab; glyph: string; label: string; enabled: boolean }[] = [
  { key: "sell", glyph: "▣", label: "Sell", enabled: true },
  { key: "stock", glyph: "▤", label: "Stock", enabled: true },
  { key: "day", glyph: "▥", label: "Day", enabled: true },
  // Its own tab rather than a section of Day: reconciling a payout is a
  // fortnightly job done sitting down, not part of closing the till.
  { key: "payouts", glyph: "▧", label: "Payouts", enabled: true },
  // Monthly paperwork done sitting down, like Payouts. None of it belongs in
  // the four seconds it takes to ring a sale.
  { key: "tax", glyph: "▨", label: "Tax", enabled: true },
  { key: "settings", glyph: "▦", label: "Settings", enabled: false },
];

/** 88pt left rail: Sell / Stock / Day / Settings, connection dot pinned to the bottom. */
export function RailNav({
  active,
  onNavigate,
  alert,
}: {
  active: Tab;
  onNavigate: (tab: Tab) => void;
  /** Set when something on a tab needs attention — a low or out-of-stock ingredient. */
  alert?: Partial<Record<Tab, string>>;
}) {
  return (
    <nav className="flex h-full w-[88pt] shrink-0 flex-col border-r border-rule">
      <ul className="flex flex-col">
        {TABS.map((tab) => {
          const alertLabel = alert?.[tab.key];
          return (
            <li key={tab.key}>
              <button
                type="button"
                disabled={!tab.enabled}
                onClick={() => onNavigate(tab.key)}
                aria-current={tab.key === active ? "page" : undefined}
                title={tab.enabled ? tab.label : `${tab.label} — later phase`}
                className={[
                  "relative flex h-[72pt] w-full flex-col items-center justify-center gap-1",
                  tab.key === active ? "bg-ink text-paper" : "text-ink",
                  tab.enabled ? "" : "opacity-30",
                ].join(" ")}
              >
                <span className="text-24" aria-hidden="true">
                  {tab.glyph}
                </span>
                <span className="text-11">{tab.label}</span>
                {alertLabel !== undefined && (
                  // Carries a text label, not just the colour — DESIGN.md quality floor.
                  <span className="absolute right-1 top-2 rounded-[4pt] bg-kincha px-1 text-11 leading-tight text-paper">
                    {alertLabel}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto flex flex-col items-center gap-1 py-4">
        <span className="h-2 w-2 rounded-full bg-matcha" aria-hidden="true" />
        <span className="text-11">Local</span>
      </div>
    </nav>
  );
}
