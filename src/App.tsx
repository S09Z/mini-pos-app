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
import { menuStockByItem } from "./stock/availability.js";
import { quantity } from "./stock/units.js";
import { stockStatus } from "./stock/ledger.js";
import type { Satang } from "./money.js";
import { useLiveQuery } from "./ui/useLiveQuery.js";
import { RailNav, type Tab } from "./ui/RailNav.js";
import { MenuGrid } from "./ui/MenuGrid.js";
import { Ticket } from "./ui/Ticket.js";
import { CashTenderScreen } from "./ui/CashTenderScreen.js";
import { DoneScreen } from "./ui/DoneScreen.js";
import { VoidDialog } from "./ui/VoidDialog.js";
import { StockScreen, type StockActions } from "./ui/StockScreen.js";

type Screen = { name: "sell" } | { name: "tender" } | { name: "done"; sale: SaleRecord };

export function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("sell");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: "sell" });
  const [voiding, setVoiding] = useState<SaleRecord | null>(null);

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

  const total = useMemo(
    () => cart.reduce((acc, l) => acc + l.unitPriceSatang * l.qty, 0) as Satang,
    [cart],
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

  const addItem = useCallback((item: MenuItemRecord) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.menuItemId === item.id);
      if (existing) {
        return prev.map((l) => (l.menuItemId === item.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [
        ...prev,
        { menuItemId: item.id, name: item.name, unitPriceSatang: item.priceSatang as Satang, qty: 1 },
      ];
    });
  }, []);

  const incrementLine = useCallback((menuItemId: string) => {
    setCart((prev) => prev.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty + 1 } : l)));
  }, []);

  const decrementLine = useCallback((menuItemId: string) => {
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

  async function handleConfirmTender(tendered: Satang) {
    const { sale } = await checkout(cart, tendered);
    setScreen({ name: "done", sale });
  }

  function handleNewSale() {
    setCart([]);
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

      {tab === "sell" && screen.name === "sell" && (
        <>
          <MenuGrid
            items={menuItems}
            stock={stockView?.byItem ?? new Map()}
            ingredientNames={stockView?.names ?? new Map()}
            onSelect={addItem}
          />
          <Ticket
            cart={cart}
            onIncrement={incrementLine}
            onDecrement={decrementLine}
            onCharge={() => setScreen({ name: "tender" })}
          />
        </>
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
