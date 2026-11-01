import { encodeFunctionData, encodePacked, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi, v3PoolAbi } from "./abis.js";
import { GAS, MAX_UINT256, type TxReq } from "./types.js";

const Q96 = 2 ** 96;

/** Uniswap v3 path: token, fee, token, fee, token... */
export function encodePath(tokens: Address[], fees: number[]): Hex {
  const types: string[] = [];
  const values: unknown[] = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  });
  return encodePacked(types, values);
}

/** Price of `base` in units of the pool's other token, from slot0 (both 18 decimals on these pads). */
export async function v3Spot(client: PublicClient, pool: Address, base: Address): Promise<number> {
  const [slot, token0] = await Promise.all([
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
  ]);
  const p = (Number(slot[0]) / Q96) ** 2; // token1 per token0
  if (!(p > 0)) return 0;
  return token0.toLowerCase() === base.toLowerCase() ? p : 1 / p;
}

export async function balanceIn(client: PublicClient, token: Address, holder: Address): Promise<number> {
  const b = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  return Number(b) / 1e18;
}

/** An approve(spender, max) tx when the allowance doesn't cover `amount`, so later sells skip it. */
export async function approveTxs(client: PublicClient, token: Address, owner: Address, spender: Address, amount: bigint, what: string): Promise<TxReq[]> {
  const a = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (a >= amount) return [];
  return [
    {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, MAX_UINT256] }),
      gas: GAS.approve,
      label: `approve ${what}`,
    },
  ];
}
