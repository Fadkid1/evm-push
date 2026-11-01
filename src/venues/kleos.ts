import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { elysium } from "../chains.js";
import { kleosCall, kleosClient } from "../chain/clients.js";
import { erc20Abi, kleosLaunchpadAbi, kleosLauncherAbi, kleosRouterAbi, quoterV2Abi, swapRouterAbi, v3PoolAbi } from "./abis.js";
import { KLEOS } from "./addresses.js";
import { approveTxs } from "./v3.js";
import { ZERO, type TxReq, type Venue } from "./types.js";

const ZERO_ID = /^0x0+$/;
const client = kleosClient;

type Call = { abi: readonly unknown[]; functionName: string; args?: unknown[]; data?: Hex };
const enc = encodeFunctionData as unknown as (c: Call) => Hex;
const dec = decodeFunctionResult as unknown as (c: Call) => unknown;

/** A view call through kleos_queueCall, decoded. */
async function quoteCall<T>(abi: readonly unknown[], to: Address, functionName: string, args: unknown[]): Promise<T> {
  const out = await kleosCall(to, enc({ abi, functionName, args }));
  return dec({ abi, functionName, data: out }) as T;
}

/** KLEOS price in HYPE, from whichever Kleos launchpad launched it (how the site prices KLEOS pairs). */
async function kleosPairPrice(quote: Address): Promise<number> {
  for (const lp of [KLEOS.launchpad, ...KLEOS.legacyLaunchpads]) {
    const p = await client.readContract({ address: lp, abi: kleosLaunchpadAbi, functionName: "spotPrice", args: [quote] }).catch(() => 0n);
    if (p > 0n) return Number(p) / 1e18;
  }
  return 0;
}

/**
 * Finds the Kleos generation that launched `token`, in the order the Kleos site looks it up:
 * KleosSwap launchpads (v3), the v4 launcher, then the KLEOS-pair launchers.
 */
export async function detectKleos(token: Address): Promise<Venue | null> {
  const v3Pads = [KLEOS.launchpad, ...KLEOS.legacyLaunchpads];
  const [v3, v4, pairs] = await Promise.all([
    Promise.all(v3Pads.map((lp) => client.readContract({ address: lp, abi: kleosLaunchpadAbi, functionName: "getLaunch", args: [token] }).catch(() => null))),
    client.readContract({ address: KLEOS.v4.launcher, abi: kleosLauncherAbi, functionName: "getLaunch", args: [token] }).catch(() => null),
    Promise.all(KLEOS.pairs.map((p) => client.readContract({ address: p.launcher, abi: kleosLauncherAbi, functionName: "getLaunch", args: [token] }).catch(() => null))),
  ]);
  const i3 = v3.findIndex((l) => l && l.pool !== ZERO);
  if (i3 >= 0) {
    const pool = v3[i3]!.pool;
    const fee = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" });
    return kleosV3(token, v3Pads[i3]!, pool, fee);
  }
  if (v4 && !ZERO_ID.test(v4.poolId)) return kleosRouterVenue(token, "kleos-v4", KLEOS.v4.launcher, KLEOS.v4.router, "Kleos v4 router (HYPE pool)");
  const ip = pairs.findIndex((l) => l && !ZERO_ID.test(l.poolId));
  if (ip >= 0) {
    const p = KLEOS.pairs[ip]!;
    return kleosRouterVenue(token, "kleos-pair", p.launcher, p.router, `Kleos pair router (HYPE → ${p.symbol} → token)`, p.quote);
  }
  return null;
}

const base = { pad: "Kleos" as const, chainId: elysium.id, transport: "kleos" as const };

/** Kleos v4 and KLEOS-pair launches: the Kleos router's own buy/sell, HYPE in and out. */
function kleosRouterVenue(token: Address, kind: "kleos-v4" | "kleos-pair", launcher: Address, router: Address, label: string, pairQuote?: Address): Venue {
  return {
    ...base,
    kind,
    label,
    token,
    quoteBuy: (hypeIn) => quoteCall<bigint>(kleosRouterAbi, router, "quoteBuy", [token, hypeIn]),
    quoteSell: (amt) => quoteCall<bigint>(kleosRouterAbi, router, "quoteSell", [token, amt]),
    buildBuy: (hypeIn, minOut, me, deadline): TxReq[] => [
      { to: router, data: encodeFunctionData({ abi: kleosRouterAbi, functionName: "buy", args: [token, minOut, me, deadline] }), value: hypeIn, label: "Kleos router buy" },
    ],
    sellApprovals: (me, amt) => approveTxs(client, token, me, router, amt, "Kleos router"),
    buildSell: (amt, minOut, me, deadline): TxReq[] => [
      { to: router, data: encodeFunctionData({ abi: kleosRouterAbi, functionName: "sell", args: [token, amt, minOut, me, deadline] }), label: "Kleos router sell" },
    ],
    spotPrice: async () => {
      const p = Number(await client.readContract({ address: launcher, abi: kleosLauncherAbi, functionName: "spotPrice", args: [token] })) / 1e18;
      return pairQuote ? p * (await kleosPairPrice(pairQuote)) : p;
    },
    liquidityHype: async () => null,
  };
}

/** First-generation launches: KleosSwap (FluxSwap v3) pool against Kleos WHYPE, through its SwapRouter. */
function kleosV3(token: Address, launchpad: Address, pool: Address, fee: number): Venue {
  const q = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
    (await quoteCall<readonly [bigint]>(quoterV2Abi, KLEOS.quoterV2, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]))[0];
  return {
    ...base,
    kind: "kleos-v3",
    label: "KleosSwap pool (Kleos SwapRouter)",
    token,
    quoteBuy: (hypeIn) => q(KLEOS.whype, token, hypeIn),
    quoteSell: (amt) => q(token, KLEOS.whype, amt),
    buildBuy: (hypeIn, minOut, me, deadline) => [
      {
        to: KLEOS.swapRouter,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "exactInputSingle",
          args: [{ tokenIn: KLEOS.whype, tokenOut: token, fee, recipient: me, deadline, amountIn: hypeIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
        }),
        value: hypeIn,
        label: "KleosSwap buy",
      },
    ],
    sellApprovals: (me, amt) => approveTxs(client, token, me, KLEOS.swapRouter, amt, "KleosSwap"),
    // The site swaps to the router itself, then unwraps WHYPE to the wallet in the same multicall.
    buildSell: (amt, minOut, me, deadline) => [
      {
        to: KLEOS.swapRouter,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "multicall",
          args: [
            [
              encodeFunctionData({
                abi: swapRouterAbi,
                functionName: "exactInputSingle",
                args: [{ tokenIn: token, tokenOut: KLEOS.whype, fee, recipient: KLEOS.swapRouter, deadline, amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
              }),
              encodeFunctionData({ abi: swapRouterAbi, functionName: "unwrapWETH9", args: [minOut, me] }),
            ],
          ],
        }),
        label: "KleosSwap sell",
      },
    ],
    spotPrice: async () => Number(await client.readContract({ address: launchpad, abi: kleosLaunchpadAbi, functionName: "spotPrice", args: [token] })) / 1e18,
    liquidityHype: async () => Number(await client.readContract({ address: KLEOS.whype, abi: erc20Abi, functionName: "balanceOf", args: [pool] })) / 1e18,
  };
}
