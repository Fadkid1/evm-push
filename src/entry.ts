import type { TradeRow } from "./db.js";

export interface Entry {
  /** Average cost of the tokens still held, HYPE per token. */
  priceHype: number;
  priceUsd: number;
  /** Tokens the trade log says are held (transfers outside the bot aren't counted). */
  tokens: number;
  /** Cost of those tokens. */
  costHype: number;
  costUsd: number;
}

/** Average-cost basis from the trade log: buys add cost, sells remove it pro rata. */
export function entryFromTrades(trades: TradeRow[]): Entry | null {
  let tokens = 0;
  let costHype = 0;
  let costUsd = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      tokens += t.tokens;
      costHype += t.hype;
      costUsd += t.usd;
    } else if (tokens > 0) {
      const frac = Math.min(1, t.tokens / tokens);
      costHype -= costHype * frac;
      costUsd -= costUsd * frac;
      tokens -= Math.min(tokens, t.tokens);
    }
  }
  if (!(tokens > 0) || !(costHype > 0)) return null;
  return { priceHype: costHype / tokens, priceUsd: costUsd / tokens, tokens, costHype, costUsd };
}

/** Cost of `held` tokens at the entry price (held can differ from the log after outside transfers). */
export const heldCost = (e: Entry, held: number) => e.priceHype * held;

export const pnlPct = (worth: number, cost: number): number | null => (cost > 0 ? ((worth - cost) / cost) * 100 : null);
