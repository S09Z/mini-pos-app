import { formatTHB, type Satang } from "../money.js";
import type { SaleRecord } from "../db/schema.js";

/** An action keeps its name through the whole flow: Charge produces a receipt headed Charged. */
export function DoneScreen({
  sale,
  onNewSale,
  onVoid,
  onTaxInvoice,
}: {
  sale: SaleRecord;
  onNewSale: () => void;
  onVoid: () => void;
  /** Absent unless the sale is eligible — see CLAUDE.md rule 7. */
  onTaxInvoice?: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="text-13 tracking-wide opacity-60">CHARGED</div>
        <div className="text-15 font-mono opacity-60">{sale.receiptNo}</div>
      </div>

      <div className="text-center text-matcha">
        <div className="text-13 tracking-wide opacity-60">CHANGE DUE</div>
        <div className="text-88 leading-none tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
          {formatTHB(sale.changeSatang as Satang)}
        </div>
      </div>

      <div className="flex w-[320pt] flex-col gap-3">
        <button
          type="button"
          onClick={onNewSale}
          className="h-[72pt] rounded-[4pt] bg-ink text-18 font-medium text-paper"
        >
          New sale
        </button>
        {onTaxInvoice !== undefined && (
          <button
            type="button"
            onClick={onTaxInvoice}
            className="h-[44pt] rounded-[4pt] border border-rule text-13"
          >
            Tax invoice
          </button>
        )}
        <button type="button" onClick={onVoid} className="h-[44pt] rounded-[4pt] text-13 text-beni">
          Void sale
        </button>
      </div>
    </div>
  );
}
