# CLAUDE.md

Offline-first matcha POS, PWA on iPad. This repo currently holds the **domain
layer only** — pure Thai VAT and delivery-commission logic, no I/O, no UI.

Read `PLAN.md` for what phase we are in before proposing work. Read
`DESIGN.md` before writing any UI.

**Current phase: 1 — the sell screen.** Phase 0 (domain) is done.

## Commands

```bash
pnpm install
pnpm check        # typecheck + tests — the gate, run before declaring done
pnpm test         # vitest run
pnpm test:watch
pnpm typecheck
```

pnpm only. Do not run `npm` or `yarn` — it will produce a competing lockfile.

## Non-negotiable rules

These are not style preferences. Breaking one produces a bug that is invisible
per sale and unreconcilable at month end.

1. **Money is `Satang`, always.** Integer satang, branded type. Never a float,
   never a raw `number`, never `price * 1.07`. If you find yourself writing a
   decimal amount, use `fromBahtString()`.

2. **Never compute VAT per line.** Extract at the document level, then
   allocate down with `allocate()`. There is a test proving why: three ฿0.05
   lines yield 0 satang per-line but 1 satang correctly at document level.

3. **Never hardcode 7% or 700.** The rate is a function of the sale date. Call
   `rateAt("VAT_TH", date)`. Thailand's statutory rate is 10%; the 7% exists
   only by renewable royal decree.

4. **Sales are append-only.** Do not write an `updateSale` or `deleteSale`. A
   void is a new compensating record pointing at the original. This is how
   theft becomes visible.

5. **Freeze the rate onto the sale.** Store `rateBp` and `authority` on the
   record. Reprints render stored values and never recompute at today's rate.

6. **The network is never in the critical path of a sale.** Every feature must
   work in airplane mode. Local (Dexie) is the source of truth; sync is backup.

7. **Never issue a tax invoice when `vatRegistered` is false.** The domain
   layer already blocks this. Do not add a UI override — it is an offence.

## Code conventions

- Imports use explicit `.js` extensions (`./money.js`), including for `.ts`
  files. Keep it consistent.
- `verbatimModuleSyntax` is on: type-only imports need `import type`.
- `noUncheckedIndexedAccess` is on: `arr[i]` is `T | undefined`. The `!` in
  existing code is deliberate after a bounds check, not laziness.
- `exactOptionalPropertyTypes` is on: you cannot pass an explicit `undefined`
  to an optional property. Omit the key instead.
- Rounding on money goes **half away from zero**, so a refund is the exact
  negation of its sale. Bare `Math.round` is asymmetric for negatives — use
  the helpers in `money.ts`.
- Domain modules stay pure. No React, no Dexie, no `fetch` in `src/money.ts`,
  `src/tax/**`, or `src/channel/**`.

## Testing

- Every rule gets a test before it gets a UI.
- Tests sit beside their module as `*.test.ts`.
- Prefer invariant and property-style tests over single examples — loop over a
  range and assert `net + vat === gross` rather than checking one amount.
- When a test fails, check the expectation before changing the code. Several
  of the existing tests caught wrong hand-arithmetic in the *test*, not the
  module.

## Layout

```
src/
├── money.ts              Satang type, arithmetic, largest-remainder allocation
├── tax/rates.ts          Dated VAT lookup, Bangkok-local decree boundaries
├── tax/vat.ts            Inclusive extraction, document VAT, threshold watchdog
├── channel/types.ts      Channel / GP / per-channel price / recipe override
└── channel/settlement.ts Commission, payout, contribution, break-even price
```

Phase 1 adds `src/db/` (Dexie) and `src/ui/`. Keep the domain layer free of
both.

## Ask before

- Adding any dependency. The domain layer has zero runtime deps and should
  stay that way.
- Changing a rate in `TH_VAT_RATES`. Add a new dated row; never edit an old
  one, or historical receipts stop reproducing.
- Changing `gpBasis` or `gpAppliesTo` defaults. They encode a contract reading,
  not a guess to be tidied.
- Building anything from a later phase. Scope creep in Phase 1 delays the
  feedback that determines Phase 2.

## Gotchas

- `fromBaht(1.005)` returns 100, not 101 — `1.005 * 100` is
  `100.49999999999999` in IEEE754. This is pinned by a test on purpose. Use
  `fromBahtString()` at input boundaries.
- `rateAt` past the last known decree returns the previous rate with
  `provisional: true` rather than throwing. The UI must render that flag.
- Decree boundaries are `+07:00` instants. A sale at 00:30 ICT on 1 October is
  30 September in UTC — do not compare naive dates.
- Delivery commission defaults to the harsher contract reading: GP on the
  VAT-inclusive list price, charged before merchant-funded discounts.

## Out of scope

Not accountancy advice. POS machine approval, abbreviated tax invoice fields,
and withholding tax treatment depend on Revenue Department practice. Flag
these for a Thai accountant rather than guessing in code or in comments.
