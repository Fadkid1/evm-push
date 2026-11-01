import { explorerTx, hyperEvm } from "../chains.js";
import { heldCost, pnlPct } from "../entry.js";
import type { Snapshot, TradeOutcome } from "../trader.js";

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return n.toFixed(a >= 1 ? digits : 4);
}

/** Small prices use subscript zeros: 0.00000123 -> 0.0₅123 */
export function price(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const zeros = Math.floor(-Math.log10(n));
  if (zeros < 4) return n.toPrecision(4).replace(/0+$/, "");
  const sig = Math.round(n * 10 ** (zeros + 4)).toString().slice(0, 4).replace(/0+$/, "");
  return `0.0${String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("")}${sig}`;
}

export const usd = (n: number) => (Math.abs(n) >= 1000 ? `$${compact(n)}` : `$${n.toFixed(2)}`);
export const usdPrice = (n: number) => `$${price(n)}`;
export const hype = (n: number) => `${n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3)} HYPE`;
export const signedHype = (n: number) => `${n >= 0 ? "+" : "−"}${hype(Math.abs(n))}`;
export const pct = (n: number | null) => (n == null ? "–" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
export const pnlEmoji = (n: number | null) => (n == null ? "⚪" : n >= 0 ? "🟢" : "🔴");
export const txLink = (chainId: number, hash: string, text = "tx") => `<a href="${explorerTx(chainId, hash)}">${text}</a>`;
export const chainName = (id: number) => (id === hyperEvm.id ? "HyperEVM" : "Elysium");

export function tokenCard(s: Snapshot): string {
  const v = s.venue;
  const worthHype = s.held * s.priceHype;
  const lines: string[] = [];
  lines.push(`<b>${esc(s.meta.symbol)}</b> · ${esc(s.meta.name)}`);
  lines.push(`<code>${v.token}</code>`);
  lines.push(`🚀 ${v.pad} · ${chainName(v.chainId)}`);
  lines.push(`🛣 ${esc(v.label)}`);
  lines.push("");
  lines.push(`💲 Price: ${usdPrice(s.priceUsd)} · ${price(s.priceHype)} HYPE`);
  lines.push(`📊 Market cap: ${s.mcapUsd ? usd(s.mcapUsd) : "–"}`);
  lines.push(`💧 Liquidity: ${s.liquidityHype != null ? `${hype(s.liquidityHype)} · ${usd(s.liquidityHype * s.hypeUsd)}` : "–"}`);
  lines.push("");
  if (s.entry) {
    const cost = heldCost(s.entry, s.held);
    const p = pnlPct(worthHype, cost);
    lines.push(`🎯 Entry: ${usdPrice(s.entry.priceUsd)} · ${price(s.entry.priceHype)} HYPE`);
    lines.push(`🏁 Entry market cap: ${usd(s.entry.priceUsd * s.meta.supply)}`);
    if (s.held > 0) lines.push(`${pnlEmoji(p)} PnL: ${pct(p)} · ${signedHype(worthHype - cost)} (cost ${hype(cost)})`);
  } else {
    lines.push("🎯 Entry: –");
  }
  lines.push(`📦 Holding: ${compact(s.held)} ${esc(s.meta.symbol)}`);
  lines.push(`💰 Worth: <b>${hype(worthHype)}</b> · <b>${usd(worthHype * s.hypeUsd)}</b>`);
  lines.push("");
  lines.push(`👛 Wallet (${chainName(v.chainId)}): ${hype(s.walletHype)}`);
  return lines.join("\n");
}

export function tradeResult(o: TradeOutcome): string {
  const v = o.venue;
  if (o.dryRun) {
    return [
      `🧪 <b>DRY RUN</b> ${o.side} ${esc(o.symbol)} via ${esc(v.label)}`,
      `Expected: ${o.side === "buy" ? `${compact(o.tokens)} ${esc(o.symbol)} for ${hype(o.hype)}` : `${hype(o.hype)} for ${compact(o.tokens)} ${esc(o.symbol)}`}`,
      ...o.dryRun.map((t, i) => `${i + 1}. ${esc(t.label)} → <code>${t.to}</code>${t.value ? ` · ${hype(Number(t.value) / 1e18)}` : ""}\n<code>${t.data.slice(0, 74)}…</code>`),
    ].join("\n");
  }
  const links = o.hashes.map((h, i) => txLink(v.chainId, h, o.hashes.length > 1 ? `tx${i + 1}` : "tx")).join(" ");
  const inbox = o.inboxTx ? ` · ${txLink(hyperEvm.id, o.inboxTx, "inbox post")}` : "";
  if (!o.ok) return `❌ ${o.side === "buy" ? "Buy" : "Sell"} ${esc(o.symbol)} failed: ${esc(o.error ?? "")}\n${links}`;
  const est = o.estimated ? " (quoted)" : "";
  const what = o.side === "buy" ? `Bought <b>${compact(o.tokens)} ${esc(o.symbol)}</b>${est} for <b>${hype(o.hype)}</b>` : `Sold <b>${compact(o.tokens)} ${esc(o.symbol)}</b> for <b>${hype(o.hype)}</b>${est}`;
  if (o.pending) return `⏳ ${what}\n${esc(o.pending)} · ${links}${inbox}`;
  return `✅ ${what}\n🛣 ${esc(v.label)} · ${links}${inbox}`;
}
