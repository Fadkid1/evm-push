import { encodeFunctionData, getAddress, isAddress, parseAbiItem, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { applySlippage, fromRaw, percentOf, toRaw } from "./amount.js";
import { elysium, hyperEvm } from "./chains.js";
import { clientFor, elyClient, hyperClient } from "./chain/clients.js";
import type { BatchResult, Wallet } from "./chain/wallet.js";
import type { Db, Settings } from "./db.js";
import { entryFromTrades, type Entry } from "./entry.js";
import { hypeUsd } from "./market.js";
import { erc20Abi } from "./venues/abis.js";
import { ELYSP, KLEOS, STOCKIUM } from "./venues/addresses.js";
import { parseInput, resolveVenue } from "./venues/resolve.js";
import { GAS, type TxReq, type Venue } from "./venues/types.js";

/** HYPE always left for gas on each chain. */
export const GAS_RESERVE: Record<number, bigint> = { [elysium.id]: toRaw("0.003"), [hyperEvm.id]: toRaw("0.01") };

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
}

export interface Snapshot {
  ref: string;
  venue: Venue;
  meta: TokenMeta;
  balance: bigint;
  held: number;
  priceHype: number;
  priceUsd: number;
  mcapUsd: number;
  liquidityHype: number | null;
  hypeUsd: number;
  /** HYPE on the chain this token trades on. */
  walletHype: number;
  entry: Entry | null;
}

export interface TradeOutcome {
  side: "buy" | "sell";
  ok: boolean;
  venue: Venue;
  symbol: string;
  hashes: Hex[];
  hype: number;
  tokens: number;
  /** True when the amounts come from the quote because the fill couldn't be read. */
  estimated: boolean;
  pending?: string;
  inboxTx?: Hex;
  error?: string;
  dryRun?: TxReq[];
}

export interface PositionRow {
  ref: string;
  symbol: string;
  pad: string;
  held: number;
  worthHype: number;
  worthUsd: number;
  pnl: number | null;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const WHYPES = new Set([KLEOS.whype, ELYSP.v1.weth, STOCKIUM.whype].map((a) => a.toLowerCase()));

export class Trader {
  private metaCache = new Map<string, TokenMeta>();
  private scannedTo = 0n;

  constructor(
    readonly wallet: Wallet,
    private db: Db,
  ) {}

  get address(): Address {
    return this.wallet.address;
  }

  async venue(ref: string): Promise<Venue> {
    const input = parseInput(ref);
    if (!input) throw new Error("That isn't a token address or a Kleos / ElysPump / Stockium link");
    const v = await resolveVenue(input);
    if (!v) throw new Error("Not a Kleos, ElysPump or Stockium token (or its pool isn't live yet)");
    return v;
  }

  async meta(v: Venue): Promise<TokenMeta> {
    const key = `${v.chainId}:${v.token.toLowerCase()}`;
    const hit = this.metaCache.get(key);
    if (hit) return hit;
    const c = clientFor(v.transport);
    const [name, symbol, decimals, supply] = await Promise.all([
      c.readContract({ address: v.token, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown"),
      c.readContract({ address: v.token, abi: erc20Abi, functionName: "symbol" }).catch(() => "???"),
      c.readContract({ address: v.token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      c.readContract({ address: v.token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
    ]);
    const m = { name, symbol, decimals: Number(decimals), supply: fromRaw(supply, Number(decimals)) };
    this.metaCache.set(key, m);
    return m;
  }

  tokenBalance(v: Venue): Promise<bigint> {
    return clientFor(v.transport).readContract({ address: v.token, abi: erc20Abi, functionName: "balanceOf", args: [this.address] });
  }

  entry(v: Venue): Entry | null {
    return entryFromTrades(this.db.trades(this.address, v.chainId, v.token));
  }

  async snapshot(ref: string): Promise<Snapshot> {
    const v = await this.venue(ref);
    const [meta, balance, priceHype, liq, usd, wallet] = await Promise.all([
      this.meta(v),
      this.tokenBalance(v),
      v.spotPrice().catch(() => 0),
      v.liquidityHype().catch(() => null),
      hypeUsd(),
      this.wallet.balance(v.chainId),
    ]);
    this.db.remember(this.address, { chainId: v.chainId, token: v.token, ref });
    return {
      ref,
      venue: v,
      meta,
      balance,
      held: fromRaw(balance, meta.decimals),
      priceHype,
      priceUsd: priceHype * usd,
      mcapUsd: priceHype * usd * meta.supply,
      liquidityHype: liq,
      hypeUsd: usd,
      walletHype: fromRaw(wallet),
      entry: this.entry(v),
    };
  }

  private deadline(v: Venue): bigint {
    // Kleos: 3 days, as its site does for inbox-routed trades; elsewhere 20 minutes.
    return BigInt(Math.floor(Date.now() / 1000) + (v.transport === "kleos" ? 259_200 : 1200));
  }

  /** Buys with an exact HYPE amount, straight away. */
  async buy(ref: string, hypeAmount: number, settings: Settings): Promise<TradeOutcome> {
    const v = await this.venue(ref);
    const meta = await this.meta(v);
    const amountIn = toRaw(hypeAmount);
    const bal = await this.wallet.balance(v.chainId);
    const reserve = GAS_RESERVE[v.chainId]!;
    if (bal < amountIn + reserve) {
      const where = v.chainId === elysium.id ? "on Elysium (bridge from HyperEVM on the home screen)" : "on HyperEVM";
      throw new Error(`Not enough HYPE ${where}: have ${fromRaw(bal).toFixed(4)}, need ${(hypeAmount + fromRaw(reserve)).toFixed(4)} incl. gas`);
    }
    const expected = await v.quoteBuy(amountIn);
    if (expected <= 0n) throw new Error("The pool quoted 0 tokens for this amount");
    const minOut = applySlippage(expected, settings.slippagePct);
    const reqs = v.buildBuy(amountIn, minOut, this.address, this.deadline(v));
    const out: TradeOutcome = { side: "buy", ok: true, venue: v, symbol: meta.symbol, hashes: [], hype: hypeAmount, tokens: fromRaw(expected, meta.decimals), estimated: true };
    if (this.wallet.dryRun) return { ...out, dryRun: reqs };

    const res = await this.wallet.execute(v.chainId, v.transport, reqs);
    this.fillFrom(out, res);
    const last = res.receipts.at(-1);
    if (last && last.status === "success" && res.receipts.length === res.sent.length) {
      const got = this.received(last, v.token);
      if (got > 0n) {
        out.tokens = fromRaw(got, meta.decimals);
        out.estimated = false;
      }
    }
    if (out.ok && !out.pending) this.log(v, "buy", out);
    this.db.remember(this.address, { chainId: v.chainId, token: v.token, ref });
    return out;
  }

  /** Sells a percentage of the holding, approving first when the route needs it (sent back to back, no waiting). */
  async sell(ref: string, pct: number, settings: Settings): Promise<TradeOutcome> {
    const v = await this.venue(ref);
    const meta = await this.meta(v);
    const balance = await this.tokenBalance(v);
    const amount = percentOf(balance, pct);
    if (amount <= 0n) throw new Error(`No ${meta.symbol} to sell`);
    const expected = await v.quoteSell(amount);
    if (expected <= 0n) throw new Error(`The ${v.pad} route quotes 0 HYPE for this sell (no liquidity on its HYPE side); not selling`);
    const minOut = applySlippage(expected, settings.slippagePct);
    const approvals = await v.sellApprovals(this.address, amount);
    const sells = v.buildSell(amount, minOut, this.address, this.deadline(v)).map((r) => (approvals.length ? { ...r, gas: r.gas ?? GAS.swap } : r));
    const reqs = [...approvals, ...sells];
    const out: TradeOutcome = { side: "sell", ok: true, venue: v, symbol: meta.symbol, hashes: [], hype: fromRaw(expected), tokens: fromRaw(amount, meta.decimals), estimated: true };
    if (this.wallet.dryRun) return { ...out, dryRun: reqs };

    const res = await this.wallet.execute(v.chainId, v.transport, reqs);
    this.fillFrom(out, res);
    if (out.ok && !out.pending) {
      const got = await this.hypeReceived(v.chainId, res.sent.map((x) => x.hash)).catch(() => null);
      // Sanity bound: a fill can't be below the slippage minimum or far above the quote.
      if (got !== null && got >= minOut && got <= expected * 2n) {
        out.hype = fromRaw(got);
        out.estimated = false;
      }
      this.log(v, "sell", out);
    }
    return out;
  }

  private fillFrom(out: TradeOutcome, res: BatchResult): void {
    out.hashes = res.sent.map((s) => s.hash);
    out.inboxTx = res.inboxTx;
    out.pending = res.pending;
    const bad = res.receipts.find((r) => r.status !== "success");
    if (bad) {
      out.ok = false;
      out.error = `Reverted on-chain (${res.sent.find((s) => s.hash === bad.transactionHash)?.req.label ?? "tx"}). Price moved past your slippage, or the pool rejected it.`;
    }
  }

  private log(v: Venue, side: "buy" | "sell", o: TradeOutcome): void {
    void hypeUsd().then((usd) =>
      this.db.addTrade({ account: this.address, chainId: v.chainId, token: v.token, side, hype: o.hype, tokens: o.tokens, usd: o.hype * usd, via: v.label, txHash: o.hashes.at(-1)!, ts: Date.now() }),
    );
  }

  /** Tokens sent to this wallet in a receipt. */
  private received(rc: TransactionReceipt, token: Address): bigint {
    const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: rc.logs, strict: false });
    return logs
      .filter((l) => l.address.toLowerCase() === token.toLowerCase() && String(l.args.to).toLowerCase() === this.address.toLowerCase())
      .reduce((a, l) => a + (l.args.value ?? 0n), 0n);
  }

  /**
   * Native HYPE a batch paid this wallet: balance change across its blocks plus the gas it spent.
   * Elysium is read on the live RPC (the Kleos relay numbers blocks differently).
   */
  private async hypeReceived(chainId: number, hashes: Hex[]): Promise<bigint | null> {
    const c = chainId === hyperEvm.id ? hyperClient : elyClient;
    const receipts = await Promise.all(hashes.map((hash) => c.getTransactionReceipt({ hash })));
    const first = receipts[0];
    const last = receipts.at(-1);
    if (!first || !last) return null;
    const [before, after] = await Promise.all([
      c.getBalance({ address: this.address, blockNumber: first.blockNumber - 1n }),
      c.getBalance({ address: this.address, blockNumber: last.blockNumber }),
    ]);
    const gas = receipts.reduce((a, r) => a + r.gasUsed * (r.effectiveGasPrice ?? 0n), 0n);
    return after - before + gas;
  }

  /** Sends HYPE or a token on either chain, straight away. amount "max" keeps the gas reserve for HYPE. */
  async withdraw(chainId: number, asset: "native" | Address, to: string, amount: string): Promise<{ hash: Hex; amount: number; symbol: string; pending?: string }> {
    if (!isAddress(to, { strict: false })) throw new Error("That isn't a valid 0x address");
    const dest = getAddress(to.toLowerCase());
    if (dest.toLowerCase() === this.address.toLowerCase()) throw new Error("That's the bot's own wallet");
    const transport = chainId === hyperEvm.id ? "hyperevm" : "elysp";
    const c = chainId === hyperEvm.id ? hyperClient : elyClient;
    let req: TxReq;
    let value: bigint;
    let symbol = "HYPE";
    let decimals = 18;
    if (asset === "native") {
      const bal = await this.wallet.balance(chainId);
      const max = bal - GAS_RESERVE[chainId]!;
      value = amount === "max" ? max : toRaw(amount);
      if (value <= 0n || value > max) throw new Error(`You can send up to ${fromRaw(max > 0n ? max : 0n).toFixed(4)} HYPE (gas is kept back)`);
      req = { to: dest, data: "0x", value, gas: 50_000n, label: "send HYPE" };
    } else {
      const [bal, sym, dec] = await Promise.all([
        c.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [this.address] }),
        c.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => "token"),
        c.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      ]);
      symbol = sym;
      decimals = Number(dec);
      value = amount === "max" ? bal : toRaw(amount, decimals);
      if (value <= 0n || value > bal) throw new Error(`You hold ${fromRaw(bal, decimals)} ${symbol}`);
      req = { to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, value] }), label: `send ${symbol}` };
    }
    if (this.wallet.dryRun) return { hash: "0x", amount: fromRaw(value, decimals), symbol };
    const res = await this.wallet.execute(chainId, transport, [req]);
    const rc = res.receipts[0];
    if (rc && rc.status !== "success") throw new Error("The transfer reverted");
    return { hash: res.sent[0]!.hash, amount: fromRaw(value, decimals), symbol, pending: res.pending };
  }

  /** HyperEVM -> Elysium deposit through the Orbit inbox. */
  async bridgeToElysium(amount: string): Promise<{ hash: Hex; amount: number; credited: boolean }> {
    const bal = await this.wallet.balance(hyperEvm.id);
    const max = bal - GAS_RESERVE[hyperEvm.id]!;
    const value = amount === "max" ? max : toRaw(amount);
    if (value <= 0n || value > max) throw new Error(`You can bridge up to ${fromRaw(max > 0n ? max : 0n).toFixed(4)} HYPE (gas is kept back on HyperEVM)`);
    if (this.wallet.dryRun) return { hash: "0x", amount: fromRaw(value), credited: false };
    const r = await this.wallet.depositToElysium(value);
    return { ...r, amount: fromRaw(value) };
  }

  /** Tokens that ever arrived in this wallet on Elysium (Transfer logs), added to the known list. */
  private async scanElysium(): Promise<void> {
    const head = await elyClient.getBlockNumber();
    if (head <= this.scannedTo) return;
    const logs = await elyClient.getLogs({
      event: TRANSFER,
      args: { to: this.address },
      fromBlock: this.scannedTo + 1n,
      toBlock: head,
    });
    for (const l of logs) {
      const t = l.address.toLowerCase();
      if (!WHYPES.has(t)) this.db.remember(this.address, { chainId: elysium.id, token: t, ref: t });
    }
    this.scannedTo = head;
  }

  async positions(settings: Settings): Promise<{ rows: PositionRow[]; hypeUsd: number }> {
    await this.scanElysium().catch(() => {});
    const usd = await hypeUsd();
    const known = this.db.known(this.address);
    const rows = await Promise.all(
      known.map(async (k): Promise<PositionRow | null> => {
        const c = k.chainId === hyperEvm.id ? hyperClient : elyClient;
        const bal = await c.readContract({ address: k.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [this.address] }).catch(() => 0n);
        if (bal === 0n) return null;
        const v = await this.venue(k.ref).catch(() => null);
        if (!v || v.token.toLowerCase() !== k.token) return null;
        const [meta, price] = await Promise.all([this.meta(v), v.spotPrice().catch(() => 0)]);
        const held = fromRaw(bal, meta.decimals);
        const worthHype = held * price;
        if (worthHype * usd < settings.minPositionUsd) return null;
        const e = this.entry(v);
        return {
          ref: k.ref,
          symbol: meta.symbol,
          pad: v.pad,
          held,
          worthHype,
          worthUsd: worthHype * usd,
          pnl: e ? ((worthHype - e.priceHype * held) / (e.priceHype * held)) * 100 : null,
        };
      }),
    );
    return { rows: rows.filter((r): r is PositionRow => !!r).sort((a, b) => b.worthUsd - a.worthUsd), hypeUsd: usd };
  }
}
