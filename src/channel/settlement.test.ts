import { describe, expect, it } from "vitest";
import { fromBahtString, satang, sum, type Satang } from "../money.js";
import { WALK_IN, GRAB, type Channel } from "./types.js";
import {
  settle,
  compareChannels,
  breakEvenListPrice,
  summarise,
  SettlementError,
  type SettlementInput,
} from "./settlement.js";

const VAT_7 = 700;

describe("settle — walk-in (no commission)", () => {
  it("contribution is simply net revenue less cost of goods when there is no commission", () => {
    const input: SettlementInput = {
      channel: WALK_IN,
      listPrice: fromBahtString("100"),
      ingredientCost: fromBahtString("20"),
      packagingCost: fromBahtString("5"),
      vatRegistered: false,
      vatRateBp: VAT_7,
    };
    const result = settle(input);

    expect(result.gpAmount).toBe(satang(0));
    expect(result.contribution).toBe(satang(result.netRevenue - result.costOfGoods));
  });
});

describe("settle — GP basis and applies-to contract reading", () => {
  const base: Omit<SettlementInput, "channel"> = {
    listPrice: fromBahtString("105"),
    merchantFundedDiscount: fromBahtString("20"),
    ingredientCost: fromBahtString("20"),
    packagingCost: fromBahtString("10"),
    vatRegistered: false,
    vatRateBp: VAT_7,
  };

  it("is billed GP on the full list price even when a merchant-funded discount means less was received (default LIST_PRICE reading)", () => {
    const result = settle({ ...base, channel: GRAB });
    expect(result.gpBase).toBe(fromBahtString("105"));
    expect(result.customerPaid).toBe(fromBahtString("85")); // what was actually received
  });

  it("would be billed on the discounted price instead, under a DISCOUNTED_PRICE contract", () => {
    const discountedChannel: Channel = { ...GRAB, gpAppliesTo: "DISCOUNTED_PRICE" };
    const result = settle({ ...base, channel: discountedChannel });
    expect(result.gpBase).toBe(fromBahtString("85"));
  });

  it("GROSS basis charges commission on the VAT-inclusive figure; NET charges less", () => {
    const grossChannel: Channel = { ...GRAB, gpAppliesTo: "DISCOUNTED_PRICE", gpBasis: "GROSS" };
    const netChannel: Channel = { ...GRAB, gpAppliesTo: "DISCOUNTED_PRICE", gpBasis: "NET" };

    const grossResult = settle({ ...base, channel: grossChannel });
    const netResult = settle({ ...base, channel: netChannel });

    expect(netResult.gpBase).toBeLessThan(grossResult.gpBase);
  });
});

describe("settle — VAT registration effect on commission VAT", () => {
  const base: SettlementInput = {
    channel: GRAB,
    listPrice: fromBahtString("100"),
    ingredientCost: fromBahtString("20"),
    packagingCost: fromBahtString("10"),
    vatRegistered: false,
    vatRateBp: VAT_7,
  };

  it("commission itself does not depend on the seller's own registration status", () => {
    const registered = settle({ ...base, vatRegistered: true });
    const unregistered = settle({ ...base, vatRegistered: false });
    expect(registered.gpAmount).toBe(unregistered.gpAmount);
    expect(registered.gpVat).toBe(unregistered.gpVat);
  });

  it("VAT on commission is reclaimable only when registered", () => {
    const registered = settle({ ...base, vatRegistered: true });
    const unregistered = settle({ ...base, vatRegistered: false });
    expect(unregistered.reclaimableInputVat).toBe(satang(0));
    expect(registered.reclaimableInputVat).toBeGreaterThan(0);
  });
});

describe("settle — internal consistency", () => {
  it("netPayout matches customerPaid minus commission and its VAT, plus withholding tax", () => {
    const input: SettlementInput = {
      channel: GRAB,
      listPrice: fromBahtString("155"),
      ingredientCost: fromBahtString("25"),
      packagingCost: fromBahtString("12"),
      vatRegistered: true,
      vatRateBp: VAT_7,
    };
    const result = settle(input);
    expect(result.netPayout).toBe(
      satang(result.customerPaid - result.gpAmount - result.gpVat + result.wht),
    );
  });
});

describe("settle — input validation", () => {
  const base: Omit<SettlementInput, "listPrice" | "merchantFundedDiscount"> = {
    channel: WALK_IN,
    ingredientCost: satang(0),
    packagingCost: satang(0),
    vatRegistered: false,
    vatRateBp: VAT_7,
  };

  it("rejects a negative list price", () => {
    expect(() => settle({ ...base, listPrice: satang(-100) })).toThrow(SettlementError);
  });

  it("rejects a negative discount", () => {
    expect(() =>
      settle({ ...base, listPrice: fromBahtString("10"), merchantFundedDiscount: satang(-1) }),
    ).toThrow(SettlementError);
  });

  it("rejects a discount larger than the list price", () => {
    expect(() =>
      settle({
        ...base,
        listPrice: fromBahtString("10"),
        merchantFundedDiscount: fromBahtString("20"),
      }),
    ).toThrow(SettlementError);
  });
});

describe("compareChannels", () => {
  it("sorts by contribution, not by revenue", () => {
    const lowRevenueHighContribution: SettlementInput = {
      channel: WALK_IN,
      listPrice: fromBahtString("100"),
      ingredientCost: fromBahtString("20"),
      packagingCost: fromBahtString("5"),
      vatRegistered: false,
      vatRateBp: VAT_7,
    };

    const heavyCommission: Channel = {
      ...GRAB,
      gpRateBp: 6000,
      gpVatRateBp: 0,
      whtRateBp: 0,
    };
    const highRevenueLowContribution: SettlementInput = {
      channel: heavyCommission,
      listPrice: fromBahtString("200"),
      ingredientCost: fromBahtString("20"),
      packagingCost: fromBahtString("5"),
      vatRegistered: false,
      vatRateBp: VAT_7,
    };

    const [first, second] = compareChannels([highRevenueLowContribution, lowRevenueHighContribution]);

    // Sanity: the "high revenue" input really does have higher customerPaid...
    expect(highRevenueLowContribution.listPrice).toBeGreaterThan(lowRevenueHighContribution.listPrice);
    // ...but lower contribution, and contribution is what determines order.
    expect(first!.channelId).toBe(WALK_IN.id);
    expect(second!.channelId).toBe(heavyCommission.id);
    expect(first!.settlement.contribution).toBeGreaterThan(second!.settlement.contribution);
  });
});

describe("breakEvenListPrice", () => {
  const template: Omit<SettlementInput, "listPrice"> = {
    channel: GRAB,
    ingredientCost: fromBahtString("20"),
    packagingCost: fromBahtString("10"),
    vatRegistered: false,
    vatRateBp: VAT_7,
  };

  it("finds a list price that achieves at least the target contribution", () => {
    const target = fromBahtString("50");
    const price = breakEvenListPrice(target, template);
    expect(price).not.toBeNull();
    const achieved = settle({ ...template, listPrice: price! }).contribution;
    expect(achieved).toBeGreaterThanOrEqual(target);
  });

  it("returns null when the target is unreachable within the price ceiling", () => {
    const impossible = fromBahtString("1000000");
    const price = breakEvenListPrice(impossible, template, fromBahtString("500"));
    expect(price).toBeNull();
  });
});

describe("summarise", () => {
  it("sums each field across settlements", () => {
    const a = settle({
      channel: WALK_IN,
      listPrice: fromBahtString("100"),
      ingredientCost: fromBahtString("20"),
      packagingCost: fromBahtString("5"),
      vatRegistered: true,
      vatRateBp: VAT_7,
    });
    const b = settle({
      channel: GRAB,
      listPrice: fromBahtString("150"),
      ingredientCost: fromBahtString("25"),
      packagingCost: fromBahtString("12"),
      vatRegistered: true,
      vatRateBp: VAT_7,
    });

    const total = summarise([a, b]);
    const expectedSum = (key: keyof typeof a): Satang => sum([a[key] as Satang, b[key] as Satang]);

    expect(total.customerPaid).toBe(expectedSum("customerPaid"));
    expect(total.outputVat).toBe(expectedSum("outputVat"));
    expect(total.gpAmount).toBe(expectedSum("gpAmount"));
    expect(total.contribution).toBe(expectedSum("contribution"));
    expect(total.reclaimableInputVat).toBe(expectedSum("reclaimableInputVat"));
  });
});
