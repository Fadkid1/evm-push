import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { elysium } from "../chains.js";
import { elyClient } from "../chain/clients.js";
import { erc20Abi, permit2Abi, quoterV2Abi, stateViewAbi, swapRouterAbi, universalRouterAbi, v3FactoryAbi, v4QuoterAbi } from "./abis.js";
import { ELYSP } from "./addresses.js";
import { approveTxs, v3Spot } from "./v3.js";
import { GAS, MAX_UINT160, MAX_UINT256, ZERO, type TxReq, type Venue } from "./types.js";

const client = elyClient;
const base = { pad: "ElysPump" as const, chainId: elysium.id, transport: "elysp" as const };
const V2 = ELYSP.v2;
const V1 = ELYSP.v1;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** ElysPump v2 pool key: native HYPE (currency0) / token, with the ElysPump hook. */
export const elyspKey = (token: Address): PoolKey => ({ currency0: ZERO, currency1: token, fee: V2.lpFee, tickSpacing: V2.tickSpacing, hooks: V2.hook });

export const poolId = (k: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );

const keyTuple = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/** V4 actions: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f). */
const ACTIONS: Hex = "0x060c0f";
/** Universal Router command V4_SWAP. */
const V4_SWAP: Hex = "0x10";

/**
 * Universal Router execute() for one exact-in swap on the token's ElysPump v2 pool, byte-for-byte what
 * elysp.com sends (its V2.x encoder): buy = HYPE -> token, sell = token -> HYPE.
 */
export function v4SwapCalldata(token: Address, buy: boolean, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const key = elyspKey(token);
  const [cIn, cOut] = buy ? [ZERO, token] : [token, ZERO];
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "poolKey", ...keyTuple }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    [{ poolKey: key, zeroForOne: buy, amountIn, amountOutMinimum: minOut, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cOut, minOut]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS, [swap, settle, take]]);
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [V4_SWAP, [input], deadline] });
}

async function v2Quote(token: Address, buy: boolean, amount: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: V2.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: elyspKey(token), zeroForOne: buy, exactAmount: amount, hookData: "0x" }],
  });
  return result[0];
}

/** v2 launches first (the current launchpad), then v1 pools on the ElysPump v3 factory. */
export async function detectElysp(token: Address): Promise<Venue | null> {
  const id = poolId(elyspKey(token));
  const [slot, v1Pool] = await Promise.all([
    client.readContract({ address: V2.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }).catch(() => null),
    client.readContract({ address: V1.factory, abi: v3FactoryAbi, functionName: "getPool", args: [token, V1.weth, V1.fee] }).catch(() => ZERO),
  ]);
  if (slot && slot[0] > 0n) return elyspV2(token, id);
  if (v1Pool !== ZERO) return elyspV1(token, v1Pool);
  return null;
}

function elyspV2(token: Address, id: Hex): Venue {
  return {
    ...base,
    kind: "elysp-v2",
    label: "ElysPump v2 pool (Universal Router V4_SWAP)",
    token,
    quoteBuy: (x) => v2Quote(token, true, x),
    quoteSell: (x) => v2Quote(token, false, x),
    buildBuy: (hypeIn, minOut, _me, deadline): TxReq[] => [{ to: V2.router, data: v4SwapCalldata(token, true, hypeIn, minOut, deadline), value: hypeIn, label: "ElysPump v2 buy" }],
    // Sells pull the token through Permit2: token -> Permit2 approval, then Permit2 -> router allowance.
    sellApprovals: async (me, amt) => {
      const [erc, p2] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, V2.permit2] }),
        client.readContract({ address: V2.permit2, abi: permit2Abi, functionName: "allowance", args: [me, token, V2.router] }),
      ]);
      const txs: TxReq[] = [];
      if (erc < amt) txs.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [V2.permit2, MAX_UINT256] }), gas: GAS.approve, label: "approve Permit2" });
      const soon = Math.floor(Date.now() / 1000) + 3600;
      if (p2[0] < amt || p2[1] < soon) {
        const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
        txs.push({ to: V2.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, V2.router, MAX_UINT160, exp] }), gas: GAS.approve, label: "Permit2 approve router" });
      }
      return txs;
    },
    buildSell: (amt, minOut, _me, deadline): TxReq[] => [{ to: V2.router, data: v4SwapCalldata(token, false, amt, minOut, deadline), label: "ElysPump v2 sell" }],
    spotPrice: async () => {
      const [sqrtP] = await client.readContract({ address: V2.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] });
      const tokensPerHype = (Number(sqrtP) / 2 ** 96) ** 2;
      return tokensPerHype > 0 ? 1 / tokensPerHype : 0;
    },
    liquidityHype: async () => null,
  };
}

function elyspV1(token: Address, pool: Address): Venue {
  const q = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
    (await client.simulateContract({ address: V1.quoter, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: V1.fee, sqrtPriceLimitX96: 0n }] })).result[0];
  return {
    ...base,
    kind: "elysp-v1",
    label: "ElysPump v1 pool (ElysPump SwapRouter)",
    token,
    quoteBuy: (x) => q(V1.weth, token, x),
    quoteSell: (x) => q(token, V1.weth, x),
    buildBuy: (hypeIn, minOut, me, deadline): TxReq[] => [
      {
        to: V1.router,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "exactInputSingle",
          args: [{ tokenIn: V1.weth, tokenOut: token, fee: V1.fee, recipient: me, deadline, amountIn: hypeIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
        }),
        value: hypeIn,
        label: "ElysPump v1 buy",
      },
    ],
    sellApprovals: (me, amt) => approveTxs(client, token, me, V1.router, amt, "ElysPump router"),
    // As elysp.com: swap with recipient 0 (the router keeps the WHYPE), then unwrap to the wallet.
    buildSell: (amt, minOut, me, deadline): TxReq[] => [
      {
        to: V1.router,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "multicall",
          args: [
            [
              encodeFunctionData({
                abi: swapRouterAbi,
                functionName: "exactInputSingle",
                args: [{ tokenIn: token, tokenOut: V1.weth, fee: V1.fee, recipient: ZERO, deadline, amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
              }),
              encodeFunctionData({ abi: swapRouterAbi, functionName: "unwrapWETH9", args: [minOut, me] }),
            ],
          ],
        }),
        label: "ElysPump v1 sell",
      },
    ],
    spotPrice: () => v3Spot(client, pool, token),
    liquidityHype: async () => Number(await client.readContract({ address: V1.weth, abi: erc20Abi, functionName: "balanceOf", args: [pool] })) / 1e18,
  };
}
