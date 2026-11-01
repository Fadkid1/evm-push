/** HYPE/USD from Hyperliquid's mid prices (what Kleos uses), cached briefly. */
let cached: { at: number; price: number } | null = null;

export async function hypeUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < 30_000) return cached.price;
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });
    const price = Number(((await res.json()) as Record<string, string>).HYPE);
    if (Number.isFinite(price) && price > 0) cached = { at: Date.now(), price };
  } catch {
    // keep the last good price
  }
  return cached?.price ?? 0;
}
