# PLAN.md

Phased build plan for `mini-pos-app`.

Phases are ordered so that **each one is usable on a real counter before the
next one starts**. A phase is not done when the code is written; it is done
when you have sold matcha with it and found nothing that stops you.

Resist building ahead. The stock module you design before running a single
real sale will be wrong in ways you cannot predict from a chair.

---

## Rules that apply to every phase

1. **The network is never in the critical path of a sale.** Every phase must
   keep working with the iPad in airplane mode.
2. **Sales are append-only.** Never `UPDATE` or `DELETE` a sale. A void is a
   new compensating record pointing at the original.
3. **`pnpm check` passes before merge.** Typecheck and tests, no exceptions.
4. **Money is `Satang`.** If a raw `number` appears in a monetary path, that is
   a bug, and the type system should have caught it.
5. **Every new rule gets a test before it gets a UI.** The domain layer is
   where correctness lives; the UI is a window onto it.

---

## Phase 0 — Domain core ✅ *done*

**Goal** Get the expensive-to-fix rules right while they are cheap to test.

**Built** `money.ts`, `tax/rates.ts`, `tax/vat.ts`, `channel/types.ts`,
`channel/settlement.ts`. 74 tests, typecheck clean.

**Done when** ✅ Invariants hold: `net + vat === gross`, line VAT ties to
document VAT, refunds mirror sales exactly.

---

## Phase 1 — Sell it

**Goal** Replace the cash box and the notebook. Nothing else.

**Build**
- Vite + React + TypeScript + Tailwind, `vite-plugin-pwa`, installed to the
  iPad Home Screen
- Dexie schema: `menu_items`, `sales`, `sale_lines`, `voids`
- Sell screen: tap item → cart → cash tender → change due → done
- Sequential receipt numbers with a device prefix (`A-1043`), generated
  locally so offline terminals never collide
- Void as a compensating record, owner PIN required

**Explicitly not** stock, reports, delivery, VAT UI, sync, accounts.

**Done when** You have run a full trading day on it and not reached for the
notebook once.

**Risk** Scope creep. Every feature you add here delays the feedback that
tells you what to build next.

---

## Phase 2 — Know your stock

**Goal** Answer "how much matcha do I have left" without opening the tin.

**Build**
- `ingredients` (unit, on-hand, reorder point, cost) and `recipe_lines`
  (bill of materials, with the `channelId` override already in the schema)
- Depletion on sale: one latte removes 4g matcha, 200ml milk, 1 cup
- `waste` events — spilled, expired, staff drink. Without this, counts drift
  and you will never learn why
- Purchase entry, so cost-per-unit stays current
- Low-stock badge on the menu tile; sold-out disables it

**Done when** A physical count of your matcha tin matches the app to within
one day's tolerance, twice in a row.

**Risk** Modelling stock on products instead of ingredients. You do not stock
lattes.

---

## Phase 3 — Close the day

**Goal** Know whether the day made money, and whether the cash is all there.

**Build**
- Z-report: sales, voids, discounts, COGS, gross margin, by hour
- Cash drawer reconciliation — declared count vs expected, variance recorded
  as its own event, never silently corrected
- Void audit: voids grouped by staff PIN, flagged when clustered
- CSV export for your accountant

**Done when** You can hand the export to an accountant and they ask no
follow-up questions.

**Risk** Reporting revenue instead of contribution. Revenue is the number that
feels good and tells you least.

---

## Phase 4 — Delivery channels

**Goal** Sell on Grab / LineMan / ShopeeFood without guessing at the margin.

**Build**
- Channel switch on the sell screen; `channel_prices` per menu item
- Manual order entry from the platform tablet (a real workflow — most small
  stalls key these in)
- Delivery packaging via the channel-scoped recipe override
- Wire `settlement.ts` into the dashboard: contribution by channel, sorted by
  contribution and never by revenue
- Surface `breakEvenListPrice` as a pricing tool

**Done when** You can answer "should I raise my Grab price" with a number
rather than a feeling.

**Risk** Trusting the default `gpBasis` / `gpAppliesTo`. Read your contract
and set them.

---

## Phase 5 — Reconcile the payouts

**Goal** Confirm the platform paid you what it owed. This is where money
actually leaks.

**Build**
- Per-platform statement importer — parse defensively, never assume column
  order, formats change without notice
- Match on `platformOrderId`; `payout_batches` so every sale traces to a deposit
- Exceptions queue for unmatched rows (cancellations, refunds, adjustments)
- `merchantFundedDiscount` captured separately from platform-funded promos

**Done when** A full payout cycle reconciles to zero unexplained variance.

**Risk** Treating unmatched rows as noise. They are the finding, not the mess.

---

## Phase 6 — VAT mode

**Goal** Be ready before the threshold, not after.

**Build**
- Registration switch driving `vatRegistered` end to end
- Trailing-12-month watchdog with a warning well before 1.8M THB
- Abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) layout with machine number
- Full tax invoice flow — customer name, address, tax ID — for expensing
- Provisional-rate banner when `rateAt` returns `provisional: true`
- PP.30 aggregation: output VAT, input VAT, payable

**Done when** An accountant has reviewed the invoice layout and your first
PP.30 draft.

**Risk** Shipping a tax invoice while unregistered. The domain layer blocks
it; do not add a UI override.

**Before you build** POS machine approval with the Revenue Department, and
confirmation of the abbreviated invoice field requirements.

---

## Phase 7 — Sync and backup

**Goal** Survive the iPad being dropped, stolen, or drowned in oat milk.

**Build**
- Supabase project (separate prod project, migrations in version control)
- Outbox pattern: every mutation writes locally and queues; a worker drains it
- Client-generated UUIDs as idempotency keys, so a retry cannot duplicate a sale
- Row Level Security written as if the anon key is already public — it is
- Automated daily backup, **and one rehearsed restore**

**Done when** You have wiped the iPad, reinstalled, and recovered every sale.

**Risk** Letting sync become a dependency. Local is the source of truth.

---

## Phase 8 — Harden

**Goal** Make it boring.

**Build**
- Staff vs owner roles; PINs hashed with argon2, never stored in plain text
- Sentry — you will not be reading logs during a rush
- CI: typecheck → tests → Playwright sell-flow → Lighthouse, with thresholds
  that fail the build
- Performance budget enforced: tap feedback under 100ms, cold start under 2s,
  bundle under 200KB gzipped
- Service worker update prompt — never auto-reload mid-transaction
- Guided Access enabled on the iPad so the app cannot be exited during service

**Done when** A week passes without you thinking about the app.

---

## Later, maybe never

Listed so they stop occupying attention:

- Multi-terminal / second iPad
- Customer loyalty
- PromptPay QR with automatic payment confirmation
- Printed receipts (a thermal printer is a real cost and a real failure point)
- Purchase orders and supplier management
- Payroll

Each of these is a phase-sized project. None is worth starting before Phase 5
reconciles cleanly.

---

## Sequencing note

VAT logic landed in Phase 0 and VAT *UI* lands in Phase 6. That is deliberate:
the rules were cheap to encode and expensive to retrofit, but you are probably
below the registration threshold today, and a compliance UI you cannot legally
use is dead weight on the sell screen.

The same logic explains why delivery (Phase 4) comes after day-close (Phase 3):
you cannot judge whether a delivery order was worth taking until you can
measure what a counter sale is worth.
