const TABS = [
  { key: "sell", glyph: "▣", label: "Sell", enabled: true },
  { key: "stock", glyph: "▤", label: "Stock", enabled: false },
  { key: "day", glyph: "▥", label: "Day", enabled: false },
  { key: "settings", glyph: "▦", label: "Settings", enabled: false },
] as const;

/** 88pt left rail: Sell / Stock / Day / Settings, connection dot pinned to the bottom. */
export function RailNav() {
  return (
    <nav className="flex h-full w-[88pt] flex-col border-r border-rule">
      <ul className="flex flex-col">
        {TABS.map((tab) => (
          <li key={tab.key}>
            <button
              type="button"
              disabled={!tab.enabled}
              aria-current={tab.key === "sell" ? "page" : undefined}
              title={tab.enabled ? tab.label : `${tab.label} — later phase`}
              className={[
                "flex h-[72pt] w-full flex-col items-center justify-center gap-1",
                tab.key === "sell" ? "bg-ink text-paper" : "text-ink",
                tab.enabled ? "" : "opacity-30",
              ].join(" ")}
            >
              <span className="text-24" aria-hidden="true">
                {tab.glyph}
              </span>
              <span className="text-11">{tab.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col items-center gap-1 py-4">
        <span className="h-2 w-2 rounded-full bg-matcha" aria-hidden="true" />
        <span className="text-11">Local</span>
      </div>
    </nav>
  );
}
