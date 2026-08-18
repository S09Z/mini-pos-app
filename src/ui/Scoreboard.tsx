import { useEffect, useRef, useState } from "react";
import { formatTHB, type Satang } from "../money.js";

/**
 * The one animated element in the product (DESIGN.md). Digits roll vertically
 * for 90ms when the total changes, so a peripheral glance confirms a tap
 * landed without the operator looking away from the customer. Cross-fades
 * instead under `prefers-reduced-motion`.
 */
export function Scoreboard({ amount, size = "total" }: { amount: Satang; size?: "total" | "change" }) {
  const [animKey, setAnimKey] = useState(0);
  const prev = useRef(amount);

  useEffect(() => {
    if (prev.current !== amount) {
      prev.current = amount;
      setAnimKey((k) => k + 1);
    }
  }, [amount]);

  const [baht, satangPart] = formatTHB(amount).split(".");

  return (
    <div className="overflow-hidden" aria-live="polite">
      <div
        key={animKey}
        className={size === "total" ? "scoreboard-roll text-88 leading-none" : "scoreboard-roll text-34 leading-none"}
        style={{ fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}
      >
        {baht}
        <span className="text-24 align-top">.{satangPart}</span>
      </div>
    </div>
  );
}
