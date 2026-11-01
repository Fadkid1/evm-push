/** "1.5" with 18 decimals -> 1500000000000000000n. Truncates extra precision. */
export function toRaw(amount: string | number, decimals = 18): bigint {
  const s = typeof amount === "number" ? amount.toFixed(Math.min(decimals, 18)) : amount.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`Invalid amount: ${amount}`);
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Raw integer -> JS number of whole units (fine for display and USD math). */
export function fromRaw(raw: bigint, decimals = 18): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** amount * pct / 100 with bigint precision (pct may be fractional). */
export function percentOf(amount: bigint, pct: number): bigint {
  if (pct >= 100) return amount;
  return (amount * BigInt(Math.round(pct * 100))) / 10000n;
}

/** Minimum acceptable output for a slippage tolerance in percent. */
export function applySlippage(expected: bigint, slippagePct: number): bigint {
  return (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
}
