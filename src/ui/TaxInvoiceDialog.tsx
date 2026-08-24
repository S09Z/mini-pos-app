import { useState } from "react";
import { isValidThaiTaxId } from "../tax/registration.js";
import type { InvoiceBuyer, InvoiceKind, TaxInvoice } from "../tax/invoice.js";
import type { SaleRecord } from "../db/schema.js";
import { TaxInvoiceDocument } from "./TaxInvoiceDocument.js";

export interface IssueRequest {
  readonly kind: InvoiceKind;
  readonly buyer?: InvoiceBuyer;
}

/**
 * Issuing a tax invoice for a sale that has just been rung.
 *
 * A modal, which DESIGN.md otherwise reserves for things done at most twice a
 * day — which is exactly what this is. Most customers take the abbreviated
 * invoice printed with the receipt; the full one is asked for by the occasional
 * customer expensing their coffee, and it needs typing that must not be rushed.
 */
export function TaxInvoiceDialog({
  sale,
  issued,
  onIssue,
  onClose,
}: {
  sale: SaleRecord;
  /** Set once the invoice has been built, so the operator can read it back. */
  issued: TaxInvoice | null;
  onIssue: (request: IssueRequest) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<InvoiceKind>("ABBREVIATED");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmedTaxId = taxId.replace(/\s/g, "");
  const taxIdLooksWrong = trimmedTaxId !== "" && !isValidThaiTaxId(trimmedTaxId);
  const fullReady = name.trim() !== "" && address.trim() !== "" && !taxIdLooksWrong;

  async function handleIssue() {
    setBusy(true);
    setError(null);
    try {
      await onIssue(
        kind === "ABBREVIATED"
          ? { kind }
          : {
              kind,
              buyer: {
                name: name.trim(),
                address: address.trim(),
                taxId: trimmedTaxId === "" ? null : trimmedTaxId,
              },
            },
      );
    } catch (err) {
      // A refusal here is usually rule 7 or a missing machine number, and the
      // operator is standing in front of the customer. Say which.
      setError(err instanceof Error ? err.message : "Could not issue that invoice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink/70 p-6">
      <div className="flex max-h-full gap-6 overflow-y-auto rounded-[4pt] bg-paper p-6">
        <div className="w-[400pt]">
          <h2 className="text-18">Tax invoice for {sale.receiptNo}</h2>

          {issued === null ? (
            <>
              <fieldset className="mt-4">
                <legend className="text-13 tracking-wide opacity-60">WHICH DOCUMENT</legend>
                <div className="mt-2 flex gap-2">
                  <KindButton
                    active={kind === "ABBREVIATED"}
                    onClick={() => setKind("ABBREVIATED")}
                    th="ใบกำกับภาษีอย่างย่อ"
                    en="Abbreviated — what most customers take"
                  />
                  <KindButton
                    active={kind === "FULL"}
                    onClick={() => setKind("FULL")}
                    th="ใบกำกับภาษี"
                    en="Full — for a customer expensing this"
                  />
                </div>
              </fieldset>

              {kind === "FULL" && (
                <div className="mt-4 flex flex-col gap-3">
                  <Field label="Customer name" value={name} onChange={setName} />
                  <Field label="Address" value={address} onChange={setAddress} multiline />
                  <Field
                    label="Tax ID (13 digits)"
                    value={taxId}
                    onChange={setTaxId}
                    mono
                    {...(taxIdLooksWrong
                      ? { hint: "That is not a valid 13-digit Thai tax ID — check the digits." }
                      : trimmedTaxId === ""
                        ? { hint: "Leave blank for an individual. Without it they cannot claim input tax." }
                        : {})}
                  />
                </div>
              )}

              {error !== null && (
                <p className="mt-4 rounded-[4pt] border border-beni p-3 text-13 text-beni">{error}</p>
              )}

              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-[72pt] flex-1 rounded-[4pt] border border-rule text-15"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || (kind === "FULL" && !fullReady)}
                  onClick={() => void handleIssue()}
                  className="h-[72pt] flex-1 rounded-[4pt] bg-ink text-18 font-medium text-paper disabled:opacity-30"
                >
                  {busy ? "Issuing…" : "Issue invoice"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-4 text-15">
                Issued as {issued.invoiceNo}. Hand it to the customer.
              </p>
              <p className="mt-1 text-13 opacity-60">
                A reprint of this number is marked สำเนา, so only one original exists.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 h-[72pt] w-full rounded-[4pt] bg-ink text-18 font-medium text-paper"
              >
                Done
              </button>
            </>
          )}
        </div>

        {issued !== null && <TaxInvoiceDocument invoice={issued} />}
      </div>
    </div>
  );
}

function KindButton({
  active,
  onClick,
  th,
  en,
}: {
  active: boolean;
  onClick: () => void;
  th: string;
  en: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex-1 rounded-[4pt] border p-3 text-left leading-relaxed",
        active ? "border-ink bg-ink text-paper" : "border-rule",
      ].join(" ")}
    >
      <span className="block text-15">{th}</span>
      <span className="block text-11 opacity-70">{en}</span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  multiline = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const className = [
    "w-full rounded-[4pt] border border-rule bg-paper px-3 py-2 text-15 leading-relaxed",
    mono ? "font-mono tabular-nums" : "",
  ].join(" ");

  return (
    <label className="block">
      <span className="text-13 tracking-wide opacity-60">{label.toUpperCase()}</span>
      {multiline ? (
        <textarea
          value={value}
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          className={className}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${className} h-[44pt]`}
        />
      )}
      {hint !== undefined && <span className="mt-1 block text-11 opacity-70">{hint}</span>}
    </label>
  );
}
