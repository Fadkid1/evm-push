import { createPublicClient, custom, fallback, http, type PublicClient } from "viem";
import { ELYSIUM_RPC, HYPEREVM_RPCS, elysium, hyperEvm } from "../chains.js";
import type { Transport } from "../venues/types.js";

const opts = { timeout: 10_000, retryCount: 1 };

export const hyperClient = createPublicClient({
  chain: hyperEvm,
  transport: fallback(HYPEREVM_RPCS.map((u) => http(u, opts))),
  batch: { multicall: true },
}) as PublicClient;

/**
 * Sends each request to every endpoint at once and takes the first good answer. ElysPump's live RPC
 * rate-limits under load and Stockium's serves the same live state, so racing them hides either one's spikes.
 */
const race = (urls: string[]) =>
  custom({
    async request({ method, params }) {
      try {
        return await Promise.any(urls.map((u) => rawRpc(u, method, (params as unknown[]) ?? [], 8000)));
      } catch (e) {
        throw (e as AggregateError).errors?.[0] ?? e;
      }
    },
  });

/** Elysium live-feed state (what every pad trades on), from ElysPump's and Stockium's live RPCs. */
export const elyClient = createPublicClient({
  chain: elysium,
  transport: race([ELYSIUM_RPC.elysp, ELYSIUM_RPC.stockium]),
  batch: { multicall: true },
}) as PublicClient;


/**
 * Client for reading state (balances, allowances, quotes, gas estimates) on a venue's chain.
 * Kleos reads use the live RPC too: the Kleos relay serves state that lags the live chain by minutes,
 * which once made a sell use an already-spent balance. The relay is only used to submit Kleos trades.
 */
export function clientFor(t: Transport): PublicClient {
  return t === "hyperevm" ? hyperClient : elyClient;
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
