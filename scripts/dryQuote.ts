// Read-only: resolves tokens to their launchpad route, quotes, and simulates the exact buy tx
// with eth_call from a throwaway address that is given HYPE by a state override. Nothing is signed or sent.
//   npm run quote                       (one sample token per route)
//   npm run quote -- 0xToken <link> ... (your own)
import { formatEther, parseEther, type Address } from "viem";
import { clientFor } from "../src/chain/clients.js";
import { parseInput, resolveVenue } from "../src/venues/resolve.js";

const SAMPLES = [
  "https://www.thekleos.xyz/token/0x021959958a85E1b222597103660AE4adA25168f7", // Kleos v4
  "0xa944FB7A4bfCD518360982A1F8523C6b00A7216C", // Kleos KLEOS pair
  "0xd2CAE9154EF1886ec4A96FBbbf4fA6DA72628d61", // KleosSwap v3
  "https://elysp.com/#/token/0x84dc97aa81ec1b4456025976e7bbb19febdf4623", // ElysPump v2
  "https://stockium.fun/token/0x5E7Fcc0337de896faCb11c1701672c70c688FdEb", // Stockium (graduated curve)
];

const refs = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLES;
const me = "0x00000000000000000000000000000000000b0b01" as Address;
const amount = parseEther("0.01");

for (const ref of refs) {
  const input = parseInput(ref);
  if (!input) {
    console.log(`${ref}\n  not an address or link\n`);
    continue;
  }
  const v = await resolveVenue(input);
  if (!v) {
    console.log(`${ref}\n  no launchpad route found\n`);
    continue;
  }
  console.log(`${ref}\n  ${v.pad} · ${v.label} · chain ${v.chainId} · via ${v.transport} · token ${v.token}`);
  try {
    const [spot, liq, out] = await Promise.all([v.spotPrice(), v.liquidityHype(), v.quoteBuy(amount)]);
    console.log(`  spot ${spot.toExponential(4)} HYPE · liquidity ${liq?.toFixed(3) ?? "–"} HYPE · 0.01 HYPE buys ${formatEther(out)}`);
    const back = await v.quoteSell(out);
    console.log(`  selling those back quotes ${formatEther(back)} HYPE`);
    const [tx] = v.buildBuy(amount, (out * 90n) / 100n, me, BigInt(Math.floor(Date.now() / 1000) + 1200));
    const c = clientFor(v.transport);
    await c.call({ account: me, to: tx!.to, data: tx!.data, value: tx!.value, stateOverride: [{ address: me, balance: parseEther("10") }] });
    console.log(`  ✓ buy tx simulates OK (${tx!.label} → ${tx!.to})`);
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message.split("\n")[0]}`);
  }
  console.log();
}
