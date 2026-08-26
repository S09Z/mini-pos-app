/**
 * voidaudit.ts — voids grouped and flagged when clustered.
 *
 * A void is the one operation that makes money disappear from the record with
 * the system's blessing, so the pattern of voids is worth more attention than
 * any single one. PLAN.md asks for them "grouped by staff PIN, flagged when
 * clustered".
 *
 * **A limitation to be honest about:** there is one owner PIN until Phase 8
 * introduces staff roles, so grouping by actor currently produces a single
 * group. The grouping is built now because the field has to be on the record
 * from the first void — an audit trail that begins on the day you first
 * suspect something is an audit trail with nothing to compare against.
 *
 * What *does* work today is the clustering, which is actor-independent: an
 * unusual rate of voids, a burst of them in a few minutes, or a void
 * concentrated in high-value sales are all visible with one operator.
 *
 * These flags are prompts to go and look, not accusations. A genuine rush
 * produces mis-rings too.
 */

import { satang, sum, type Satang } from "../money.js";

export interface AuditableVoid {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly actor: string;
  /** Gross value of the sale being reversed. */
  readonly valueSatang: number;
}

export interface ActorVoidSummary {
  readonly actor: string;
  readonly count: number;
  readonly value: Satang;
}

export type VoidFlagKind = "HIGH_RATE" | "BURST" | "HIGH_VALUE_SHARE";

export interface VoidFlag {
  readonly kind: VoidFlagKind;
  readonly actor: string | null;
  /** Written to be read by a human at closing time, not parsed. */
  readonly detail: string;
}

export interface VoidAuditThresholds {
  /** Void count as a share of sales, in basis points. Default 10%. */
  readonly rateBp: number;
  /** This many voids inside `burstWindowMinutes` is a burst. */
  readonly burstCount: number;
  readonly burstWindowMinutes: number;
  /** Voided value as a share of gross takings, in basis points. Default 15%. */
  readonly valueShareBp: number;
}

export const DEFAULT_THRESHOLDS: VoidAuditThresholds = {
  rateBp: 1_000,
  burstCount: 3,
  burstWindowMinutes: 10,
  valueShareBp: 1_500,
};

export interface VoidAudit {
  readonly byActor: readonly ActorVoidSummary[];
  readonly flags: readonly VoidFlag[];
  readonly totalCount: number;
  readonly totalValue: Satang;
  /** Voids as a share of all sales rung, in basis points. */
  readonly rateBp: number;
}

export function auditVoids(
  voids: readonly AuditableVoid[],
  salesRung: number,
  grossTakings: Satang,
  thresholds: VoidAuditThresholds = DEFAULT_THRESHOLDS,
): VoidAudit {
  const totalValue = sum(voids.map((v) => satang(v.valueSatang)));
  const rateBp = salesRung === 0 ? 0 : Math.round((voids.length * 10_000) / salesRung);

  const byActor = groupByActor(voids);
  const flags: VoidFlag[] = [];

  if (voids.length > 0 && rateBp >= thresholds.rateBp) {
    flags.push({
      kind: "HIGH_RATE",
      actor: null,
      detail: `${voids.length} of ${salesRung} sales voided (${(rateBp / 100).toFixed(1)}%)`,
    });
  }

  for (const burst of findBursts(voids, thresholds)) {
    flags.push(burst);
  }

  // Share of takings only means something when there were takings.
  const denominator = grossTakings + totalValue;
  if (voids.length > 0 && denominator > 0) {
    const shareBp = Math.round((totalValue * 10_000) / denominator);
    if (shareBp >= thresholds.valueShareBp) {
      flags.push({
        kind: "HIGH_VALUE_SHARE",
        actor: null,
        detail: `${(shareBp / 100).toFixed(1)}% of the day's value was voided`,
      });
    }
  }

  return { byActor, flags, totalCount: voids.length, totalValue, rateBp };
}

function groupByActor(voids: readonly AuditableVoid[]): readonly ActorVoidSummary[] {
  const byActor = new Map<string, { count: number; value: number }>();
  for (const v of voids) {
    const entry = byActor.get(v.actor) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += v.valueSatang;
    byActor.set(v.actor, entry);
  }
  return [...byActor]
    .map(([actor, e]) => ({ actor, count: e.count, value: satang(e.value) }))
    .sort((a, b) => b.count - a.count || (a.actor < b.actor ? -1 : 1));
}

/**
 * Voids bunched into a short window, per actor.
 *
 * Scanned per actor because a burst is only suspicious when it is one person
 * doing it — three different people each voiding once in the same ten minutes
 * is a rush, not a pattern.
 */
function findBursts(
  voids: readonly AuditableVoid[],
  thresholds: VoidAuditThresholds,
): readonly VoidFlag[] {
  const windowMs = thresholds.burstWindowMinutes * 60_000;
  const flags: VoidFlag[] = [];

  const actors = new Set(voids.map((v) => v.actor));
  for (const actor of actors) {
    const times = voids
      .filter((v) => v.actor === actor)
      .map((v) => Date.parse(v.createdAt))
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => a - b);

    for (let i = 0; i + thresholds.burstCount - 1 < times.length; i++) {
      const last = times[i + thresholds.burstCount - 1]!;
      if (last - times[i]! <= windowMs) {
        flags.push({
          kind: "BURST",
          actor,
          detail: `${thresholds.burstCount} voids within ${thresholds.burstWindowMinutes} minutes`,
        });
        break; // One flag per actor is enough to send someone to look.
      }
    }
  }
  return flags;
}
