import { useRef, useState } from "react";
import { formatTHB, fromBahtString, satang, type Satang } from "../money.js";
import { describeReconciliation, reasonsFor } from "../payout/reconcile.js";
import type { ExceptionKind } from "../payout/match.js";
import type { BatchView } from "../db/payouts.js";
import type { ChannelRecord, PayoutBatchRecord } from "../db/schema.js";

export interface PayoutActions {
  importStatement: (channelId: string, fileName: string, text: string) => Promise<void>;
  resolveException: (exceptionId: string, reason: string, note: string) => Promise<void>;
  reopenException: (exceptionId: string) => Promise<void>;
  recordDeposit: (batchId: string, deposit: Satang) => Promise<void>;
}

/**
 * The reconciliation workspace.
 *
 * Built around the exceptions queue rather than around the totals, because
 * PLAN.md is explicit that the unmatched rows *are* the finding. The totals
 * are a header; the queue is the screen.
 */
export function PayoutsScreen({
  channels,
  batches,
  view,
  selectedBatchId,
  onSelectBatch,
  actions,
}: {
  channels: readonly ChannelRecord[];
  batches: readonly PayoutBatchRecord[];
  view: BatchView | null;
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  actions: PayoutActions;
}) {
  const deliveryChannels = channels.filter((c) => c.active && c.gpRateBp > 0);
  const [importChannel, setImportChannel] = useState(deliveryChannels[0]?.id ?? "");
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setImportError(null);
    try {
      await actions.importStatement(importChannel, file.name, await file.text());
    } catch (err) {
      // A statement that cannot be read must say so loudly. A silent failure
      // here reads as "nothing was owed", which is the worst possible default.
      setImportError(err instanceof Error ? err.message : "Could not read that statement");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-rule p-4">
        <h2 className="text-13 tracking-wide">PAYOUTS</h2>

        <select
          value={importChannel}
          onChange={(e) => setImportChannel(e.target.value)}
          className="h-[44pt] rounded-[4pt] border border-rule px-3 text-15"
        >
          {deliveryChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>

        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="hidden"
          id="statement-file"
        />
        <label
          htmlFor="statement-file"
          className="flex h-[44pt] cursor-pointer items-center rounded-[4pt] bg-ink px-4 text-13 font-medium text-paper"
        >
          {busy ? "Reading…" : "Import statement"}
        </label>

        {batches.length > 0 && (
          <select
            value={selectedBatchId ?? ""}
            onChange={(e) => onSelectBatch(e.target.value)}
            className="ml-auto h-[44pt] rounded-[4pt] border border-rule px-3 text-15"
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.fileName} · {batch.importedAt.slice(0, 10)}
              </option>
            ))}
          </select>
        )}
      </div>

      {importError !== null && (
        <p className="m-4 rounded-[4pt] border border-beni p-3 text-13 text-beni">{importError}</p>
      )}

      {view === null ? (
        <div className="flex flex-col items-center justify-center gap-2 p-12">
          <p className="text-18">No statements imported yet.</p>
          <p className="text-13 opacity-60">
            Export the payout report from the platform and import it here to check what they paid.
          </p>
        </div>
      ) : (
        <BatchDetail view={view} actions={actions} />
      )}
    </div>
  );
}

function BatchDetail({ view, actions }: { view: BatchView; actions: PayoutActions }) {
  const { batch, reconciliation, exceptions } = view;
  const [depositText, setDepositText] = useState("");
  const [depositError, setDepositError] = useState<string | null>(null);

  const open = exceptions.filter((e) => e.reason === null);
  const resolved = exceptions.filter((e) => e.reason !== null);

  return (
    <div className="flex flex-col gap-6 p-6">
      <section>
        <div className="text-13 tracking-wide opacity-60">UNEXPLAINED VARIANCE</div>
        <div
          className={[
            "text-88 leading-none tabular-nums",
            reconciliation.unexplainedVariance === 0 ? "text-matcha" : "text-beni",
          ].join(" ")}
          style={{ fontFamily: "var(--font-display)" }}
        >
          {formatTHB(satang(Math.abs(reconciliation.unexplainedVariance)))}
        </div>
        <div className="mt-1 text-13 opacity-70">
          {describeReconciliation(reconciliation, formatTHB)}
        </div>
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(130pt,1fr))] gap-4 border-t border-rule pt-4">
        <Figure label="We expected" value={formatTHB(reconciliation.expectedFromSales)} note="from our own sales" />
        <Figure label="Statement says" value={formatTHB(reconciliation.statementTotal)} note={`${batch.rowCount} rows`} />
        <Figure
          label="Bank received"
          value={reconciliation.depositAmount === null ? "—" : formatTHB(reconciliation.depositAmount)}
        />
        <Figure
          label="Statement gap"
          value={formatTHB(reconciliation.statementVariance)}
          note="statement less our records"
        />
        <Figure
          label="Bank gap"
          value={reconciliation.depositVariance === null ? "—" : formatTHB(reconciliation.depositVariance)}
          note="deposit less statement"
        />
        <Figure label="Settled orders" value={String(view.matchedCount)} />
      </section>

      {reconciliation.depositAmount === null && (
        <section className="border-t border-rule pt-4">
          <h3 className="mb-2 text-13 tracking-wide opacity-60">DEPOSIT</h3>
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-11 opacity-60">What actually reached the bank (฿)</span>
              <input
                inputMode="decimal"
                value={depositText}
                onChange={(e) => setDepositText(e.target.value)}
                placeholder="0.00"
                className="h-[44pt] w-48 rounded-[4pt] border border-rule px-3 text-18 tabular-nums"
              />
            </label>
            <button
              type="button"
              disabled={depositText.trim() === ""}
              onClick={async () => {
                setDepositError(null);
                try {
                  await actions.recordDeposit(batch.id, fromBahtString(depositText));
                  setDepositText("");
                } catch (err) {
                  setDepositError(err instanceof Error ? err.message : "Could not record that");
                }
              }}
              className="h-[44pt] rounded-[4pt] bg-ink px-6 text-13 font-medium text-paper disabled:opacity-30"
            >
              Record deposit
            </button>
          </div>
          {depositError !== null && <p className="mt-2 text-13 text-beni">{depositError}</p>}
          <p className="mt-2 text-11 opacity-60">
            Kept separate from the statement total on purpose: a platform that publishes a correct
            statement and deposits something else is a specific problem worth seeing.
          </p>
        </section>
      )}

      <ExceptionQueue
        title={`OPEN EXCEPTIONS (${open.length})`}
        exceptions={open}
        actions={actions}
        emptyMessage="Nothing outstanding. Every difference has a reason against it."
      />

      {resolved.length > 0 && (
        <ExceptionQueue
          title={`EXPLAINED (${resolved.length})`}
          exceptions={resolved}
          actions={actions}
          emptyMessage=""
        />
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

const KIND_LABEL: Readonly<Record<string, string>> = {
  NO_SUCH_ORDER: "Paid for an order we never rang",
  MISSING_FROM_STATEMENT: "Sold but not paid",
  AMOUNT_MISMATCH: "Paid a different amount",
  DUPLICATE_IN_STATEMENT: "Same order twice",
};

function ExceptionQueue({
  title,
  exceptions,
  actions,
  emptyMessage,
}: {
  title: string;
  exceptions: readonly BatchView["exceptions"][number][];
  actions: PayoutActions;
  emptyMessage: string;
}) {
  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">{title}</h3>

      {exceptions.length === 0 ? (
        <p className="text-13 opacity-60">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {exceptions.map((exception) => (
            <ExceptionRow key={exception.id} exception={exception} actions={actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExceptionRow({
  exception,
  actions,
}: {
  exception: BatchView["exceptions"][number];
  actions: PayoutActions;
}) {
  const [note, setNote] = useState(exception.note);
  const [busy, setBusy] = useState(false);
  const isOpen = exception.reason === null;
  const reasons = reasonsFor(exception.kind as ExceptionKind);

  return (
    <li className="rounded-[4pt] border border-rule p-3">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-15">{exception.platformOrderId}</span>
        <span className="text-11 opacity-60">{KIND_LABEL[exception.kind] ?? exception.kind}</span>
        <span
          className={[
            "ml-auto text-18 tabular-nums",
            exception.varianceSatang < 0 ? "text-beni" : "",
          ].join(" ")}
          style={{ fontFamily: "var(--font-display)" }}
        >
          {formatTHB(satang(exception.varianceSatang))}
        </span>
      </div>

      <p className="mt-1 text-13 opacity-70">{exception.detail}</p>

      {isOpen ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {reasons.map((reason) => (
            <button
              key={reason.key}
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await actions.resolveException(exception.id, reason.key, note);
                } finally {
                  setBusy(false);
                }
              }}
              className="h-[44pt] rounded-[4pt] border border-rule px-3 text-13"
            >
              {reason.label}
            </button>
          ))}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-[44pt] flex-1 rounded-[4pt] border border-rule px-3 text-13"
          />
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <span className="rounded-[4pt] bg-ink px-2 py-1 text-11 text-paper">
            {reasons.find((r) => r.key === exception.reason)?.label ?? exception.reason}
          </span>
          {exception.note !== "" && <span className="text-11 opacity-60">{exception.note}</span>}
          <button
            type="button"
            onClick={() => void actions.reopenException(exception.id)}
            className="ml-auto h-[44pt] rounded-[4pt] px-3 text-13 opacity-60"
          >
            Reopen
          </button>
        </div>
      )}
    </li>
  );
}
