import type { Address, Hex } from "viem";

export type Pad = "Kleos" | "ElysPump" | "Stockium";

/** Which endpoint a launchpad's own site submits through (see ELYSIUM_RPC). */
export type Transport = "kleos" | "elysp" | "stockium" | "hyperevm";

export interface TxReq {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Fixed gas limit; undefined = estimate (only possible when no earlier tx in the batch is unmined). */
  gas?: bigint;
  /** Short description for logs and dry runs. */
  label: string;
}

/** Where a token was launched, and so exactly how its own site trades it. */
export interface Venue {
  kind: "kleos-v3" | "kleos-v4" | "kleos-pair" | "elysp-v1" | "elysp-v2" | "stockium-swap" | "stockium-curve";
  pad: Pad;
  /** Human-readable route, shown on the token card. */
  label: string;
  chainId: number;
  transport: Transport;
  /** The token as it exists on chainId. */
  token: Address;
  /** Expected token out for an exact HYPE input. */
  quoteBuy(hypeIn: bigint): Promise<bigint>;
  /** Expected HYPE out for an exact token input. */
  quoteSell(tokenIn: bigint): Promise<bigint>;
  buildBuy(hypeIn: bigint, minOut: bigint, me: Address, deadline: bigint): TxReq[];
  /** Approvals the sell needs first (empty when already approved). */
  sellApprovals(me: Address, amount: bigint): Promise<TxReq[]>;
  buildSell(tokenIn: bigint, minOut: bigint, me: Address, deadline: bigint): TxReq[];
  /** Spot price in HYPE per whole token (18-decimals tokens assumed by every pad). */
  spotPrice(): Promise<number>;
  /** HYPE in the pool (one side), when cheap to read. */
  liquidityHype(): Promise<number | null>;
}

export const MAX_UINT256 = 2n ** 256n - 1n;
export const MAX_UINT160 = 2n ** 160n - 1n;
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Fixed gas limits the sites use, for txs sent right behind an approval that hasn't executed yet. */
export const GAS = { approve: 120_000n, swap: 1_500_000n, transfer: 100_000n };
