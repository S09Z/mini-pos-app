import { formatTHB, type Satang } from "../money.js";
import type { TaxInvoice } from "../tax/invoice.js";

/**
 * The printed document — ใบกำกับภาษีอย่างย่อ or ใบกำกับภาษี.
 *
 * Set in `--font-mono`, like the receipt preview and the reconciliation
 * columns: this is a data document, not a screen. Every figure comes straight
 * off the built invoice; nothing here computes anything, because the arithmetic
 * was frozen onto the sale at checkout (rule 5).
 *
 * The Thai headings are terms of art and appear verbatim. Blocks that can hold
 * Thai keep `leading-relaxed` so tone marks are not clipped — DESIGN.md asks
 * for roughly 1.5× Latin line-height, and a clipped ทำ on a legal document is
 * not a cosmetic problem.
 */
export function TaxInvoiceDocument({ invoice }: { invoice: TaxInvoice }) {
  const abbreviated = invoice.kind === "ABBREVIATED";

  return (
    <article className="w-[400pt] border border-rule bg-paper p-6 font-mono text-13 leading-relaxed">
      <header className="border-b border-rule pb-3 text-center">
        <div className="text-18">{invoice.headingTh}</div>
        <div className="text-11 opacity-60">{invoice.headingEn}</div>
        <div className="mt-1 text-11">{invoice.originalityLabelTh}</div>
      </header>

      <section className="border-b border-rule py-3">
        <div>{invoice.seller.name}</div>
        <div className="opacity-70">{invoice.seller.address}</div>
        <Row label="เลขประจำตัวผู้เสียภาษี" value={invoice.seller.taxId} />
        <Row label="สาขา" value={invoice.branchLabel} />
        {abbreviated && <Row label="เลขรหัสประจำเครื่อง" value={invoice.posMachineNumber} />}
      </section>

      {invoice.buyer !== null && (
        <section className="border-b border-rule py-3">
          <div className="text-11 opacity-60">ผู้ซื้อ / Buyer</div>
          <div>{invoice.buyer.name}</div>
          <div className="opacity-70">{invoice.buyer.address}</div>
          <Row
            label="เลขประจำตัวผู้เสียภาษี"
            value={invoice.buyer.taxId ?? "—"}
          />
          {!invoice.buyerCanClaimInputTax && (
            // Said plainly, at issue time, rather than left for the buyer's
            // accountant to discover: without a tax ID this document cannot
            // support an input-tax claim.
            <p className="mt-1 text-11 opacity-70">
              No tax ID given — this invoice cannot be used to claim input tax.
            </p>
          )}
        </section>
      )}

      <section className="border-b border-rule py-3">
        <Row label="เลขที่ / No." value={invoice.invoiceNo} />
        <Row label="ใบเสร็จ / Receipt" value={invoice.receiptNo} />
        <Row label="วันที่ / Date" value={formatIssuedAt(invoice.issuedAt)} />
      </section>

      <table className="w-full py-3">
        <thead>
          <tr className="border-b border-rule text-left opacity-60">
            <th className="py-1 font-normal">รายการ</th>
            <th className="py-1 text-right font-normal">จำนวน</th>
            <th className="py-1 text-right font-normal">
              {abbreviated ? "รวม" : "มูลค่า"}
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, i) => (
            <tr key={`${line.description}-${i}`} className="border-b border-rule align-top">
              <td className="py-1 leading-relaxed">{line.description}</td>
              <td className="py-1 text-right tabular-nums">{line.qty}</td>
              <td className="py-1 text-right tabular-nums">
                {/* Abbreviated shows the VAT-inclusive figure the customer paid;
                    a full invoice shows the net, with VAT stated separately. */}
                {formatTHB(abbreviated ? line.gross : line.net, { symbol: false })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="py-3">
        {!abbreviated && (
          <>
            <Total label="มูลค่าสินค้า / Net" value={invoice.net} />
            <Total
              label={`ภาษีมูลค่าเพิ่ม ${(invoice.rateBp / 100).toFixed(0)}% / VAT`}
              value={invoice.vat}
            />
          </>
        )}
        <div className="mt-1 flex items-baseline justify-between border-t border-rule pt-2">
          <span>รวมทั้งสิ้น / Total</span>
          <span className="text-18 tabular-nums text-matcha">{formatTHB(invoice.gross)}</span>
        </div>
        {invoice.vatIncludedNotice !== null && (
          <p className="mt-1 leading-relaxed">{invoice.vatIncludedNotice}</p>
        )}
      </section>

      <footer className="border-t border-rule pt-3 text-11 opacity-70">
        <div className="leading-relaxed">{invoice.authority}</div>
        {invoice.provisional && (
          // The rate was carried forward past the last decree on file. It is on
          // the document because a reprint has to show what was assumed.
          <div className="mt-1 bg-kincha px-2 py-1 text-paper">
            VAT rate unconfirmed at the time of sale — check for a new decree.
          </div>
        )}
      </footer>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 leading-relaxed">
      <span className="opacity-60">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function Total({ label, value }: { label: string; value: Satang }) {
  return (
    <div className="flex justify-between gap-3 leading-relaxed">
      <span className="opacity-60">{label}</span>
      <span className="tabular-nums">{formatTHB(value, { symbol: false })}</span>
    </div>
  );
}

/** Bangkok-local, because the date on the document is the date of the sale there. */
function formatIssuedAt(instant: string): string {
  return new Date(instant).toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
