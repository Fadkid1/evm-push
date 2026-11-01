import { defineChain, type Address } from "viem";

/** HyperEVM: where HYPE lives, where Stockium bonding curves trade, and Elysium's parent chain. */
export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz/evm"] } },
  blockExplorers: { default: { name: "HyperEVMScan", url: "https://hyperevmscan.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Elysium: the Arbitrum Orbit chain on HyperEVM (gas in HYPE) where Kleos, ElysPump and StockiumSwap pools live. */
export const elysium = defineChain({
  id: 99901,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-live.elysp.com"] } },
  blockExplorers: { default: { name: "Elysium scan", url: "https://scan.elysp.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const HYPEREVM_RPCS = [
  "https://rpc.hyperliquid.xyz/evm",
  "https://hyperliquid-json-rpc.stakely.io",
  "https://rpc.hypurrscan.io",
  "https://rpc.hyperlend.finance",
];

/**
 * Each launchpad's own Elysium endpoint. A trade is sent where that launchpad's site sends it:
 * - ElysPump: its live RPC (executes on the live feed, the relay posts it to the inbox).
 * - Stockium: its own RPC, plus ElysPump's live RPC (the site broadcasts to both).
 * - Kleos: its relay RPC, then the signed tx is posted to the Elysium inbox on HyperEVM.
 */
export const ELYSIUM_RPC = {
  elysp: "https://rpc-live.elysp.com",
  stockium: "https://rpc.stockium.fun",
  kleos: "https://rpc.thekleos.xyz/rpc",
} as const;

/** Arbitrum Orbit contracts of Elysium on HyperEVM. */
export const ORBIT = {
  inbox: "0xce59f8b65ad41c9dae4c07a0571a39824bd92cff" as Address,
  bridge: "0x503d572157113faaad4dbed2647bb10b949216b6" as Address,
};

export const explorerTx = (chainId: number, hash: string) =>
  chainId === hyperEvm.id ? `https://hyperevmscan.io/tx/${hash}` : `https://scan.elysp.com/#/tx/${hash}`;
