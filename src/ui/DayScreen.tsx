import { useState } from "react";
import { formatTHB, fromBahtString, satang, type Satang } from "../money.js";
import { describeVariance, THB_DENOMINATIONS, tallyTotal } from "../day/drawer.js";
import type { DayView } from "../db/day.js";

export interface DayActions {
  recordCount: (expected: Satang, declared: Satang, note: string) => Promise<void>;
  exportCsv: (day: string) => Promise<void>;
}

/**
 * DESIGN.md screen 4. Contribution sits above revenue in the hierarchy
 * because PLAN.md names the opposite as this phase's risk: "Revenue is the
 * number that feels good and tells you least."
 */
export function DayScreen({
  view,
  day,
  days,
  onSelectDay,
  actions,
}: {
  view: DayView;
  day: string;
  days: readonly string[];
  onSelectDay: (day: string) => void;
  actions: DayActions;
}) {
  const { report, audit, reconciliation } = view;
  const { totals } = report;
  const [counting, setCounting] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-4 border-b border-rule p-4">
        <h2 className="text-13 tracking-wide">DAY</h2>
        <select
          value={day}
          onChange={(e) => onSelectDay(e.target.value)}
          className="h-[44pt] rounded-[4pt] border border-rule px-3 text-15"
        >
          {(days.includes(day) ? days : [day, ...days]).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void actions.exportCsv(day)}
          className="ml-auto h-[44pt] rounded-[4pt] border border-rule px-4 text-13"
        >
          Export for accountant
        </button>
      </div>

      {totals.saleCount === 0 && totals.voidCount === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 p-12">
          <p className="text-18">No sales yet on {day}.</p>
          <p className="text-13 opacity-60">Ring one up on the Sell screen.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6 p-6">
          {/* Contribution leads. Revenue is available but subordinate. */}
          <section>
            <div className="text-13 tracking-wide opacity-60">CONTRIBUTION</div>
            <div
              className="text-88 leading-none tabular-nums text-matcha"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {formatTHB(totals.contribution)}
            </div>
            <div className="mt-1 text-13 opacity-70">
              {totals.costComplete ? (
                <>
                  {totals.contributionMarginBp === null
                    ? "margin unavailable"
                    : `${(totals.contributionMarginBp / 100).toFixed(1)}% of net revenue`}
                </>
              ) : (
                <span className="rounded-[4pt] bg-kincha px-2 py-1 text-paper">
                  Understated — {totals.uncostedLines} line
                  {totals.uncostedLines === 1 ? "" : "s"} had no recorded cost
                </span>
              )}
            </div>
          </section>

          <section className="grid grid-cols-[repeat(auto-fit,minmax(120pt,1fr))] gap-4 border-t border-rule pt-4">
            <Figure label="Net revenue" value={formatTHB(totals.net)} note="excludes VAT" />
            <Figure label="Cost of goods" value={formatTHB(totals.costOfGoods)} />
            <Figure label="Gross takings" value={formatTHB(totals.gross)} note="VAT inclusive" />
            <Figure label="VAT" value={formatTHB(totals.vat)} />
            <Figure label="Sales" value={String(totals.saleCount)} note={`${totals.itemCount} items`} />
            <Figure label="Average sale" value={formatTHB(totals.averageSale)} />
          </section>

          <DrawerSection
            expected={report.expectedCash}
            reconciliation={reconciliation}
            counting={counting}
            onOpen={() => setCounting(true)}
            onClose={() => setCounting(false)}
            onSubmit={async (declared, note) => {
              await actions.recordCount(report.expectedCash, declared, note);
              setCounting(false);
            }}
          />

          {report.byItem.length > 0 && (
            <section className="border-t border-rule pt-4">
              <h3 className="mb-2 text-13 tracking-wide opacity-60">
                BY ITEM — sorted by contribution, not revenue
              </h3>
              <table className="w-full text-13 font-mono">
                <thead>
                  <tr className="border-b border-rule text-left opacity-60">
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty</th>
                    <th className="py-1 text-right">Gross</th>
                    <th className="py-1 text-right">Cost</th>
                    <th className="py-1 text-right">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byItem.map((item) => (
                    <tr key={item.menuItemId} className="border-b border-rule">
                      <td className="py-1">{item.name}</td>
                      <td className="py-1 text-right tabular-nums">{item.qty}</td>
                      <td className="py-1 text-right tabular-nums">{formatTHB(item.gross, { symbol: false })}</td>
                      <td className="py-1 text-right tabular-nums">
                        {item.costComplete ? formatTHB(item.costOfGoods, { symbol: false }) : "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {item.costComplete ? formatTHB(item.contribution, { symbol: false }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.byHour.length > 0 && (
            <section className="border-t border-rule pt-4">
              <h3 className="mb-2 text-13 tracking-wide opacity-60">BY HOUR</h3>
              <div className="flex items-end gap-1">
                {report.byHour.map((bucket) => {
                  const peak = Math.max(...report.byHour.map((h) => h.gross));
                  const height = peak === 0 ? 0 : Math.round((bucket.gross / peak) * 80);
                  return (
                    <div key={bucket.hour} className="flex flex-col items-center gap-1">
                      <div
                        className="w-8 bg-ink"
                        style={{ height: `${Math.max(height, 2)}pt` }}
                        title={`${bucket.hour}:00 — ${formatTHB(bucket.gross)}`}
                      />
                      <span className="text-11 tabular-nums opacity-60">{bucket.hour}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <VoidSection view={view} audit={audit} />
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="text-11 tracking-wide opacity-60">{label.toUpperCase()}</div>
      <div className="text-24 tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
        {value}
      </div>
      {note !== undefined && <div className="text-11 opacity-50">{note}</div>}
    </div>
  );
}

function DrawerSection({
  expected,
  reconciliation,
  counting,
  onOpen,
  onClose,
  onSubmit,
}: {
  expected: Satang;
  reconciliation: DayView["reconciliation"];
  counting: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSubmit: (declared: Satang, note: string) => Promise<void>;
}) {
  const [tally, setTally] = useState<Record<number, number>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const declared = tallyTotal(tally);

  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">CASH DRAWER</h3>

      <div className="flex items-baseline gap-8">
        <Figure label="Expected" value={formatTHB(expected)} />
        {reconciliation && <Figure label="Counted" value={formatTHB(reconciliation.declared)} />}
        {reconciliation && (
          <div>
            <div className="text-11 tracking-wide opacity-60">VARIANCE</div>
            <div
              className={[
                "text-24 tabular-nums",
                reconciliation.status === "BALANCED" ? "text-matcha" : "text-beni",
              ].join(" ")}
              style={{ fontFamily: "var(--font-display)" }}
            >
              {describeVariance(reconciliation, formatTHB)}
            </div>
          </div>
        )}
        {!counting && (
          <button
            type="button"
            onClick={onOpen}
            className="ml-auto h-[44pt] rounded-[4pt] border border-rule px-4 text-13"
          >
            {reconciliation ? "Count again" : "Count the drawer"}
          </button>
        )}
      </div>

      {counting && (
        <div className="mt-4 rounded-[4pt] border border-rule p-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(90pt,1fr))] gap-2">
            {THB_DENOMINATIONS.map((denomination) => (
              <label key={denomination} className="flex items-center gap-2">
                <span className="w-16 text-right text-13 tabular-nums">
                  {formatTHB(denomination, { symbol: false })}
                </span>
                <input
                  inputMode="numeric"
                  value={tally[denomination] ?? ""}
                  onChange={(e) => {
                    const n = e.target.value === "" ? 0 : Number(e.target.value);
                    if (!Number.isInteger(n) || n < 0) return;
                    setTally((prev) => ({ ...prev, [denomination]: n }));
                  }}
                  placeholder="0"
                  className="h-[44pt] w-16 rounded-[4pt] border border-rule px-2 text-15 tabular-nums"
                />
              </label>
            ))}
          </div>

          <div className="mt-4 flex items-end gap-3">
            <div>
              <div className="text-11 tracking-wide opacity-60">COUNTED</div>
              <div className="text-34 tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
                {formatTHB(declared)}
              </div>
            </div>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-11 opacity-60">Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="h-[44pt] w-full rounded-[4pt] border border-rule px-3 text-15"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSubmit(declared, note);
                  setTally({});
                  setNote("");
                } finally {
                  setBusy(false);
                }
              }}
              className="h-[44pt] rounded-[4pt] bg-ink px-6 text-13 font-medium text-paper disabled:opacity-30"
            >
              Save count of {formatTHB(declared)}
            </button>
            <button type="button" onClick={onClose} className="h-[44pt] rounded-[4pt] border border-rule px-4 text-13">
              Cancel
            </button>
          </div>

          <p className="mt-2 text-11 opacity-60">
            Any difference is recorded as its own event and kept. Counting again adds a second
            record rather than replacing this one.
          </p>
        </div>
      )}
    </section>
  );
}

function VoidSection({ view, audit }: { view: DayView; audit: DayView["audit"] }) {
  if (audit.totalCount === 0) {
    return (
      <section className="border-t border-rule pt-4">
        <h3 className="mb-2 text-13 tracking-wide opacity-60">VOIDS</h3>
        <p className="text-13 opacity-60">None today.</p>
      </section>
    );
  }

  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">VOIDS</h3>

      {audit.flags.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1">
          {audit.flags.map((flag, i) => (
            <li key={`${flag.kind}-${i}`} className="rounded-[4pt] bg-kincha px-2 py-1 text-13 text-paper">
              {flag.kind === "HIGH_RATE" && "Unusual void rate"}
              {flag.kind === "BURST" && `Voids clustered${flag.actor ? ` (${flag.actor})` : ""}`}
              {flag.kind === "HIGH_VALUE_SHARE" && "Large share of value voided"}
              {" — "}
              {flag.detail}. Worth a look.
            </li>
          ))}
        </ul>
      )}

      <div className="mb-2 text-13">
        {audit.totalCount} void{audit.totalCount === 1 ? "" : "s"} worth{" "}
        {formatTHB(audit.totalValue)} ({(audit.rateBp / 100).toFixed(1)}% of sales rung)
      </div>

      <table className="w-full text-13 font-mono">
        <thead>
          <tr className="border-b border-rule text-left opacity-60">
            <th className="py-1">By</th>
            <th className="py-1 text-right">Count</th>
            <th className="py-1 text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          {audit.byActor.map((actor) => (
            <tr key={actor.actor} className="border-b border-rule">
              <td className="py-1">{actor.actor}</td>
              <td className="py-1 text-right tabular-nums">{actor.count}</td>
              <td className="py-1 text-right tabular-nums">{formatTHB(actor.value, { symbol: false })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-11 opacity-60">
        Only the owner PIN exists until staff roles land, so this groups to one actor today.
      </p>

      <ul className="mt-3 flex flex-col gap-1 text-11 font-mono opacity-70">
        {view.report.voids.map((v) => (
          <li key={v.saleId}>
            {v.receiptNo} · {new Date(v.createdAt).toISOString().slice(11, 16)} UTC · {v.actor}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Parse a baht string for the drawer note field. Exported for the tests. */
export function parseBaht(input: string): Satang {
  return input.trim() === "" ? satang(0) : fromBahtString(input);
}
