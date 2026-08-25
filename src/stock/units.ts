/**
 * units.ts — integer-only quantity arithmetic.
 *
 * The same argument as `money.ts`, for the same reason. A latte removes 4g of
 * matcha; a tin holds 100g. That is 25 sales per tin, so a float error of
 * 1e-15 per depletion is obviously harmless — until you realise the whole
 * point of Phase 2 is reconciling the app against a physical count, and a
 * count that is "off by a rounding artefact" is indistinguishable from a count
 * that is off because something was spilled and not recorded.
 *
 * So: every quantity is an integer number of *milli-units* — thousandths of
 * whatever unit the ingredient is measured in. 4g of matcha is 4000. 200ml of
 * milk is 200_000. One cup is 1000.
 *
 * A thousandth of a gram is far finer than anything a stall can weigh, which
 * is the point: the representation should never be the limiting factor in a
 * discrepancy investigation.
 */

declare const QUANTITY_BRAND: unique symbol;

/** An integer count of milli-units. Construct only via `quantity()` or `fromUnitString()`. */
export type Quantity = number & { readonly [QUANTITY_BRAND]: true };

/**
 * What an ingredient is measured in. Deliberately tiny: a stall counts mass,
 * volume, and things. Adding "cups" or "shots" here would be modelling a
 * recipe, not an ingredient.
 */
export type Unit = "g" | "ml" | "piece";

/** Milli-units per display unit. The quantity analogue of 100 satang to the baht. */
export const MILLI: number = 1000;

export class QuantityError extends Error {
  override readonly name = "QuantityError";
}

/** Assert-and-brand. Throws on non-integer, NaN, Infinity, or unsafe magnitude. */
export function quantity(n: number): Quantity {
  if (!Number.isFinite(n)) throw new QuantityError(`Not a finite quantity: ${n}`);
  if (!Number.isInteger(n)) throw new QuantityError(`Quantity must be a whole number of milli-units, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new QuantityError(`Quantity exceeds safe integer range: ${n}`);
  return n as Quantity;
}

export const ZERO_QTY: Quantity = quantity(0);

/**
 * Parse a quantity from a decimal *string*, exactly.
 *
 * Use this at every input boundary — purchase entry, waste entry, recipe
 * editing. The float path has the same `1.005` problem `fromBaht` has, and
 * recipe quantities are typed by hand far more often than prices are.
 */
export function fromUnitString(input: string): Quantity {
  const m = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(input);
  if (!m) throw new QuantityError(`Not a valid decimal quantity: "${input}"`);

  const [, sign, whole, frac = ""] = m;
  const milliPart = (frac + "000").slice(0, 3);
  const beyond = frac.slice(3);

  let total = Number(whole!) * MILLI + Number(milliPart);
  // Round half away from zero on anything below milli-unit precision.
  if (beyond !== "" && Number(beyond[0]) >= 5) total += 1;

  return quantity(sign === "-" ? -total : total);
}

/** Display only. Never feed the output of this back into a calculation. */
export function toUnits(q: Quantity): number {
  return q / MILLI;
}

/**
 * Format for the operator. Trailing zeros are trimmed because "4g" reads
 * faster than "4.000g" on a screen being glanced at during a rush, and this
 * number is never re-parsed.
 */
export function formatQty(q: Quantity, unit: Unit): string {
  const negative = q < 0;
  const abs = Math.abs(q);
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, "0").replace(/0+$/, "");
  const body = frac === "" ? `${whole}` : `${whole}.${frac}`;
  return `${negative ? "-" : ""}${body}${unit === "piece" ? "" : unit}`;
}

export function addQty(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b);
}

export function subQty(a: Quantity, b: Quantity): Quantity {
  return quantity(a - b);
}

export function sumQty(xs: readonly Quantity[]): Quantity {
  return quantity(xs.reduce<number>((acc, x) => acc + x, 0));
}

export function negateQty(a: Quantity): Quantity {
  return quantity(-a);
}

/** Multiply by a whole quantity (e.g. 3 × the matcha in one latte). */
export function scaleQty(a: Quantity, factor: number): Quantity {
  if (!Number.isInteger(factor)) throw new QuantityError(`Factor must be an integer, got ${factor}`);
  return quantity(a * factor);
}

/**
 * How many whole drinks does `available` cover, at `per` each?
 *
 * Floors, because half a latte is not a thing you can sell. Returns
 * `Infinity` when the recipe needs none of an ingredient, so that a
 * "how many can I make" fold over several ingredients is not accidentally
 * capped by an ingredient the drink does not use.
 */
export function howManyFit(available: Quantity, per: Quantity): number {
  if (per < 0) throw new QuantityError("Per-unit requirement cannot be negative");
  if (per === 0) return Infinity;
  if (available <= 0) return 0;
  return Math.floor(available / per);
}
