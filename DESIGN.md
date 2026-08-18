# DESIGN.md

Design brief for `mini-pos-app`. Written to be handed to Claude Design.

---

## The subject, honestly

A one-person matcha stall in Bangkok. One iPad, landscape, propped on a
counter beside the whisk and the milk jug. The operator is standing, often
with one wet hand, with a customer's eyes on them. Ambient light is bright —
sometimes direct sun through a shopfront. There are four or five drinks, and
the operator knows all of them by heart.

**The screen's single job: register a sale in under four seconds without the
operator looking away from the customer for more than a glance.**

Everything below follows from that sentence. A POS is not a dashboard. It is
an instrument, closer to a cash drawer or a scale than to a web app.

---

## Direction

Matcha's world is one of **measured craft**: grams on a scale, water at 80°C,
a fixed number of whisk strokes. The visual language should borrow that
precision rather than the obvious wellness-café softness — no rounded pastel
tiles, no leaf motifs, no gradient greens.

So: a near-white ground with hairline structure and heavy, confident type.
Green appears almost nowhere. It is reserved for **money and confirmation
only** — the way the whisked tea is the one saturated thing on a grey stone
tray. If green is on the chrome, it stops meaning anything.

**Take this risk:** the running total is set as a mechanical scoreboard —
enormous expanded numerals, the satang at reduced size — and the digits roll
vertically for 90ms when the total changes. Justified because the operator's
eyes are on the customer, and peripheral motion confirms a tap landed without
requiring a look. It is the one animated element in the product. Respect
`prefers-reduced-motion` by cross-fading instead.

---

## Tokens

### Color

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#16180F` | Text, primary buttons. Near-black with a faint green cast |
| `--paper` | `#F2F3EE` | Background. Cool grey-green, deliberately not a warm cream |
| `--rule` | `#D6D8CE` | Hairlines, tile borders, table dividers |
| `--matcha` | `#6F8F1F` | Money figures, confirm actions. **Nothing else.** |
| `--koicha` | `#2E3D14` | Pressed and active states |
| `--beni` | `#B33A2B` | Void, refund, destructive. Never for errors that aren't destructive |
| `--kincha` | `#C08A1E` | Warnings: low stock, provisional VAT rate, stale sync |

No dark mode. The stall is bright; a dark UI in sunlight is unreadable, and
maintaining two themes for one device is waste.

Body text against `--paper` must clear **7:1** contrast, not 4.5:1. Sunlight
eats the difference.

### Type

| Role | Face | Notes |
|---|---|---|
| Money & display | **Archivo** (variable) | Expanded width, weight 700+, `font-variant-numeric: tabular-nums`. Always tabular — a total that shifts sideways as digits change is a bug |
| UI & Thai | **IBM Plex Sans Thai Looped** | Looped Thai reads faster at UI sizes than loopless. Pairs with Plex's squared Latin terminals |
| Data & receipts | **IBM Plex Mono** | Audit tables, receipt preview, reconciliation columns |

Thai needs roughly 1.5× the line-height of Latin to keep tone marks clear.
Set `line-height: 1.6` on any block that may contain Thai, and never clip
ascenders with a tight fixed row height.

Scale (points, iPad logical): 11 / 13 / 15 / 18 / 24 / 34 / 88.
The 88 is the total. Nothing else may use it.

### Spacing & shape

4pt base grid. Radius: 4pt on tiles and inputs, 0 on rules and table cells.
No shadows — use hairlines. Shadows read as web; this should read as hardware.

---

## Layout

Design at **1180 × 820** (iPad Air 11", landscape). Portrait is out of scope;
the stand is fixed.

```
┌────┬───────────────────────────────┬──────────────────────┐
│    │                               │  TICKET              │
│ ▣  │   ┌────────┐  ┌────────┐      │  ──────────────────  │
│    │   │        │  │        │      │  Iced Matcha    ฿80  │
│ ▤  │   │ Usucha │  │  Iced  │      │  Hojicha        ฿75  │
│    │   │  ฿80   │  │  ฿80   │      │                      │
│ ▥  │   └────────┘  └────────┘      │                      │
│    │                               │                      │
│ ▦  │   ┌────────┐  ┌────────┐      │  ──────────────────  │
│    │   │Hojicha │  │ Matcha │      │  TOTAL               │
│    │   │  ฿75   │  │  Latte │      │      ฿155.00         │
│ ●  │   └────────┘  └────────┘      │  ┌────────────────┐  │
│Local│                              │  │   Charge ฿155  │  │
└────┴───────────────────────────────┴──────────────────────┘
 88pt          flexible                       400pt
```

- **Left rail, 88pt** — Sell / Stock / Day / Settings, plus a connection dot
  pinned to the bottom.
- **Centre** — menu grid. With 4–5 items, tiles are large: minimum **160 ×
  160pt**. Do not shrink them to fill a grid designed for fifty products.
- **Right, 400pt** — the ticket. Total and the charge button anchored to the
  bottom, inside comfortable thumb reach for a right-handed operator standing
  at the counter.

Touch targets: 44pt absolute minimum, 72pt for anything tapped during a rush.
Wet hands and speed both cost accuracy.

**No hover states.** There is no cursor. Design the pressed state instead, and
make it unmistakable — 100ms, `--koicha` fill, no transition on the way in.

---

## Screens to generate

1. **Sell — empty ticket.** The resting state. This is what the operator sees
   most of the day, so it must look calm rather than expectant.
2. **Sell — three items in the ticket.** Shows quantity stepping, line removal,
   and the scoreboard at a realistic value.
3. **Cash tender.** Numeric pad, amount tendered, and **change due** as a
   second scoreboard — the operator reads this aloud, so it is the largest
   thing on screen at that moment.
4. **Day close.** Declared cash count vs expected, variance stated plainly,
   sales and contribution summary. Contribution above revenue in the hierarchy.
5. **Stock.** Ingredient list with on-hand, reorder point, and a low-stock
   state. Include the "record waste" action — it must be as easy to reach as
   selling, or it will never be used.
6. **Sell — delivery channel active** *(Phase 4)*. Same screen with the
   channel switched to GrabFood: prices change, and a persistent channel
   indicator makes it impossible to ring a delivery order at counter prices.

---

## States that must be designed

**Offline is normal, not an error.** The app is offline-first. Show a quiet
`Local` dot in the rail. Only escalate to `--kincha` when sync is more than 24
hours stale, and never block a sale on it. A red offline warning during
service teaches the operator to ignore warnings.

**Provisional VAT rate.** When `rateAt` returns `provisional: true`, a thin
`--kincha` bar above the ticket: "VAT rate unconfirmed — check for a new
decree." Persistent, dismissible for the session, not modal.

**Sold out.** Tile drops to 40% opacity with a rule through the price. Still
visible — the operator needs to know it exists to tell the customer.

**Void.** Requires the owner PIN. The confirm step must state what is being
reversed in full ("Void sale A-1043, ฿155.00") because this is the one action
with no undo.

**Empty stock, empty day, first run.** Each is an invitation to act, not an
apology. "No sales yet today" with the sell button, not a shrug.

---

## Copy

Sentence case. Active voice. The button names the outcome.

| Write | Not |
|---|---|
| Charge ฿155 | Submit / Confirm order |
| Void sale | Delete / Cancel |
| Record waste | Adjust inventory |
| Count the drawer | Reconciliation |
| VAT rate unconfirmed — check for a new decree | Warning: tax configuration issue |

An action keeps its name through the whole flow: the button that says
**Charge** produces a receipt headed **Charged**.

Thai and English both appear. Menu item names are whatever the operator typed;
system copy is English by default with Thai available. Never machine-translate
tax terms — ใบกำกับภาษีอย่างย่อ is a legal term of art and must appear
verbatim on the invoice.

---

## Do not

- Modals for anything done more than twice a day. They cost a tap and break
  the flow.
- Toasts for confirmation. The scoreboard changing *is* the confirmation.
- Icon-only buttons for money actions. Label them.
- A search field. There are five drinks.
- Green chrome, leaf illustrations, or a wellness-café palette. Green means
  money here, and only money.
- Skeleton loaders. Local reads from Dexie are instant; a skeleton implies a
  latency that should not exist. If something is genuinely slow, that is a bug
  to fix rather than a state to design.

---

## Quality floor

Visible keyboard focus, `prefers-reduced-motion` respected, all text ≥7:1
against `--paper`, and no interaction that depends on colour alone — low stock
carries a label as well as `--kincha`.
