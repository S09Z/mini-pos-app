import { useState } from "react";
import { formatTHB, fromBahtString, sub, ZERO, type Satang } from "../money.js";
import { Scoreboard } from "./Scoreboard.js";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "00"] as const;

/** Numeric pad, amount tendered, and change due as a second scoreboard — read aloud, so it is the largest thing on screen. */
export function CashTenderScreen({
  total,
  onConfirm,
  onCancel,
}: {
  total: Satang;
  onConfirm: (tendered: Satang) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState(""); // raw satang digits, e.g. "15500" -> ฿155.00

  const tendered: Satang = digits === "" ? ZERO : fromBahtString((Number(digits) / 100).toFixed(2));
  const covered = tendered >= total;
  const changeDue = covered ? sub(tendered, total) : ZERO;

  function press(key: (typeof KEYS)[number]) {
    if (key === "⌫") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    setDigits((d) => (d + key).slice(0, 9));
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-center">
        <div className="text-13 tracking-wide opacity-60">TOTAL DUE</div>
        <div className="text-34 tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
          {formatTHB(total)}
        </div>
      </div>

      <div className="text-center">
        <div className="text-13 tracking-wide opacity-60">{covered ? "CHANGE DUE" : "TENDERED"}</div>
        <div className={covered ? "text-matcha" : ""}>
          <Scoreboard amount={covered ? changeDue : tendered} size="total" />
        </div>
      </div>

      <div className="grid w-[320pt] grid-cols-3 gap-2">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            className="h-[56pt] rounded-[4pt] border border-rule text-24 tabular-nums active:bg-koicha active:text-paper"
          >
            {key}
          </button>
        ))}
      </div>

      <div className="flex w-[320pt] gap-2">
        <button
          type="button"
          onClick={() => setDigits(String(total))}
          className="h-[56pt] flex-1 rounded-[4pt] border border-rule text-15"
        >
          Exact {formatTHB(total)}
        </button>
      </div>

      <div className="flex w-[320pt] gap-2">
        <button type="button" onClick={onCancel} className="h-[56pt] flex-1 rounded-[4pt] border border-rule text-15">
          Back
        </button>
        <button
          type="button"
          disabled={!covered}
          onClick={() => onConfirm(tendered)}
          className="h-[56pt] flex-1 rounded-[4pt] bg-ink text-15 font-medium text-paper disabled:opacity-30"
        >
          Charge {formatTHB(total)}
        </button>
      </div>
    </div>
  );
}
