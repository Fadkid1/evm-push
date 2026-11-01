import { createPublicClient, fallback, http, type Address, type Hex, type PublicClient } from "viem";
import { ELYSIUM_RPC, HYPEREVM_RPCS, elysium, hyperEvm } from "../chains.js";
import type { Transport } from "../venues/types.js";

const opts = { timeout: 10_000, retryCount: 1 };

export const hyperClient = createPublicClient({
  chain: hyperEvm,
  transport: fallback(HYPEREVM_RPCS.map((u) => http(u, opts))),
  batch: { multicall: true },
}) as PublicClient;

/** Elysium reads through ElysPump's live RPC (live-feed state, the same state every pad trades on). */
export const elyClient = createPublicClient({
  chain: elysium,
  transport: fallback([http(ELYSIUM_RPC.elysp, opts), http(ELYSIUM_RPC.stockium, opts)]),
  batch: { multicall: true },
}) as PublicClient;

/** Stockium's own RPC first, as its site reads. */
export const stockiumClient = createPublicClient({
  chain: elysium,
  transport: fallback([http(ELYSIUM_RPC.stockium, opts), http(ELYSIUM_RPC.elysp, opts)]),
  batch: { multicall: true },
}) as PublicClient;

/** The Kleos relay RPC: it also knows the transactions it is holding for the inbox. */
export const kleosClient = createPublicClient({
  chain: elysium,
  transport: fallback([http(ELYSIUM_RPC.kleos, opts), http(ELYSIUM_RPC.elysp, opts)]),
}) as PublicClient;

export function clientFor(t: Transport): PublicClient {
  return t === "hyperevm" ? hyperClient : t === "kleos" ? kleosClient : t === "stockium" ? stockiumClient : elyClient;
}

export async function rawRpc<T>(url: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await res.json().catch(() => ({}))) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? `${method} failed`);
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  return j.result as T;
}

/**
 * Kleos quotes run against the relay's queued state (kleos_queueCall), exactly as the Kleos site quotes,
 * so a quote already counts trades the relay is still holding. Falls back to a plain live-RPC call.
 */
export async function kleosCall(to: Address, data: Hex): Promise<Hex> {
  try {
    const r = await rawRpc<Hex>(ELYSIUM_RPC.kleos, "kleos_queueCall", [{ to, data }]);
    if (typeof r === "string" && r !== "0x") return r;
  } catch (e) {
    if (/revert/i.test((e as Error).message)) throw e;
  }
  const { data: out } = await elyClient.call({ to, data });
  if (!out) throw new Error("the quote returned nothing");
  return out;
}
