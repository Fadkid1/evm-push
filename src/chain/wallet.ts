import {
  concatHex,
  encodeFunctionData,
  keccak256,
  numberToHex,
  size,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_RPC, HYPEREVM_RPCS, ORBIT, elysium, hyperEvm } from "../chains.js";
import { inboxAbi } from "../venues/abis.js";
import type { Transport, TxReq } from "../venues/types.js";
import { clientFor, elyClient, hyperClient, rawRpc } from "./clients.js";

export interface Sent {
  hash: Hex;
  req: TxReq;
}

export interface BatchResult {
  sent: Sent[];
  receipts: TransactionReceipt[];
  /** Set when the last tx isn't confirmed yet (e.g. Kleos inbox route still waiting for its batch). */
  pending?: string;
  /** For the Kleos route: the HyperEVM inbox tx that posted the signed trades. */
  inboxTx?: Hex;
}

/** RPC endpoints a raw Elysium tx goes to, per launchpad (what each site does). */
const SUBMIT: Record<Exclude<Transport, "hyperevm">, string[]> = {
  elysp: [ELYSIUM_RPC.elysp],
  stockium: [ELYSIUM_RPC.stockium, ELYSIUM_RPC.elysp],
  kleos: [ELYSIUM_RPC.kleos],
};
/** Where to look for receipts. */
const RECEIPTS: Record<Transport, string[]> = {
  elysp: [ELYSIUM_RPC.elysp],
  stockium: [ELYSIUM_RPC.stockium, ELYSIUM_RPC.elysp],
  kleos: [ELYSIUM_RPC.kleos, ELYSIUM_RPC.elysp],
  hyperevm: HYPEREVM_RPCS,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Arbitrum inbox L2 message for signed txs, the encoding Kleos uses: one tx = 0x04 ++ raw;
 * several = 0x03 ++ for each (uint64 length ++ 0x04 ++ raw).
 */
export function encodeL2Message(raws: Hex[]): Hex {
  const msgs = raws.map((r) => concatHex(["0x04", r]));
  if (msgs.length === 1) return msgs[0]!;
  return concatHex(["0x03", ...msgs.flatMap((m) => [numberToHex(size(m), { size: 8 }), m])]);
}

/** Signs and submits transactions with one key on HyperEVM and Elysium. No prompts: every call sends. */
export class Wallet {
  readonly account: PrivateKeyAccount;
  private nonces = new Map<number, number>();
  private locks = new Map<number, Promise<unknown>>();
  private gasPrices = new Map<string, { at: number; price: bigint }>();
  /** A Kleos-route tx that may still be waiting in the inbox; later Elysium txs must not jump its nonce. */
  private kleosInflight: Promise<unknown> | null = null;

  constructor(privateKey: Hex, readonly dryRun: boolean) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  balance(chainId: number): Promise<bigint> {
    return (chainId === hyperEvm.id ? hyperClient : elyClient).getBalance({ address: this.address });
  }

  /** Runs fn with this chain's nonce sequence locked, so concurrent trades never reuse a nonce. */
  private async locked<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chainId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(chainId, run);
    return run;
  }

  private async nextNonce(chainId: number, transport: Transport): Promise<number> {
    const cached = this.nonces.get(chainId);
    if (cached !== undefined) return cached;
    // Highest pending count any endpoint reports, as Stockium's site does.
    const urls = chainId === hyperEvm.id ? HYPEREVM_RPCS : [...new Set([...SUBMIT[transport as keyof typeof SUBMIT], ELYSIUM_RPC.elysp, ELYSIUM_RPC.stockium, ELYSIUM_RPC.kleos])];
    const counts = await Promise.all(urls.map((u) => rawRpc<Hex>(u, "eth_getTransactionCount", [this.address, "pending"]).then(Number).catch(() => -1)));
    const n = Math.max(...counts);
    if (n < 0) throw new Error("Couldn't read the wallet nonce from any RPC");
    return n;
  }

  private async gasPrice(chainId: number, transport: Transport): Promise<bigint> {
    const key = `${chainId}:${transport}`;
    const hit = this.gasPrices.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.price;
    const base = await clientFor(transport).getGasPrice();
    // Elysium: 2x the node's price (Stockium's choice), HyperEVM: +25%.
    const price = chainId === hyperEvm.id ? (base * 125n) / 100n : base * 2n;
    this.gasPrices.set(key, { at: Date.now(), price });
    return price;
  }

  private async submit(transport: Transport, raw: Hex): Promise<void> {
    if (transport === "hyperevm") {
      await hyperClient.sendRawTransaction({ serializedTransaction: raw });
      return;
    }
    const results = await Promise.allSettled(SUBMIT[transport].map((u) => rawRpc<Hex>(u, "eth_sendRawTransaction", [raw], 20_000)));
    if (results.some((r) => r.status === "fulfilled")) return;
    const msgs = results.map((r) => (r as PromiseRejectedResult).reason?.message ?? "").filter(Boolean);
    if (msgs.some((m) => /already known|known transaction|already imported/i.test(m))) return;
    throw new Error(msgs[0] ?? "transaction rejected");
  }

  /**
   * Signs the txs with consecutive nonces and submits them in order through the launchpad's own transport.
   * Txs without a gas limit are estimated (so only the first tx of a batch, or one after mined txs, may omit it).
   */
  async sendBatch(chainId: number, transport: Transport, reqs: TxReq[]): Promise<Sent[]> {
    if (chainId === elysium.id && transport !== "kleos" && this.kleosInflight) {
      await Promise.race([this.kleosInflight.catch(() => {}), sleep(180_000)]);
    }
    return this.locked(chainId, async () => {
      const client = clientFor(transport);
      const [nonce0, gasPrice] = await Promise.all([this.nextNonce(chainId, transport), this.gasPrice(chainId, transport)]);
      const sent: Sent[] = [];
      let nonce = nonce0;
      try {
        for (const req of reqs) {
          let gas = req.gas;
          if (gas === undefined) {
            const est = await client.estimateGas({ account: this.address, to: req.to, data: req.data, value: req.value ?? 0n });
            gas = (est * 13n) / 10n + 30_000n;
          }
          const raw = await this.account.signTransaction({
            chainId,
            type: "legacy",
            nonce,
            to: req.to,
            data: req.data,
            value: req.value ?? 0n,
            gas,
            gasPrice,
          });
          const hash = keccak256(raw);
          if (!this.dryRun) await this.submit(transport, raw);
          sent.push({ hash, req });
          nonce++;
        }
      } catch (e) {
        // Something was rejected: forget the cached nonce so the next send re-reads it from the chain.
        this.nonces.delete(chainId);
        if (sent.length) this.nonces.set(chainId, nonce);
        throw e;
      }
      if (!this.dryRun) this.nonces.set(chainId, nonce);
      return sent;
    });
  }

  async receipt(transport: Transport, hash: Hex, timeoutMs: number): Promise<TransactionReceipt | null> {
    const end = Date.now() + timeoutMs;
    const client = clientFor(transport);
    while (Date.now() < end) {
      for (const u of RECEIPTS[transport]) {
        const r = await rawRpc<Record<string, unknown> | null>(u, "eth_getTransactionReceipt", [hash]).catch(() => null);
        if (r) return client.getTransactionReceipt({ hash }).catch(() => formatReceipt(r));
      }
      await sleep(transport === "hyperevm" ? 1500 : 700);
    }
    return null;
  }

  /**
   * Sends a batch and waits for it. On the Kleos route this also posts the signed txs into the Elysium inbox
   * from this wallet on HyperEVM (kleos_held -> sendL2Message), the fast path the Kleos site offers.
   */
  async execute(chainId: number, transport: Transport, reqs: TxReq[]): Promise<BatchResult> {
    const sent = await this.sendBatch(chainId, transport, reqs);
    if (this.dryRun) return { sent, receipts: [] };
    let inboxTx: Hex | undefined;
    let kleosNote: string | undefined;
    if (transport === "kleos") {
      const posted = await this.postKleosHeld(sent.map((s) => s.hash)).catch((e: Error) => ({ note: e.message }));
      if ("hash" in posted) inboxTx = posted.hash;
      else kleosNote = posted.note;
    }
    const timeout = transport === "kleos" ? 240_000 : transport === "hyperevm" ? 90_000 : 60_000;
    const wait = (async () => {
      const receipts: TransactionReceipt[] = [];
      for (const s of sent) {
        const r = await this.receipt(transport, s.hash, timeout);
        if (!r) return { receipts, pending: s.hash };
        receipts.push(r);
        if (r.status !== "success") break;
      }
      return { receipts, pending: undefined as Hex | undefined };
    })();
    if (transport === "kleos") this.kleosInflight = wait.finally(() => (this.kleosInflight = null));
    const { receipts, pending } = await wait;
    if (pending) this.nonces.delete(chainId);
    return {
      sent,
      receipts,
      inboxTx,
      pending: pending ? (transport === "kleos" ? `Waiting for the Elysium inbox batch${kleosNote ? ` (${kleosNote})` : ""}` : "Not confirmed yet") : undefined,
    };
  }

  /** Kleos relay: post the txs it holds for this wallet into the Elysium inbox, paying HyperEVM gas from this wallet. */
  private async postKleosHeld(hashes: Hex[]): Promise<{ hash: Hex } | { note: string }> {
    const held = await rawRpc<Array<{ raw: Hex; freeAt?: number }>>(ELYSIUM_RPC.kleos, "kleos_held", [this.address, hashes]).catch(() => []);
    if (!held.length) return { note: "the Kleos relay is posting it" };
    const data = encodeFunctionData({ abi: inboxAbi, functionName: "sendL2Message", args: [encodeL2Message(held.map((h) => h.raw))] });
    const [gas, price, bal] = await Promise.all([
      hyperClient.estimateGas({ account: this.address, to: ORBIT.inbox, data }),
      hyperClient.getGasPrice(),
      hyperClient.getBalance({ address: this.address }),
    ]);
    if (bal < gas * price * 2n) return { note: "no HYPE on HyperEVM for the inbox gas, so the Kleos relay will post it" };
    const [s] = await this.sendBatch(hyperEvm.id, "hyperevm", [{ to: ORBIT.inbox, data, gas: (gas * 125n) / 100n, label: "post to Elysium inbox" }]);
    void rawRpc(ELYSIUM_RPC.kleos, "kleos_submitted", [s!.hash]).catch(() => {});
    return { hash: s!.hash };
  }

  /** HyperEVM -> Elysium: Orbit inbox depositEth (what ElysPump's bridge sends). Resolves once Elysium has credited it. */
  async depositToElysium(amount: bigint): Promise<{ hash: Hex; credited: boolean }> {
    const data = encodeFunctionData({ abi: inboxAbi, functionName: "depositEth" });
    const res = await this.execute(hyperEvm.id, "hyperevm", [{ to: ORBIT.inbox, data, value: amount, label: "deposit HYPE to Elysium" }]);
    const hash = res.sent[0]!.hash;
    const rc = res.receipts[0];
    if (!rc) return { hash, credited: false };
    if (rc.status !== "success") throw new Error("The deposit reverted on HyperEVM");
    // MessageDelivered(messageIndex indexed, ...) from the bridge: credited once Elysium has read past that index.
    const ev = rc.logs.find((l) => l.address.toLowerCase() === ORBIT.bridge && l.topics[0] === "0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1");
    if (!ev?.topics[1]) return { hash, credited: false };
    const index = BigInt(ev.topics[1]);
    for (let i = 0; i < 120; i++) {
      const b = await rawRpc<{ nonce?: Hex }>(ELYSIUM_RPC.elysp, "eth_getBlockByNumber", ["latest", false]).catch(() => null);
      if (b?.nonce && BigInt(b.nonce) > index) return { hash, credited: true };
      await sleep(2000);
    }
    return { hash, credited: false };
  }
}

/** Minimal receipt shape from a raw JSON-RPC receipt (when the typed client can't fetch it). */
function formatReceipt(r: Record<string, unknown>): TransactionReceipt {
  return {
    ...(r as object),
    status: r.status === "0x1" ? "success" : "reverted",
    blockNumber: BigInt(r.blockNumber as string),
    gasUsed: BigInt(r.gasUsed as string),
    effectiveGasPrice: BigInt((r.effectiveGasPrice as string) ?? "0x0"),
    logs: ((r.logs as Array<Record<string, unknown>>) ?? []).map((l) => ({ ...l, address: (l.address as string).toLowerCase() })),
  } as unknown as TransactionReceipt;
}
