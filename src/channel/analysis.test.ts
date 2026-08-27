import { describe, expect, it } from "vitest";
import { fromBahtString, satang, type Satang } from "../money.js";
import { WALK_IN, GRAB, type Channel } from "./types.js";
import {
  performanceByChannel,
  answerPricingQuestion,
  counterContribution,
  type ChannelSale,
} from "./analysis.js";

const b = (s: string): Satang => fromBahtString(s);
const OPTS = { vatRegistered: false, vatRateBp: 700 };

const sale = (
  saleId: string,
  channelId: string,
  listBaht: string,
  overrides: Partial<ChannelSale> = {},
): ChannelSale => ({
  saleId,
  channelId,
  listPrice: b(listBaht),
  merchantFundedDiscount: satang(0),
  ingredientCost: b("20"),
  packagingCost: b("2"),
  costComplete: true,
  ...overrides,
});

describe("performanceByChannel — ordering", () => {
  it("sorts by contribution, never by revenue", () => {
    // Grab takes more money over the counter but keeps far less of it.
    const sales = [
      sale("w1", WALK_IN.id, "90"),
      sale("w2", WALK_IN.id, "90"),
      sale("g1", GRAB.id, "125"),
      sale("g2", GRAB.id, "125"),
    ];
    const result = performanceByChannel(sales, [WALK_IN, GRAB], OPTS);

    expect(result[0]!.channelId).toBe(WALK_IN.id);
    expect(result[1]!.channelId).toBe(GRAB.id);
    // Revenue ordering would have put Grab first.
    expect(result[1]!.customerPaid).toBeGreaterThan(result[0]!.customerPaid);
    expect(result[0]!.contribution).toBeGreaterThan(result[1]!.contribution);
  });

  it("returns one row per channel that traded", () => {
    const result = performanceByChannel([sale("w1", WALK_IN.id, "90")], [WALK_IN, GRAB], OPTS);
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe(WALK_IN.id);
  });

  it("is empty for a day with no sales", () => {
    expect(performanceByChannel([], [WALK_IN, GRAB], OPTS)).toEqual([]);
  });
});

describe("performanceByChannel — figures", () => {
  it("counts sales and totals what the customer paid", () => {
    const sales = [sale("g1", GRAB.id, "125"), sale("g2", GRAB.id, "125")];
    const [grab] = performanceByChannel(sales, [GRAB], OPTS);

    expect(grab!.saleCount).toBe(2);
    expect(grab!.customerPaid).toBe(b("250"));
  });

  it("applies commission on a delivery channel and none at the counter", () => {
    const result = performanceByChannel(
      [sale("w1", WALK_IN.id, "90"), sale("g1", GRAB.id, "125")],
      [WALK_IN, GRAB],
      OPTS,
    );
    expect(result.find((r) => r.channelId === WALK_IN.id)!.gpAmount).toBe(satang(0));
    expect(result.find((r) => r.channelId === GRAB.id)!.gpAmount).toBeGreaterThan(0);
  });

  it("reports contribution per sale — what one more order is worth", () => {
    const sales = [sale("g1", GRAB.id, "125"), sale("g2", GRAB.id, "125")];
    const [grab] = performanceByChannel(sales, [GRAB], OPTS);
    expect(grab!.contributionPerSale).toBe(satang(Math.round(grab!.contribution / 2)));
  });

  it("carries the contract reading on every row so it is never unstated", () => {
    const [grab] = performanceByChannel([sale("g1", GRAB.id, "125")], [GRAB], OPTS);
    expect(grab!.gpBasis).toBe(GRAB.gpBasis);
    expect(grab!.gpAppliesTo).toBe(GRAB.gpAppliesTo);
    expect(grab!.gpRateBp).toBe(GRAB.gpRateBp);
  });

  it("changes the answer when the contract reading changes — this is the phase's risk", () => {
    const harsh: Channel = { ...GRAB, gpAppliesTo: "LIST_PRICE" };
    const kind: Channel = { ...GRAB, id: "GRAB_KIND", gpAppliesTo: "DISCOUNTED_PRICE" };
    const discounted = { merchantFundedDiscount: b("25") };

    const [harshResult] = performanceByChannel(
      [sale("g1", harsh.id, "125", discounted)],
      [harsh],
      OPTS,
    );
    const [kindResult] = performanceByChannel(
      [sale("g1", kind.id, "125", discounted)],
      [kind],
      OPTS,
    );

    expect(harshResult!.gpAmount).toBeGreaterThan(kindResult!.gpAmount);
    expect(harshResult!.contribution).toBeLessThan(kindResult!.contribution);
  });

  it("withholds the margin when any sale on the channel lacked a frozen cost", () => {
    const sales = [sale("g1", GRAB.id, "125"), sale("g2", GRAB.id, "125", { costComplete: false })];
    const [grab] = performanceByChannel(sales, [GRAB], OPTS);

    expect(grab!.costComplete).toBe(false);
    expect(grab!.contributionMarginBp).toBeNull();
  });

  it("reports a margin when every sale is costed", () => {
    const [grab] = performanceByChannel([sale("g1", GRAB.id, "125")], [GRAB], OPTS);
    expect(grab!.contributionMarginBp).not.toBeNull();
  });

  it("drops sales on an unknown channel rather than inventing a commission rate", () => {
    const sales = [sale("w1", WALK_IN.id, "90"), sale("x1", "NOT_A_CHANNEL", "100")];
    const result = performanceByChannel(sales, [WALK_IN], OPTS);

    expect(result).toHaveLength(1);
    expect(result[0]!.saleCount).toBe(1);
  });

  it("nets payout down by commission and its VAT, and up by withholding", () => {
    const [grab] = performanceByChannel([sale("g1", GRAB.id, "125")], [GRAB], OPTS);
    expect(grab!.netPayout).toBe(
      satang(grab!.customerPaid - grab!.gpAmount - grab!.gpVat + grab!.wht),
    );
  });
});

describe("answerPricingQuestion", () => {
  const template = {
    merchantFundedDiscount: satang(0),
    ingredientCost: b("20"),
    packagingCost: b("2"),
    vatRegistered: false,
    vatRateBp: 700,
  };

  it("answers 'should I raise my Grab price' with a number", () => {
    const target = counterContribution(WALK_IN, b("90"), template);
    const answer = answerPricingQuestion(GRAB, b("125"), target, template);

    expect(answer.breakEvenListPrice).not.toBeNull();
    expect(typeof answer.breakEvenListPrice).toBe("number");
  });

  it("the break-even price actually achieves the target contribution", () => {
    const target = counterContribution(WALK_IN, b("90"), template);
    const answer = answerPricingQuestion(GRAB, b("125"), target, template);
    const achieved = answerPricingQuestion(GRAB, answer.breakEvenListPrice!, target, template);

    expect(achieved.currentContribution).toBeGreaterThanOrEqual(target);
  });

  it("says how far the price would have to move", () => {
    const target = counterContribution(WALK_IN, b("90"), template);
    const answer = answerPricingQuestion(GRAB, b("125"), target, template);
    expect(answer.shortfall).toBe(satang(answer.breakEvenListPrice! - b("125")));
  });

  it("reports that a price already clearing the bar needs no rise", () => {
    const answer = answerPricingQuestion(GRAB, b("500"), b("10"), template);
    expect(answer.alreadyClears).toBe(true);
    expect(answer.shortfall).toBeLessThanOrEqual(0);
  });

  it("reports that a price below the bar does not clear it", () => {
    const target = counterContribution(WALK_IN, b("90"), template);
    const answer = answerPricingQuestion(GRAB, b("90"), target, template);

    expect(answer.alreadyClears).toBe(false);
    expect(answer.shortfall).toBeGreaterThan(0);
  });

  it("demonstrates that matching the counter price on delivery does not match the counter margin", () => {
    // The specific failure channel pricing exists to prevent.
    const target = counterContribution(WALK_IN, b("90"), template);
    const sameAsCounter = answerPricingQuestion(GRAB, b("90"), target, template);
    expect(sameAsCounter.currentContribution).toBeLessThan(target);
  });

  it("returns null when the target is unreachable at any sane price", () => {
    const answer = answerPricingQuestion(GRAB, b("125"), b("1000000"), template);
    expect(answer.breakEvenListPrice).toBeNull();
    expect(answer.shortfall).toBeNull();
  });
});

describe("counterContribution", () => {
  const template = {
    merchantFundedDiscount: satang(0),
    ingredientCost: b("20"),
    packagingCost: b("2"),
    vatRegistered: false,
    vatRateBp: 700,
  };

  it("is list price less cost when there is no commission", () => {
    expect(counterContribution(WALK_IN, b("90"), template)).toBe(b("68"));
  });

  it("rises with the list price", () => {
    expect(counterContribution(WALK_IN, b("100"), template)).toBeGreaterThan(
      counterContribution(WALK_IN, b("90"), template),
    );
  });
});
