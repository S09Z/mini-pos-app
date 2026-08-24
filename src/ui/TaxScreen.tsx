import { useState } from "react";
import { formatTHB, fromBahtString, satang, type Satang } from "../money.js";
import { HEAD_OFFICE_BRANCH, formatBranch, isValidThaiTaxId } from "../tax/registration.js";
import type { Watchdog } from "../tax/registration.js";
import type { Pp30 } from "../tax/pp30.js";
import type { TaxInvoice } from "../tax/invoice.js";
import type { TaxView } from "../db/tax.js";
import { TaxInvoiceDocument } from "./TaxInvoiceDocument.js";

export interface TaxActions {
  register: (input: {
    effectiveFrom: string;
    taxId: string;
    branchCode: string;
    posMachineNumber: string;
    note: string;
  }) => Promise<void>;
  deregister: (input: { effectiveFrom: string; note: string }) => Promise<void>;
  saveIdentity: (name: string, address: string) => Promise<void>;
  recordPurchase: (input: {
    at: string;
    supplier: string;
    invoiceNo: string;
    net: Satang;
    vat: Satang;
    claimable: boolean;
    disallowedReason: string | null;
  }) => Promise<void>;
  exportReturn: (period: string) => Promise<void>;
  /**
   * Hand out a duplicate of an invoice already issued, marked สำเนา.
   *
   * Rebuilt from the stored record, never recomputed at today's rate (rule 5),
   * and it consumes no new number — one original per number is the whole
   * point of the sequence.
   */
  reprint: (invoiceRecordId: string) => Promise<TaxInvoice>;
}

/**
 * VAT mode.
 *
 * Its own tab rather than a section of Day, on the same argument that gave
 * Payouts one: this is monthly paperwork done sitting down, and none of it
 * belongs in the four seconds it takes to ring a sale.
 *
 * The watchdog leads, because it is the only thing here that matters *before*
 * registration — and being ready before the threshold rather than after it is
 * the whole point of the phase.
 */
export function TaxScreen({ view, actions }: { view: TaxView; actions: TaxActions }) {
  const [registering, setRegistering] = useState(false);
  const [addingPurchase, setAddingPurchase] = useState(false);
  const [reprinted, setReprinted] = useState<TaxInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work");
      return false;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-4 border-b border-rule p-4">
        <h2 className="text-13 tracking-wide">TAX</h2>
        <span className="text-13 opacity-60">
          {view.registration.registered
            ? `VAT registered since ${view.registration.since?.slice(0, 10)}`
            : "Not VAT registered"}
        </span>
      </div>

      {error !== null && (
        <p className="m-4 rounded-[4pt] border border-beni p-3 text-13 text-beni">{error}</p>
      )}

      <div className="flex flex-col gap-6 p-6">
        <WatchdogSection watchdog={view.watchdog} registered={view.registration.registered} />

        <RegistrationSection
          view={view}
          registering={registering}
          onOpen={() => setRegistering(true)}
          onClose={() => setRegistering(false)}
          onRegister={async (input) => {
            if (await run(() => actions.register(input))) setRegistering(false);
          }}
          onDeregister={(input) => void run(() => actions.deregister(input))}
          onSaveIdentity={(name, address) => void run(() => actions.saveIdentity(name, address))}
        />

        <PurchasesSection
          view={view}
          adding={addingPurchase}
          onOpen={() => setAddingPurchase(true)}
          onClose={() => setAddingPurchase(false)}
          onAdd={async (input) => {
            if (await run(() => actions.recordPurchase(input))) setAddingPurchase(false);
          }}
        />

        <ReturnsSection returns={view.returns} onExport={(p) => void run(() => actions.exportReturn(p))} />

        <InvoicesSection
          view={view}
          onReprint={(id) =>
            void run(async () => {
              setReprinted(await actions.reprint(id));
            })
          }
        />
      </div>

      {reprinted !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/70 p-6">
          <div className="flex max-h-full flex-col items-center gap-4 overflow-y-auto rounded-[4pt] bg-paper p-6">
            <TaxInvoiceDocument invoice={reprinted} />
            <button
              type="button"
              onClick={() => setReprinted(null)}
              className="h-[44pt] w-full rounded-[4pt] border border-rule text-13"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The trailing-twelve-month watchdog.
 *
 * A bar rather than a number alone: the shape of "how close am I" is the thing
 * being communicated, and it has to be readable at a glance from across a
 * counter. Colour never carries the message on its own — every state also
 * states its case in words.
 */
function WatchdogSection({ watchdog, registered }: { watchdog: Watchdog; registered: boolean }) {
  const pct = Math.min(100, watchdog.usedBp / 100);

  return (
    <section>
      <div className="text-13 tracking-wide opacity-60">TRAILING 12 MONTHS</div>
      <div
        className="text-88 leading-none tabular-nums text-matcha"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {formatTHB(watchdog.trailing12m)}
      </div>

      <div className="mt-3 h-2 w-full max-w-[600pt] bg-rule">
        <div
          className={watchdog.required ? "h-full bg-beni" : watchdog.approaching ? "h-full bg-kincha" : "h-full bg-matcha"}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-13 opacity-70">
        {(watchdog.usedBp / 100).toFixed(1)}% of the {formatTHB(watchdog.threshold)} registration
        threshold
      </div>

      {watchdog.required && !registered && (
        <p className="mt-3 rounded-[4pt] bg-beni p-3 text-15 leading-relaxed text-paper">
          Revenue passed the threshold on {watchdog.crossedAt?.slice(0, 10)}. Registration is
          compulsory, and the paperwork is due by{" "}
          <strong>{watchdog.registerBy?.slice(0, 10)}</strong>. Speak to your accountant now.
        </p>
      )}
      {watchdog.required && registered && (
        <p className="mt-3 text-13 opacity-70">
          Over the threshold since {watchdog.crossedAt?.slice(0, 10)} — registered, nothing to do.
        </p>
      )}
      {watchdog.approaching && (
        <p className="mt-3 rounded-[4pt] bg-kincha p-3 text-15 leading-relaxed text-paper">
          {formatTHB(watchdog.headroom)} of headroom left before registration becomes compulsory.
          Registering takes time — start the conversation before you need it.
        </p>
      )}
    </section>
  );
}

function RegistrationSection({
  view,
  registering,
  onOpen,
  onClose,
  onRegister,
  onDeregister,
  onSaveIdentity,
}: {
  view: TaxView;
  registering: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRegister: (input: {
    effectiveFrom: string;
    taxId: string;
    branchCode: string;
    posMachineNumber: string;
    note: string;
  }) => Promise<void>;
  onDeregister: (input: { effectiveFrom: string; note: string }) => void;
  onSaveIdentity: (name: string, address: string) => void;
}) {
  const { registration } = view;
  const [name, setName] = useState(view.businessName);
  const [address, setAddress] = useState(view.businessAddress);

  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">REGISTRATION</h3>

      {registration.registered ? (
        <div className="text-15 leading-relaxed">
          <div className="font-mono">{registration.taxId}</div>
          <div className="opacity-70">{formatBranch(registration.branchCode!)}</div>
          <div className="opacity-70">Machine {registration.posMachineNumber}</div>
        </div>
      ) : (
        <p className="text-15 leading-relaxed">
          Not registered. Sales are rung without VAT, and no tax invoice can be issued — that is
          the correct behaviour below the threshold, not a limitation to work around.
        </p>
      )}

      {registering ? (
        <RegistrationForm onCancel={onClose} onSubmit={onRegister} />
      ) : (
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={onOpen}
            className="h-[44pt] rounded-[4pt] bg-ink px-4 text-13 font-medium text-paper"
          >
            {registration.registered ? "Record a change" : "Record registration"}
          </button>
          {registration.registered && (
            <button
              type="button"
              onClick={() =>
                onDeregister({ effectiveFrom: new Date().toISOString(), note: "" })
              }
              className="h-[44pt] rounded-[4pt] border border-beni px-4 text-13 text-beni"
            >
              Record deregistration
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex max-w-[600pt] flex-col gap-3">
        <TextField label="Business name (as it appears on an invoice)" value={name} onChange={setName} />
        <TextField label="Business address" value={address} onChange={setAddress} multiline />
        <button
          type="button"
          onClick={() => onSaveIdentity(name.trim(), address.trim())}
          disabled={name === view.businessName && address === view.businessAddress}
          className="h-[44pt] self-start rounded-[4pt] border border-rule px-4 text-13 disabled:opacity-30"
        >
          Save business details
        </button>
      </div>

      {view.events.length > 0 && (
        <table className="mt-4 w-full text-13 font-mono">
          <thead>
            <tr className="border-b border-rule text-left opacity-60">
              <th className="py-1 font-normal">Effective</th>
              <th className="py-1 font-normal">Event</th>
              <th className="py-1 font-normal">Tax ID</th>
              <th className="py-1 font-normal">Machine</th>
            </tr>
          </thead>
          <tbody>
            {view.events.map((event) => (
              <tr key={event.id} className="border-b border-rule">
                <td className="py-1">{event.effectiveFrom.slice(0, 10)}</td>
                <td className="py-1">{event.kind === "REGISTERED" ? "Registered" : "Deregistered"}</td>
                <td className="py-1">{event.kind === "REGISTERED" ? event.taxId : "—"}</td>
                <td className="py-1">{event.kind === "REGISTERED" ? event.posMachineNumber : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RegistrationForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    effectiveFrom: string;
    taxId: string;
    branchCode: string;
    posMachineNumber: string;
    note: string;
  }) => Promise<void>;
}) {
  const [effectiveDay, setEffectiveDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [taxId, setTaxId] = useState("");
  const [branchCode, setBranchCode] = useState(HEAD_OFFICE_BRANCH);
  const [machine, setMachine] = useState("");
  const [note, setNote] = useState("");

  const cleanTaxId = taxId.replace(/\s/g, "");
  const taxIdBad = cleanTaxId !== "" && !isValidThaiTaxId(cleanTaxId);
  const ready = isValidThaiTaxId(cleanTaxId) && /^\d{5}$/.test(branchCode) && machine.trim() !== "";

  return (
    <div className="mt-3 flex max-w-[600pt] flex-col gap-3 border border-rule p-4">
      <TextField
        label="Effective from"
        value={effectiveDay}
        onChange={setEffectiveDay}
        type="date"
        hint="The date on the certificate, not today. Sales before it stay VAT-free."
      />
      <TextField
        label="Tax ID (13 digits)"
        value={taxId}
        onChange={setTaxId}
        mono
        {...(taxIdBad ? { hint: "That is not a valid 13-digit Thai tax ID — check the digits." } : {})}
      />
      <TextField label="Branch code" value={branchCode} onChange={setBranchCode} mono
        hint={/^\d{5}$/.test(branchCode) ? formatBranch(branchCode) : "Five digits. 00000 is head office."} />
      <TextField
        label="POS machine number"
        value={machine}
        onChange={setMachine}
        mono
        hint="From the Revenue Department's approval. An abbreviated tax invoice cannot be issued without it."
      />
      <TextField label="Note" value={note} onChange={setNote} />

      <div className="flex gap-3">
        <button type="button" onClick={onCancel} className="h-[44pt] rounded-[4pt] border border-rule px-4 text-13">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            void onSubmit({
              // Midnight Bangkok-local on the chosen day: a decree boundary and
              // a registration boundary are the same kind of instant, and a
              // naive UTC date would move it seven hours.
              effectiveFrom: `${effectiveDay}T00:00:00+07:00`,
              taxId: cleanTaxId,
              branchCode,
              posMachineNumber: machine.trim(),
              note: note.trim(),
            })
          }
          className="h-[44pt] rounded-[4pt] bg-ink px-4 text-13 font-medium text-paper disabled:opacity-30"
        >
          Record registration
        </button>
      </div>
    </div>
  );
}

function PurchasesSection({
  view,
  adding,
  onOpen,
  onClose,
  onAdd,
}: {
  view: TaxView;
  adding: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdd: (input: {
    at: string;
    supplier: string;
    invoiceNo: string;
    net: Satang;
    vat: Satang;
    claimable: boolean;
    disallowedReason: string | null;
  }) => Promise<void>;
}) {
  return (
    <section className="border-t border-rule pt-4">
      <div className="mb-2 flex items-center gap-3">
        <h3 className="text-13 tracking-wide opacity-60">INPUT TAX — SUPPLIER INVOICES</h3>
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto h-[44pt] rounded-[4pt] border border-rule px-4 text-13"
        >
          Record a purchase
        </button>
      </div>

      {adding && <PurchaseForm onCancel={onClose} onSubmit={onAdd} />}

      {view.purchases.length === 0 ? (
        <p className="text-15 leading-relaxed">
          No supplier invoices recorded. Without them the return claims no input tax, which
          overstates what you owe.
        </p>
      ) : (
        <table className="w-full text-13 font-mono">
          <thead>
            <tr className="border-b border-rule text-left opacity-60">
              <th className="py-1 font-normal">Date</th>
              <th className="py-1 font-normal">Supplier</th>
              <th className="py-1 font-normal">Invoice</th>
              <th className="py-1 text-right font-normal">Net</th>
              <th className="py-1 text-right font-normal">VAT</th>
              <th className="py-1 font-normal">Claim</th>
            </tr>
          </thead>
          <tbody>
            {view.purchases.map((purchase) => (
              <tr key={purchase.id} className="border-b border-rule">
                <td className="py-1">{purchase.at.slice(0, 10)}</td>
                <td className="py-1">{purchase.supplier}</td>
                <td className="py-1">{purchase.invoiceNo}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatTHB(satang(purchase.netSatang), { symbol: false })}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatTHB(satang(purchase.vatSatang), { symbol: false })}
                </td>
                <td className="py-1">
                  {purchase.claimable ? "yes" : `no — ${purchase.disallowedReason ?? "unstated"}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PurchaseForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    at: string;
    supplier: string;
    invoiceNo: string;
    net: Satang;
    vat: Satang;
    claimable: boolean;
    disallowedReason: string | null;
  }) => Promise<void>;
}) {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [supplier, setSupplier] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [net, setNet] = useState("");
  const [vat, setVat] = useState("");
  const [claimable, setClaimable] = useState(true);
  const [reason, setReason] = useState("");

  const parsed = parseAmounts(net, vat);
  const ready = supplier.trim() !== "" && parsed !== null && (claimable || reason.trim() !== "");

  return (
    <div className="mb-4 flex max-w-[600pt] flex-col gap-3 border border-rule p-4">
      <TextField label="Invoice date" value={day} onChange={setDay} type="date" />
      <TextField label="Supplier" value={supplier} onChange={setSupplier} />
      <TextField label="Their invoice number" value={invoiceNo} onChange={setInvoiceNo} mono />
      <TextField label="Net amount (฿)" value={net} onChange={setNet} mono />
      <TextField
        label="VAT (฿)"
        value={vat}
        onChange={setVat}
        mono
        hint="Copy both figures off the supplier's invoice. Do not recompute them — their rounding is what they filed."
      />

      <label className="flex items-center gap-2 text-15">
        <input type="checkbox" checked={claimable} onChange={(e) => setClaimable(e.target.checked)} />
        Claimable as input tax
      </label>
      {!claimable && (
        <TextField
          label="Why not"
          value={reason}
          onChange={setReason}
          hint="Kept on the record rather than deleted, so what you failed to claim stays visible."
        />
      )}

      <div className="flex gap-3">
        <button type="button" onClick={onCancel} className="h-[44pt] rounded-[4pt] border border-rule px-4 text-13">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            parsed !== null &&
            void onSubmit({
              at: `${day}T00:00:00+07:00`,
              supplier: supplier.trim(),
              invoiceNo: invoiceNo.trim(),
              net: parsed.net,
              vat: parsed.vat,
              claimable,
              disallowedReason: claimable ? null : reason.trim(),
            })
          }
          className="h-[44pt] rounded-[4pt] bg-ink px-4 text-13 font-medium text-paper disabled:opacity-30"
        >
          Record purchase
        </button>
      </div>
    </div>
  );
}

/** `fromBahtString` at the input boundary — never `fromBaht` on a typed decimal. */
function parseAmounts(net: string, vat: string): { net: Satang; vat: Satang } | null {
  try {
    return { net: fromBahtString(net), vat: fromBahtString(vat) };
  } catch {
    return null;
  }
}

function ReturnsSection({
  returns,
  onExport,
}: {
  returns: readonly Pp30[];
  onExport: (period: string) => void;
}) {
  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">PP.30 — MONTHLY RETURN</h3>

      {returns.length === 0 ? (
        <p className="text-15 leading-relaxed">Nothing to report yet.</p>
      ) : (
        <table className="w-full text-13 font-mono">
          <thead>
            <tr className="border-b border-rule text-left opacity-60">
              <th className="py-1 font-normal">Month</th>
              <th className="py-1 text-right font-normal">Sales (net)</th>
              <th className="py-1 text-right font-normal">Output VAT</th>
              <th className="py-1 text-right font-normal">Input VAT</th>
              <th className="py-1 text-right font-normal">Credit b/f</th>
              <th className="py-1 text-right font-normal">Payable</th>
              <th className="py-1 text-right font-normal">Credit c/f</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {returns.map((ret) => (
              <tr key={ret.period} className="border-b border-rule">
                <td className="py-1">{ret.period}</td>
                <td className="py-1 text-right tabular-nums">{formatTHB(ret.sales.net, { symbol: false })}</td>
                <td className="py-1 text-right tabular-nums">{formatTHB(ret.outputVat, { symbol: false })}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatTHB(ret.inputVat, { symbol: false })}
                  {ret.purchases.disallowedEntries > 0 && (
                    <span className="ml-1 opacity-60">
                      (+{formatTHB(ret.purchases.disallowedVat, { symbol: false })} disallowed)
                    </span>
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatTHB(ret.creditBroughtForward, { symbol: false })}
                </td>
                <td className="py-1 text-right tabular-nums">{formatTHB(ret.payable, { symbol: false })}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatTHB(ret.creditCarriedForward, { symbol: false })}
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() => onExport(ret.period)}
                    className="rounded-[4pt] border border-rule px-2 py-1 text-11"
                  >
                    Export
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-11 leading-relaxed opacity-70">
        A draft for your accountant, not a filing. Which input tax is claimable, and the treatment
        of zero-rated and exempt supplies, are Revenue Department practice — have them check this
        before it is filed.
      </p>
    </section>
  );
}

function InvoicesSection({
  view,
  onReprint,
}: {
  view: TaxView;
  onReprint: (invoiceRecordId: string) => void;
}) {
  if (view.invoices.length === 0) return null;

  return (
    <section className="border-t border-rule pt-4">
      <h3 className="mb-2 text-13 tracking-wide opacity-60">
        TAX INVOICES ISSUED — next number {view.taxInvoicePrefix}-{view.nextTaxInvoiceSeq}
      </h3>
      <table className="w-full text-13 font-mono">
        <thead>
          <tr className="border-b border-rule text-left opacity-60">
            <th className="py-1 font-normal">Number</th>
            <th className="py-1 font-normal">Issued</th>
            <th className="py-1 font-normal">Kind</th>
            <th className="py-1 font-normal">Receipt</th>
            <th className="py-1 font-normal">Buyer</th>
            <th className="py-1 text-right font-normal">Total</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {view.invoices.map((invoice) => (
            <tr key={invoice.id} className="border-b border-rule">
              <td className="py-1">
                {invoice.invoiceNo}
                {invoice.copy && <span className="ml-1 opacity-60">สำเนา</span>}
              </td>
              <td className="py-1">{invoice.issuedAt.slice(0, 10)}</td>
              <td className="py-1">{invoice.kind === "FULL" ? "Full" : "Abbreviated"}</td>
              <td className="py-1">{invoice.receiptNo}</td>
              <td className="py-1">{invoice.buyerName ?? "—"}</td>
              <td className="py-1 text-right tabular-nums">
                {formatTHB(satang(invoice.grossSatang), { symbol: false })}
              </td>
              <td className="py-1 text-right">
                {/* Offered on the original only. The สำเนา rows are the audit
                    trail of what was handed out, not documents to reissue. */}
                {!invoice.copy && (
                  <button
                    type="button"
                    onClick={() => onReprint(invoice.id)}
                    className="text-13 underline underline-offset-2"
                  >
                    Reprint
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  type = "text",
  multiline = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  type?: string;
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
        <textarea value={value} rows={2} onChange={(e) => onChange(e.target.value)} className={className} />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${className} h-[44pt]`}
        />
      )}
      {hint !== undefined && <span className="mt-1 block text-11 leading-relaxed opacity-70">{hint}</span>}
    </label>
  );
}
