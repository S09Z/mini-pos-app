import { useCallback, useEffect, useMemo, useState } from "react";
import { db, seedIfEmpty, type MenuItemRecord, type SaleRecord } from "./db/schema.js";
import { checkout, type CartLine } from "./db/sales.js";
import { voidSale } from "./db/voids.js";
import type { Satang } from "./money.js";
import { useLiveQuery } from "./ui/useLiveQuery.js";
import { RailNav } from "./ui/RailNav.js";
import { MenuGrid } from "./ui/MenuGrid.js";
import { Ticket } from "./ui/Ticket.js";
import { CashTenderScreen } from "./ui/CashTenderScreen.js";
import { DoneScreen } from "./ui/DoneScreen.js";
import { VoidDialog } from "./ui/VoidDialog.js";

type Screen = { name: "sell" } | { name: "tender" } | { name: "done"; sale: SaleRecord };

export function App() {
  const [ready, setReady] = useState(false);
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

  const total = useMemo(
    () => cart.reduce((acc, l) => acc + l.unitPriceSatang * l.qty, 0) as Satang,
    [cart],
  );

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

  if (!ready || menuItems === undefined) {
    return <div className="flex h-full items-center justify-center text-15 opacity-60">Loading…</div>;
  }

  return (
    <div className="flex h-screen w-screen">
      <RailNav />

      {screen.name === "sell" && (
        <>
          <MenuGrid items={menuItems} onSelect={addItem} />
          <Ticket
            cart={cart}
            onIncrement={incrementLine}
            onDecrement={decrementLine}
            onCharge={() => setScreen({ name: "tender" })}
          />
        </>
      )}

      {screen.name === "tender" && (
        <CashTenderScreen
          total={total}
          onConfirm={handleConfirmTender}
          onCancel={() => setScreen({ name: "sell" })}
        />
      )}

      {screen.name === "done" && (
        <DoneScreen sale={screen.sale} onNewSale={handleNewSale} onVoid={() => setVoiding(screen.sale)} />
      )}

      {voiding && (
        <VoidDialog sale={voiding} onConfirm={handleVoidConfirm} onCancel={() => setVoiding(null)} />
      )}
    </div>
  );
}
