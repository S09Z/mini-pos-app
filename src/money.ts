/**
 * money.ts — integer-only currency arithmetic.
 *
 * Every amount in this system is an integer number of satang (1 THB = 100 satang).
 * Floating point never touches a monetary value. `0.1 + 0.2 !== 0.3`, and in a POS
 * those fractions accumulate into books that will not reconcile.
 *
 * `Satang` is a branded type: a plain `number` will not typecheck where `Satang`
 * is expected, so an un-converted baht value cannot silently leak into the math.
 */

declare const SATANG_BRAND: unique symbol;

/** An integer count of satang. Construct only via `satang()` or `fromBaht()`. */
export type Satang = number & { readonly [SATANG_BRAND]: true };

/** Basis points: 700 = 7.00%. Integers only, so rates are exact. */
export type BasisPoints = number;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/** Assert-and-brand. Throws on non-integer, NaN, Infinity, or unsafe magnitude. */
export function satang(n: number): Satang {
  if (!Number.isFinite(n)) throw new MoneyError(`Not a finite amount: ${n}`);
  if (!Number.isInteger(n)) throw new MoneyError(`Satang must be a whole number, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new MoneyError(`Amount exceeds safe integer range: ${n}`);
  return n as Satang;
}

export const ZERO: Satang = satang(0);

/**
 * Convert baht to satang. Guards against float artefacts: `19.99 * 100` is
 * 1998.9999999999998 in IEEE754, so we round rather than truncate.
 */
export function fromBaht(baht: number): Satang {
  if (!Number.isFinite(baht)) throw new MoneyError(`Not a finite amount: ${baht}`);
  return satang(Math.round(baht * 100));
}

/**
 * Parse baht from a decimal *string*, exactly.
 *
 * Prefer this at every input boundary — price entry, CSV import, platform
 * statements. `fromBaht` still has one foot in float land: `1.005 * 100` is
 * 100.49999999999999 in IEEE754, so `fromBaht(1.005)` rounds down to 100 while
 * this function correctly yields 101. The difference is one satang, which is
 * exactly the kind of error that is invisible per sale and unreconcilable at
 * month end.
 */
export function fromBahtString(input: string): Satang {
  const m = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(input);
  if (!m) throw new MoneyError(`Not a valid decimal amount: "${input}"`);

  const [, sign, whole, frac = ""] = m;
  const satangPart = (frac + "00").slice(0, 2);
  const beyond = frac.slice(2);

  let total = Number(whole!) * 100 + Number(satangPart);
  // Round half away from zero on anything below satang precision.
  if (beyond !== "" && Number(beyond[0]) >= 5) total += 1;

  return satang(sign === "-" ? -total : total);
}

export function toBaht(s: Satang): number {
  return s / 100;
}

/** Display only. Never feed the output of this back into a calculation. */
export function formatTHB(s: Satang, opts: { symbol?: boolean } = {}): string {
  const { symbol = true } = opts;
  const negative = s < 0;
  const abs = Math.abs(s);
  const body = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return `${negative ? "-" : ""}${symbol ? "\u0e3f" : ""}${body}`;
}

export function add(a: Satang, b: Satang): Satang {
  return satang(a + b);
}

export function sub(a: Satang, b: Satang): Satang {
  return satang(a - b);
}

export function sum(xs: readonly Satang[]): Satang {
  return satang(xs.reduce<number>((acc, x) => acc + x, 0));
}

export function negate(a: Satang): Satang {
  return satang(-a);
}

/** Multiply by a whole quantity (e.g. 3 × unit price). */
export function scale(a: Satang, qty: number): Satang {
  if (!Number.isInteger(qty)) throw new MoneyError(`Quantity must be an integer, got ${qty}`);
  return satang(a * qty);
}

/**
 * Apply a basis-point rate, rounding half away from zero.
 *
 * JavaScript's `Math.round` rounds half *up* (toward +Infinity), so -0.5 becomes
 * -0 rather than -1. That asymmetry means a refund would not be the exact
 * negation of its sale. We round on the magnitude and reapply the sign.
 */
export function applyRate(a: Satang, bp: BasisPoints): Satang {
  if (!Number.isInteger(bp)) throw new MoneyError(`Basis points must be an integer, got ${bp}`);
  const sign = a < 0 ? -1 : 1;
  return satang(sign * Math.round((Math.abs(a) * bp) / 10_000));
}

/**
 * Split `total` across `weights` so the parts sum to `total` *exactly*.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover
 * satang out one at a time to the entries with the biggest fractional part.
 * This is the only correct way to push a document-level VAT figure back onto
 * individual lines — rounding each line independently will not tie.
 *
 * Ties break toward the earlier index, so the result is deterministic and a
 * reprint of an old receipt always reproduces the original allocation.
 */
export function allocate(total: Satang, weights: readonly number[]): Satang[] {
  if (weights.length === 0) throw new MoneyError("Cannot allocate across zero weights");
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new MoneyError("Weights must be finite and non-negative");
  }

  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  // Degenerate case: nothing to weigh by. Spread as evenly as possible.
  if (totalWeight === 0) {
    const base = Math.trunc(total / weights.length);
    const out = weights.map(() => satang(base));
    let remainder = total - base * weights.length;
    const step = remainder < 0 ? -1 : 1;
    for (let i = 0; remainder !== 0; i = (i + 1) % weights.length) {
      out[i] = satang(out[i]! + step);
      remainder -= step;
    }
    return out;
  }

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const exact = weights.map((w) => (magnitude * w) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let leftover = magnitude - floors.reduce((acc, x) => acc + x, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (const { i } of order) {
    if (leftover <= 0) break;
    floors[i] = floors[i]! + 1;
    leftover -= 1;
  }

  return floors.map((x) => satang(sign * x));
}
