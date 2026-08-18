import { useState } from "react";
import { formatTHB, type Satang } from "../money.js";
import type { SaleRecord } from "../db/schema.js";

/**
 * Void requires the owner PIN. The confirm step states what is being reversed
 * in full, because this is the one action with no undo (DESIGN.md).
 */
export function VoidDialog({
  sale,
  onConfirm,
  onCancel,
}: {
  sale: SaleRecord;
  onConfirm: (pin: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void sale");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink/40">
      <div className="w-[360pt] rounded-[4pt] border border-rule bg-paper p-6">
        <h2 className="mb-2 text-18 font-medium text-beni">
          Void sale {sale.receiptNo}, {formatTHB(sale.grossSatang as Satang)}
        </h2>
        <p className="mb-4 text-13 opacity-70">This cannot be undone. Enter the owner PIN to confirm.</p>

        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="mb-2 h-[44pt] w-full rounded-[4pt] border border-rule px-3 text-18 tabular-nums"
          placeholder="Owner PIN"
        />
        {error && <p className="mb-2 text-13 text-beni">{error}</p>}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-[44pt] flex-1 rounded-[4pt] border border-rule text-15"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || pin === ""}
            className="h-[44pt] flex-1 rounded-[4pt] bg-beni text-15 font-medium text-paper disabled:opacity-30"
          >
            Void sale
          </button>
        </div>
      </div>
    </div>
  );
}
