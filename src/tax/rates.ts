/**
 * rates.ts — dated tax rate lookup.
 *
 * Thailand's statutory VAT rate is 10%. The 7% everyone actually pays exists
 * only because a royal decree renews it, historically for one year at a time,
 * running 1 October to 30 September. So the rate is a *function of the sale
 * date*, never a constant.
 *
 * Two rules this module enforces:
 *
 *  1. Boundaries are Bangkok-local instants. A sale rung at 00:30 on 1 October
 *     is 17:30 on 30 September in UTC. Comparing naive UTC dates would put that
 *     sale under the previous decree.
 *
 *  2. When the sale date falls past the last known decree, we do NOT block the
 *     sale and we do NOT silently jump to the statutory 10%. We carry the last
 *     known rate forward, flagged `provisional`, so the UI can warn the operator
 *     while the till keeps working. A POS that refuses to sell because a decree
 *     has not been keyed in yet is worse than one that flags an assumption.
 */

import type { BasisPoints } from "../money.js";

export class TaxRateError extends Error {
  override readonly name = "TaxRateError";
}

export interface TaxRate {
  readonly code: string;
  readonly rateBp: BasisPoints;
  /** Inclusive start, as an ISO-8601 instant with explicit offset. */
  readonly validFrom: string;
  /** Exclusive end. `null` means open-ended (statutory default). */
  readonly validTo: string | null;
  /** Legal citation, printed on audit reports. */
  readonly authority: string;
}

export interface ResolvedRate {
  readonly code: string;
  readonly rateBp: BasisPoints;
  readonly authority: string;
  /** True when carried forward past the last decree — surface a warning. */
  readonly provisional: boolean;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new TaxRateError(`Unparseable date: ${iso}`);
  return t;
};

/**
 * Thai VAT history, most recent last. Boundaries carry the +07:00 offset
 * explicitly so the intent survives any server timezone.
 *
 * Each renewal is a new row — we never edit an old one, or historical receipts
 * would stop reproducing.
 */
export const TH_VAT_RATES: readonly TaxRate[] = [
  {
    code: "VAT_TH",
    rateBp: 700,
    validFrom: "2024-10-01T00:00:00+07:00",
    validTo: "2025-10-01T00:00:00+07:00",
    authority: "Royal Decree No. 780 (B.E. 2567)",
  },
  {
    code: "VAT_TH",
    rateBp: 700,
    validFrom: "2025-10-01T00:00:00+07:00",
    validTo: "2026-10-01T00:00:00+07:00",
    authority: "Royal Decree No. 799 (B.E. 2568)",
  },
  {
    code: "VAT_TH",
    rateBp: 700,
    validFrom: "2026-10-01T00:00:00+07:00",
    validTo: "2027-10-01T00:00:00+07:00",
    authority: "Cabinet approval 27 Jul 2026 — CONFIRM decree number on publication",
  },
] as const;

/** Statutory fallback if no decree has ever applied. */
export const TH_VAT_STATUTORY_BP: BasisPoints = 1000;

/**
 * Validate a rate table at construction time rather than discovering an overlap
 * mid-service. Call this once at app boot and fail loudly.
 */
export function validateRateTable(rates: readonly TaxRate[]): void {
  const byCode = new Map<string, TaxRate[]>();
  for (const r of rates) {
    if (!Number.isInteger(r.rateBp) || r.rateBp < 0) {
      throw new TaxRateError(`Invalid rateBp ${r.rateBp} for ${r.code}`);
    }
    const from = ms(r.validFrom);
    if (r.validTo !== null && ms(r.validTo) <= from) {
      throw new TaxRateError(`${r.code}: validTo must be after validFrom (${r.validFrom})`);
    }
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  for (const [code, list] of byCode) {
    const sorted = [...list].sort((a, b) => ms(a.validFrom) - ms(b.validFrom));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.validTo === null || ms(prev.validTo) > ms(cur.validFrom)) {
        throw new TaxRateError(
          `${code}: overlapping periods at ${cur.validFrom} (previous ends ${prev.validTo})`,
        );
      }
    }
  }
}

/**
 * Resolve the rate in force at `at`.
 *
 * Half-open interval [validFrom, validTo): a sale at exactly midnight on the
 * boundary belongs to the *new* period.
 */
export function rateAt(
  code: string,
  at: Date,
  table: readonly TaxRate[] = TH_VAT_RATES,
  fallbackBp: BasisPoints = TH_VAT_STATUTORY_BP,
): ResolvedRate {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new TaxRateError("Invalid Date passed to rateAt");

  const forCode = table.filter((r) => r.code === code);
  if (forCode.length === 0) throw new TaxRateError(`No rate table for code "${code}"`);

  const hit = forCode.find(
    (r) => t >= ms(r.validFrom) && (r.validTo === null || t < ms(r.validTo)),
  );
  if (hit) {
    return { code, rateBp: hit.rateBp, authority: hit.authority, provisional: false };
  }

  const sorted = [...forCode].sort((a, b) => ms(a.validFrom) - ms(b.validFrom));
  const last = sorted[sorted.length - 1]!;

  // Past the end of the table: carry the last decree forward, flagged.
  if (last.validTo !== null && t >= ms(last.validTo)) {
    return {
      code,
      rateBp: last.rateBp,
      authority: `${last.authority} (expired ${last.validTo} — carried forward)`,
      provisional: true,
    };
  }

  // Before the table begins: statutory rate, also flagged.
  return {
    code,
    rateBp: fallbackBp,
    authority: "Statutory rate — no decree on file for this date",
    provisional: true,
  };
}
