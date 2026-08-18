# mini-pos-app

Offline-first POS for a small matcha stall, running as a PWA on iPad.

This repository currently contains the **domain layer** — Thai VAT and
delivery-platform commission (GP) logic as pure, tested functions with no I/O
and no framework dependency. The UI, local database, and sync layers build on
top of it.

Built deliberately from the inside out: the money and tax rules are the part
that is expensive to get wrong and cheap to test, so they land first.

## Getting started

Requires Node 20+ and [pnpm](https://pnpm.io/installation).

```bash
corepack enable            # pnpm ships with Node — no global install needed
pnpm install
pnpm check                 # typecheck + tests
```

| Command | Does |
|---|---|
| `pnpm test` | Run the suite once |
| `pnpm test:watch` | Re-run on change |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check` | Both — use this as the CI gate |

Current status: **74 tests across 4 files, typecheck clean.**

`.npmrc` sets `strict-peer-dependencies` and disables `auto-install-peers`, so
a missing peer fails the install rather than resolving to something unexpected
at runtime. pnpm's non-flat `node_modules` also means an undeclared import
breaks immediately instead of working by accident until deploy.

## Documents

| File | What it is |
|---|---|
| `CLAUDE.md` | Working rules for coding agents — read this before changing code |
| `PLAN.md` | Phased build plan — what ships when, and what is deliberately deferred |
| `DESIGN.md` | Design brief: direction, tokens, layout, screens, states, copy |

## Layout

```
src/
├── money.ts              Branded Satang integer type, safe arithmetic, allocation
├── tax/
│   ├── rates.ts          Dated VAT lookup, Bangkok-local decree boundaries
│   └── vat.ts            Inclusive extraction, document VAT, registration watchdog
└── channel/
    ├── types.ts          Channel / GP / per-channel price / recipe override schema
    └── settlement.ts     Commission, payout, contribution margin, break-even price
```

Tests sit beside their modules as `*.test.ts`.

## Invariants the tests hold

- `net + vat === gross`, exactly, for every amount at every rate
- `sum(line.vat) === document.vat` — line figures are allocated *down* from the
  document total, never computed per line
- A refund is the exact negation of its sale (rounds half away from zero)
- Allocation is deterministic, so a reprint reproduces the original split

There is a test demonstrating why the second one matters: three ฿0.05 lines
yield 0 satang of VAT under naive per-line extraction, but 1 satang correctly
at document level. Invisible per receipt; unreconcilable across a year of
PP.30 filings.

## Four decisions worth knowing about

**Money is integer satang, never float.** `Satang` is a branded type, so a raw
`number` will not typecheck where an amount is expected. Use
`fromBahtString()` at every input boundary — price entry, CSV import, platform
statements. `fromBaht()` still has one foot in float land: `1.005 * 100` is
`100.49999999999999` in IEEE754, so it rounds down. There is a test pinning
that behaviour so nobody "fixes" it by accident.

**Rates are dated, never constant.** Thailand's statutory VAT is 10%; the 7%
exists only by royal decree, renewed roughly annually on a 1 Oct – 30 Sep
cycle. Boundaries are stored as `+07:00` instants because a sale rung at 00:30
ICT on 1 October is 30 September in UTC.

**Past the last known decree, the till keeps working.** `rateAt` carries the
last rate forward flagged `provisional: true` rather than blocking the sale or
silently jumping to 10%. A POS that refuses to sell because a decree has not
been keyed in is worse than one that flags an assumption — but that only holds
if the UI actually renders the flag.

**Unregistered is a hard block, not a display toggle.** Below the 1.8M THB
threshold, `computeDocumentVat` returns zero VAT and
`taxInvoiceEligible: false`. Issuing a tax invoice while unregistered is an
offence, so the domain layer refuses rather than trusting the UI to hide a
button.

## Wiring up

```ts
import { fromBahtString, formatTHB } from "./money.js";
import { rateAt, validateRateTable, TH_VAT_RATES } from "./tax/rates.js";
import { computeDocumentVat } from "./tax/vat.js";
import { settle, compareChannels } from "./channel/settlement.js";

validateRateTable(TH_VAT_RATES);            // once, at boot — fail loudly

const rate = rateAt("VAT_TH", new Date());
if (rate.provisional) showBanner("VAT rate unconfirmed — check for a new decree");

const doc = computeDocumentVat(cartLines, {
  rateBp: rate.rateBp,
  vatRegistered: profile.vatRegistered,
});

// Freeze rate.rateBp and rate.authority onto the sale record.
// Reprints must render stored values, never recompute at today's rate.
```

## Configure before trusting the GP numbers

`Channel.gpBasis` and `Channel.gpAppliesTo` default to the harsher reading:
commission on the VAT-inclusive list price, charged *before* merchant-funded
discounts. There is a test showing you are billed GP on ฿105 even when a promo
means you only received ฿85.

Platform contracts differ. Read yours and set these fields from it — the
difference is material.

## Roadmap

Phase 0 (this domain layer) is complete. Phase 1 is the Dexie schema and the
sell screen, so it can be used on a real counter.

See `PLAN.md` for all nine phases, what each one deliberately excludes, and
the "done when" test for each. See `DESIGN.md` before building any UI.

## Caveat

Not accountancy advice. POS machine approval, abbreviated tax invoice field
requirements, and withholding tax treatment depend on Revenue Department
practice and your legal form. Have a Thai accountant review the invoice layout
and your first PP.30 before relying on any of this.
