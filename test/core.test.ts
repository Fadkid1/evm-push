import { describe, expect, it } from "vitest";
import { applySlippage, fromRaw, percentOf, toRaw } from "../src/amount.js";
import type { TradeRow } from "../src/db.js";
import { entryFromTrades } from "../src/entry.js";
import { parseInput } from "../src/venues/resolve.js";

const A = "0x021959958a85E1b222597103660AE4adA25168f7";

describe("parseInput", () => {
  it("reads each launchpad's token links", () => {
    expect(parseInput(`https://www.thekleos.xyz/token/${A}`)).toEqual({ address: A, hint: "Kleos" });
    expect(parseInput(`https://elysp.com/#/token/${A.toLowerCase()}`)).toEqual({ address: A, hint: "ElysPump" });
    expect(parseInput(`https://stockium.fun/token/${A}`)).toEqual({ address: A, hint: "Stockium" });
  });
  it("accepts a bare address in any case", () => {
    expect(parseInput(A.toLowerCase())).toEqual({ address: A, hint: undefined });
  });
  it("rejects anything else", () => {
    expect(parseInput("hello")).toBeNull();
    expect(parseInput("0x1234")).toBeNull();
  });
});

describe("amounts", () => {
  it("converts and applies slippage", () => {
    expect(toRaw("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(fromRaw(1_500_000_000_000_000_000n)).toBe(1.5);
    expect(percentOf(1000n, 25)).toBe(250n);
    expect(percentOf(1000n, 100)).toBe(1000n);
    expect(applySlippage(1000n, 25)).toBe(750n);
  });
});

const trade = (side: "buy" | "sell", hype: number, tokens: number): TradeRow => ({ account: "a", chainId: 99901, token: "t", side, hype, tokens, usd: hype * 40, via: "x", txHash: "0x", ts: 0 });

describe("entry", () => {
  it("averages buys and removes cost pro rata on sells", () => {
    const e = entryFromTrades([trade("buy", 1, 100), trade("buy", 3, 100), trade("sell", 5, 100)])!;
    expect(e.tokens).toBe(100);
    expect(e.priceHype).toBeCloseTo(0.02);
    expect(e.costHype).toBeCloseTo(2);
    expect(e.priceUsd).toBeCloseTo(0.8);
  });
  it("is empty after selling everything", () => {
    expect(entryFromTrades([trade("buy", 1, 100), trade("sell", 2, 100)])).toBeNull();
  });
});
