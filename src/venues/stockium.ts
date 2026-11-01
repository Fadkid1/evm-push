import { encodeFunctionData, type Address, type Hex } from "viem";
import { elysium, hyperEvm } from "../chains.js";
import { elyClient, hyperClient } from "../chain/clients.js";
import { erc20Abi, gatewayRouterAbi, quoterV2Abi, stockiumCurveAbi, stockiumReceiverAbi, swapRouterAbi, v3FactoryAbi, v3PoolAbi } from "./abis.js";
import { STOCKIUM } from "./addresses.js";
import { approveTxs, encodePath, v3Spot } from "./v3.js";
import { ZERO, type TxReq, type Venue } from "./types.js";

const ely = elyClient;
const S = STOCKIUM;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Highest-HYPE StockiumSwap pool between `a` and WHYPE, over the fee tiers the site tries. */
async function whypePool(a: Address): Promise<{ pool: Address; fee: number } | null> {
  const pools = await Promise.all(
    S.fees.map((fee) => ely.readContract({ address: S.swapFactory, abi: v3FactoryAbi, functionName: "getPool", args: [a, S.whype, fee] }).then((pool) => ({ pool, fee })).catch(() => null)),
  );
  const live = pools.filter((p): p is { pool: Address; fee: number } => !!p && p.pool !== ZERO);
  if (!live.length) return null;
  const bals = await Promise.all(live.map((p) => ely.readContract({ address: S.whype, abi: erc20Abi, functionName: "balanceOf", args: [p.pool] }).catch(() => 0n)));
  let best = 0;
  bals.forEach((b, i) => b > bals[best]! && (best = i));
  return live[best]!;
}

/**
 * Stockium tokens launch on a HyperEVM bonding curve and graduate to a StockiumSwap pool on Elysium.
 * Accepts the curve (the address in a stockium.fun/token link), the HyperEVM token, or the Elysium token.
 */
export async function detectStockium(addr: Address): Promise<Venue | null> {
  const [curve, l1Pool, direct] = await Promise.all([
    Promise.all([
      hyperClient.readContract({ address: addr, abi: stockiumCurveAbi, functionName: "state" }),
      hyperClient.readContract({ address: addr, abi: stockiumCurveAbi, functionName: "token" }),
    ]).catch(() => null),
    receiverPool(addr),
    whypePool(addr),
  ]);
  if (curve) {
    const [state, token] = curve;
    if (!state[6] && !state[8]) return stockiumCurve(addr, token);
    const pool = await receiverPool(token);
    return pool ? stockiumSwap(await l2TokenOf(token), pool) : null;
  }
  if (l1Pool) return stockiumSwap(await l2TokenOf(addr), l1Pool);
  if (direct) return stockiumSwap(addr, direct.pool);
  // Paired with a hub instead of WHYPE.
  const hubPools = await Promise.all(
    S.hubs.flatMap((hub) => S.fees.map((fee) => ely.readContract({ address: S.swapFactory, abi: v3FactoryAbi, functionName: "getPool", args: [addr, hub.pair, fee] }).catch(() => ZERO))),
  );
  const hubPool = hubPools.find((p) => p !== ZERO);
  return hubPool ? stockiumSwap(addr, hubPool) : null;
}

/** Elysium pool a graduated curve's HyperEVM token was listed in (the site's receivers poolOf lookup). */
async function receiverPool(l1Token: Address): Promise<Address | null> {
  const pools = await Promise.all(S.receivers.map((r) => ely.readContract({ address: r, abi: stockiumReceiverAbi, functionName: "poolOf", args: [l1Token] }).catch(() => ZERO)));
  return pools.find((p) => p !== ZERO) ?? null;
}

const l2TokenOf = (l1: Address) => hyperClient.readContract({ address: S.gatewayRouter, abi: gatewayRouterAbi, functionName: "calculateL2TokenAddress", args: [l1] });

/** StockiumSwap on Elysium. HYPE pairs swap in one hop; hub / stock pairs go WHYPE -> pair -> token (the site's hubPath). */
async function stockiumSwap(token: Address, pool: Address): Promise<Venue | null> {
  const [t0, t1, fee] = await Promise.all([
    ely.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
    ely.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }),
    ely.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" }),
  ]);
  const pair = same(t0, token) ? t1 : t0;
  const hops: Array<{ pool: Address; base: Address }> = [{ pool, base: token }];
  let buyPath: Hex;
  let sellPath: Hex;
  let label: string;
  if (same(pair, S.whype)) {
    buyPath = encodePath([S.whype, token], [Number(fee)]);
    sellPath = encodePath([token, S.whype], [Number(fee)]);
    label = "StockiumSwap pool (HYPE)";
  } else {
    const hub = S.hubs.find((h) => same(h.pair, pair));
    let hop1: { pool: Address; fee: number } | null = null;
    if (hub) {
      const p = await ely.readContract({ address: S.swapFactory, abi: v3FactoryAbi, functionName: "getPool", args: [pair, S.whype, hub.fee] });
      hop1 = p === ZERO ? null : { pool: p, fee: hub.fee };
    } else {
      hop1 = await whypePool(pair);
    }
    if (!hop1) return null;
    hops.push({ pool: hop1.pool, base: pair });
    buyPath = encodePath([S.whype, pair, token], [hop1.fee, Number(fee)]);
    sellPath = encodePath([token, pair, S.whype], [Number(fee), hop1.fee]);
    const sym = await ely.readContract({ address: pair, abi: erc20Abi, functionName: "symbol" }).catch(() => "pair");
    label = `StockiumSwap route (HYPE → ${sym} → token)`;
  }
  const quote = async (path: Hex, amt: bigint) => (await ely.simulateContract({ address: S.quoterV2, abi: quoterV2Abi, functionName: "quoteExactInput", args: [path, amt] })).result[0];
  return {
    pad: "Stockium",
    kind: "stockium-swap",
    label,
    chainId: elysium.id,
    transport: "stockium",
    token,
    quoteBuy: (x) => quote(buyPath, x),
    quoteSell: (x) => quote(sellPath, x),
    // As stockium.fun: multicall(exactInput, refundETH) with HYPE as value.
    buildBuy: (hypeIn, minOut, me, deadline): TxReq[] => [
      {
        to: S.swapRouter,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "multicall",
          args: [
            [
              encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInput", args: [{ path: buyPath, recipient: me, deadline, amountIn: hypeIn, amountOutMinimum: minOut }] }),
              encodeFunctionData({ abi: swapRouterAbi, functionName: "refundETH" }),
            ],
          ],
        }),
        value: hypeIn,
        label: "StockiumSwap buy",
      },
    ],
    sellApprovals: (me, amt) => approveTxs(ely, token, me, S.swapRouter, amt, "StockiumSwap"),
    // As stockium.fun: exactInput to address(0) (the router), then unwrapWETH9 to the wallet.
    buildSell: (amt, minOut, me, deadline): TxReq[] => [
      {
        to: S.swapRouter,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "multicall",
          args: [
            [
              encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInput", args: [{ path: sellPath, recipient: ZERO, deadline, amountIn: amt, amountOutMinimum: minOut }] }),
              encodeFunctionData({ abi: swapRouterAbi, functionName: "unwrapWETH9", args: [minOut, me] }),
            ],
          ],
        }),
        label: "StockiumSwap sell",
      },
    ],
    spotPrice: async () => {
      const ps = await Promise.all(hops.map((h) => v3Spot(ely, h.pool, h.base)));
      return ps.reduce((a, b) => a * b, 1);
    },
    liquidityHype: async () => {
      const last = hops.at(-1)!;
      const w = Number(await ely.readContract({ address: S.whype, abi: erc20Abi, functionName: "balanceOf", args: [last.pool] })) / 1e18;
      return hops.length === 1 ? w : null;
    },
  };
}

/** Before graduation: the curve's own buy/sell on HyperEVM, as the site calls them. */
function stockiumCurve(curve: Address, token: Address): Venue {
  return {
    pad: "Stockium",
    kind: "stockium-curve",
    label: "Stockium bonding curve (HyperEVM)",
    chainId: hyperEvm.id,
    transport: "hyperevm",
    token,
    quoteBuy: async (x) => (await hyperClient.readContract({ address: curve, abi: stockiumCurveAbi, functionName: "quoteBuy", args: [x] }))[0],
    quoteSell: async (x) => (await hyperClient.readContract({ address: curve, abi: stockiumCurveAbi, functionName: "quoteSell", args: [x] }))[0],
    buildBuy: (hypeIn, minOut): TxReq[] => [
      { to: curve, data: encodeFunctionData({ abi: stockiumCurveAbi, functionName: "buy", args: [minOut, 0n] }), value: hypeIn, label: "Stockium curve buy" },
    ],
    sellApprovals: (me, amt) => approveTxs(hyperClient, token, me, curve, amt, "Stockium curve"),
    buildSell: (amt, minOut): TxReq[] => [{ to: curve, data: encodeFunctionData({ abi: stockiumCurveAbi, functionName: "sell", args: [amt, minOut] }), label: "Stockium curve sell" }],
    spotPrice: async () => Number((await hyperClient.readContract({ address: curve, abi: stockiumCurveAbi, functionName: "state" }))[5]) / 1e18,
    liquidityHype: async () => Number((await hyperClient.readContract({ address: curve, abi: stockiumCurveAbi, functionName: "state" }))[2]) / 1e18,
  };
}
