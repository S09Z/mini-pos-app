import { useCallback, useEffect, useMemo, useState } from "react";
import { db, seedIfEmpty, type MenuItemRecord, type SaleRecord } from "./db/schema.js";
import { checkout, type CartLine } from "./db/sales.js";
import { voidSale } from "./db/voids.js";
import {
  ingredientsSorted,
  onHandMap,
  requirementsByMenuItem,
  recordWaste,
  recordPurchase,
  recordCount,
} from "./db/stock.js";
import { buildDayView, loadDayData, recordCashCount, tradingDays } from "./db/day.js";
import { bangkokToday } from "./day/period.js";
import { salesCsv, saleLinesCsv, daySummaryCsv } from "./day/csv.js";
import { menuStockByItem } from "./stock/availability.js";
import { quantity } from "./stock/units.js";
import { stockStatus } from "./stock/ledger.js";
import { priceListFor } from "./channel/pricing.js";
import type { ChannelPrice } from "./channel/types.js";
import { WALK_IN } from "./channel/types.js";
import { satang, type Satang } from "./money.js";
import { useLiveQuery } from "./ui/useLiveQuery.js";
import { RailNav, type Tab } from "./ui/RailNav.js";
import { MenuGrid } from "./ui/MenuGrid.js";
import { Ticket } from "./ui/Ticket.js";
import { CashTenderScreen } from "./ui/CashTenderScreen.js";
import { DoneScreen } from "./ui/DoneScreen.js";
import { VoidDialog } from "./ui/VoidDialog.js";
import { StockScreen, type StockActions } from "./ui/StockScreen.js";
import { DayScreen, type DayActions } from "./ui/DayScreen.js";
import { PayoutsScreen, type PayoutActions } from "./ui/PayoutsScreen.js";
import { ChannelBar } from "./ui/ChannelBar.js";
import { downloadText } from "./ui/download.js";
import {
  allBatches,
  buildBatchView,
  importStatement,
  recordDeposit,
  reopenException,
  resolveException,
} from "./db/payouts.js";

type Screen = { name: "sell" } | { name: "tender" } | { name: "done"; sale: SaleRecord };

export function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("sell");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: "sell" });
  const [voiding, setVoiding] = useState<SaleRecord | null>(null);
  const [day, setDay] = useState(() => bangkokToday());
  const [channelId, setChannelId] = useState<string>(WALK_IN.id);
  const [platformOrderId, setPlatformOrderId] = useState("");
  /** A refused checkout has to be visible; silently doing nothing is worse than the error. */
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  useEffect(() => {
    seedIfEmpty()
      .then(() => setReady(true))
      .catch((err: unknown) => console.error("seedIfEmpty failed", err));
  }, []);

  const menuItems = useLiveQuery(
    () => (ready ? db.menu_items.orderBy("sortOrder").toArray() : []),
    [ready],
  );

  const ingredients = useLiveQuery(() => (ready ? ingredientsSorted() : []), [ready]);
  const channels = useLiveQuery(() => (ready ? db.channels.orderBy("sortOrder").toArray() : []), [ready]);

  /**
   * Prices resolved per channel, tagged with the channel they were computed
   * for.
   *
   * The tag is load-bearing. `useLiveQuery` keeps the previous value while it
   * re-reads, so for a moment after switching channels the map still holds
   * counter prices — and a tap in that window would capture the counter price
   * into the cart permanently. That is the exact failure the channel indicator
   * exists to prevent, so the grid stays inert until the map catches up rather
   * than trusting a race to resolve in time.
   */
  const priceList = useLiveQuery(async () => {
    if (!ready) return null;
    const [items, rows] = await Promise.all([
      db.menu_items.orderBy("sortOrder").toArray(),
      db.channel_prices.toArray(),
    ]);
    const domainPrices: ChannelPrice[] = rows.map((r) => ({
      menuItemId: r.menuItemId,
      channelId: r.channelId,
      price: r.priceSatang as Satang,
      validFrom: r.validFrom,
      validTo: r.validTo,
    }));
    return { channelId, prices: priceListFor(domainPrices, items, channelId, new Date()) };
  }, [ready, channelId]);

  const pricesReady = priceList != null && priceList.channelId === channelId;

  // Re-reads whenever a movement lands, so depleting stock updates the tiles
  // without the sell screen knowing anything about the ledger.
  const stockView = useLiveQuery(async () => {
    if (!ready) return null;
    const [onHand, requirements, allIngredients] = await Promise.all([
      onHandMap(),
      requirementsByMenuItem(),
      ingredientsSorted(),
    ]);
    const reorderPoints = new Map(allIngredients.map((i) => [i.id, quantity(i.reorderPoint)]));
    return {
      byItem: menuStockByItem(requirements, onHand, reorderPoints),
      names: new Map(allIngredients.map((i) => [i.id, i.name])),
    };
  }, [ready]);

  // Re-reads whenever a sale, void, or cash count lands.
  const dayView = useLiveQuery(() => (ready ? buildDayView(day) : null), [ready, day]);
  const days = useLiveQuery(() => (ready ? tradingDays() : []), [ready]);

  const total = useMemo(
    () => cart.reduce((acc, l) => acc + l.unitPriceSatang * l.qty, 0) as Satang,
    [cart],
  );

  const activeChannel = channels?.find((c) => c.id === channelId);
  const isDelivery = channelId !== WALK_IN.id;

  const batches = useLiveQuery(() => (ready ? allBatches() : []), [ready]);
  // Default to the newest batch, but follow the operator's choice once made.
  const activeBatchId = batchId ?? batches?.[0]?.id ?? null;
  const batchView = useLiveQuery(
    () => (ready && activeBatchId !== null ? buildBatchView(activeBatchId) : null),
    [ready, activeBatchId],
  );

  const payoutActions: PayoutActions = useMemo(
    () => ({
      importStatement: async (forChannel, fileName, text) => {
        const { batchId: created } = await importStatement(forChannel, fileName, text);
        setBatchId(created);
      },
      resolveException: async (exceptionId, reason, note) => {
        await resolveException(exceptionId, reason, note);
      },
      reopenException: async (exceptionId) => {
        await reopenException(exceptionId);
      },
      recordDeposit: async (forBatch, deposit) => {
        await recordDeposit(forBatch, deposit);
      },
    }),
    [],
  );

  /** Surfaced on the rail so a low tin is visible from the sell screen. */
  const stockAlert = useMemo(() => {
    if (!ingredients) return undefined;
    const out = ingredients.filter(
      (i) => stockStatus(quantity(i.onHand), quantity(i.reorderPoint)) === "OUT",
    ).length;
    const low = ingredients.filter(
      (i) => stockStatus(quantity(i.onHand), quantity(i.reorderPoint)) === "LOW",
    ).length;
    if (out > 0) return { stock: String(out) };
    if (low > 0) return { stock: String(low) };
    return undefined;
  }, [ingredients]);

  const addItem = useCallback((item: MenuItemRecord, price: Satang) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.menuItemId === item.id);
      if (existing) {
        return prev.map((l) => (l.menuItemId === item.id ? { ...l, qty: l.qty + 1 } : l));
      }
      // The channel's price, not the counter price — see channel/pricing.ts.
      return [...prev, { menuItemId: item.id, name: item.name, unitPriceSatang: price, qty: 1 }];
    });
  }, []);

  const incrementLine = useCallback((menuItemId: string) => {
    setCart((prev) => prev.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty + 1 } : l)));
  }, []);

  const decrementLine = useCallback((menuItemId: string) => {
    setCheckoutError(null);
    setCart((prev) =>
      prev
        .map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty - 1 } : l))
        .filter((l) => l.qty > 0),
    );
  }, []);

  const stockActions: StockActions = useMemo(
    () => ({
      recordWaste: async (id, qty, reason) => {
        await recordWaste(id, qty, reason);
      },
      recordPurchase: async (id, qty, totalCost) => {
        await recordPurchase(id, qty, totalCost);
      },
      recordCount: async (id, counted) => {
        await recordCount(id, counted);
      },
    }),
    [],
  );

  const dayActions: DayActions = useMemo(
    () => ({
      recordCount: async (expected, declared, note) => {
        await recordCashCount(day, expected, declared, note);
      },
      exportCsv: async (forDay) => {
        const [{ sales, lines }, view] = await Promise.all([
          loadDayData(forDay),
          buildDayView(forDay),
        ]);
        const voidedSaleIds = new Set(view.report.voids.map((v) => v.saleId));
        const { totals } = view.report;

        // Three files rather than one: an accountant wants the detail and the
        // headline in separate sheets, and mixing schemas in one CSV is what
        // produces follow-up questions.
        downloadText(`${forDay}-summary.csv`, daySummaryCsv({
          day: forDay,
          gross: totals.gross,
          net: totals.net,
          vat: totals.vat,
          costOfGoods: totals.costOfGoods,
          contribution: totals.contribution,
          contributionMarginBp: totals.contributionMarginBp,
          costComplete: totals.costComplete,
          uncostedLines: totals.uncostedLines,
          saleCount: totals.saleCount,
          itemCount: totals.itemCount,
          voidCount: totals.voidCount,
          voidedValue: totals.voidedValue,
          expectedCash: view.report.expectedCash,
          declaredCash: view.cashCount === null ? null : satang(view.cashCount.declaredSatang),
          cashVariance: view.cashCount === null ? null : satang(view.cashCount.varianceSatang),
        }));
        setTimeout(() => downloadText(`${forDay}-sales.csv`, salesCsv(sales, voidedSaleIds)), 300);
        setTimeout(
          () => downloadText(`${forDay}-sale-lines.csv`, saleLinesCsv(sales, lines, voidedSaleIds)),
          600,
        );
      },
    }),
    [day],
  );

  async function handleRecordDeliveryOrder() {
    setCheckoutError(null);
    try {
      const { sale } = await checkout(cart, total, {
        channelId,
        platformOrderId: platformOrderId.trim(),
      });
      setScreen({ name: "done", sale });
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Could not record that order");
    }
  }

  async function handleConfirmTender(tendered: Satang) {
    setCheckoutError(null);
    try {
      const { sale } = await checkout(cart, tendered, {
        channelId,
        ...(platformOrderId.trim() === "" ? {} : { platformOrderId: platformOrderId.trim() }),
      });
      setScreen({ name: "done", sale });
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Could not complete that sale");
      setScreen({ name: "sell" });
    }
  }

  function handleNewSale() {
    setCart([]);
    setPlatformOrderId("");
    setScreen({ name: "sell" });
  }

  async function handleVoidConfirm(pin: string) {
    if (!voiding) return;
    await voidSale(voiding.id, pin);
    setVoiding(null);
    handleNewSale();
  }

  if (!ready || menuItems === undefined || ingredients === undefined || stockView === undefined) {
    return <div className="flex h-full items-center justify-center text-15 opacity-60">Loading…</div>;
  }

  return (
    <div className="flex h-screen w-screen">
      <RailNav
        active={tab}
        onNavigate={(next) => {
          setTab(next);
          // Leaving mid-tender would strand a ticket; go back to a clean sell screen.
          if (next === "sell") setScreen({ name: "sell" });
        }}
        {...(stockAlert ? { alert: stockAlert } : {})}
      />

      {tab === "stock" && <StockScreen ingredients={ingredients ?? []} actions={stockActions} />}

      {tab === "payouts" && (
        <PayoutsScreen
          channels={channels ?? []}
          batches={batches ?? []}
          view={batchView ?? null}
          selectedBatchId={activeBatchId}
          onSelectBatch={setBatchId}
          actions={payoutActions}
        />
      )}

      {tab === "day" &&
        (dayView == null ? (
          <div className="flex flex-1 items-center justify-center text-15 opacity-60">Loading…</div>
        ) : (
          <DayScreen
            view={dayView}
            day={day}
            days={days ?? []}
            onSelectDay={setDay}
            actions={dayActions}
          />
        ))}

      {tab === "sell" && screen.name === "sell" && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChannelBar
            channels={channels ?? []}
            activeId={channelId}
            onSelect={setChannelId}
            platformOrderId={platformOrderId}
            onPlatformOrderIdChange={setPlatformOrderId}
            locked={cart.length > 0}
          />
          <div className="flex flex-1 overflow-hidden">
            <MenuGrid
              items={menuItems}
              stock={stockView?.byItem ?? new Map()}
              prices={pricesReady ? priceList.prices : new Map()}
              ingredientNames={stockView?.names ?? new Map()}
              onSelect={addItem}
              warnOnCounterPrice={isDelivery}
              disabled={!pricesReady}
            />
            <Ticket
              cart={cart}
              onIncrement={incrementLine}
              onDecrement={decrementLine}
              onCharge={() => {
                // Delivery is already paid for at the platform; there is no
                // cash to count, so it books straight through.
                if (isDelivery) void handleRecordDeliveryOrder();
                else setScreen({ name: "tender" });
              }}
              isDelivery={isDelivery}
              {...(activeChannel ? { channelName: activeChannel.name } : {})}
              {...(checkoutError !== null
                ? { blockedReason: checkoutError }
                : isDelivery && platformOrderId.trim() === ""
                  ? { blockedReason: "Enter the platform order number before recording this order." }
                  : {})}
            />
          </div>
        </div>
      )}

      {tab === "sell" && screen.name === "tender" && (
        <CashTenderScreen
          total={total}
          onConfirm={handleConfirmTender}
          onCancel={() => setScreen({ name: "sell" })}
        />
      )}

      {tab === "sell" && screen.name === "done" && (
        <DoneScreen sale={screen.sale} onNewSale={handleNewSale} onVoid={() => setVoiding(screen.sale)} />
      )}

      {voiding && (
        <VoidDialog sale={voiding} onConfirm={handleVoidConfirm} onCancel={() => setVoiding(null)} />
      )}
    </div>
  );
}
