import { concatHex, encodePacked, numberToHex, size, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeL2Message } from "../src/chain/wallet.js";
import { ELYSP } from "../src/venues/addresses.js";
import { v4SwapCalldata } from "../src/venues/elysp.js";
import { encodePath } from "../src/venues/v3.js";

// elysp.com's own hand-written V2.x encoder (launchpad v2 trading script), ported verbatim.
const V2 = { lpFee: ELYSP.v2.lpFee, tickSpacing: ELYSP.v2.tickSpacing, hook: ELYSP.v2.hook };
const w = (x: bigint | string) => (typeof x === "bigint" ? x.toString(16) : String(x).replace(/^0x/, "")).toLowerCase().padStart(64, "0");
const hx = (s: string) => s.replace(/^0x/, "");
const bl = (s: string) => {
  s = hx(s);
  return w(BigInt(s.length / 2)) + s.padEnd(Math.ceil(s.length / 64) * 64, "0");
};
const key = (t: string) => w("0") + w(t) + w(BigInt(V2.lpFee)) + w(BigInt(V2.tickSpacing)) + w(V2.hook);
function siteV2x(t: string, buy: boolean, amt: bigint, min: bigint, dl: bigint): string {
  const Z = "0".repeat(40),
    ci = buy ? Z : hx(t),
    co = buy ? hx(t) : Z,
    p0 = w(32n) + key(t) + w(buy ? 1n : 0n) + w(amt) + w(min) + w(288n) + w(0n),
    p1 = w(ci) + w(amt),
    p2 = w(co) + w(min),
    ps = [p0, p1, p2];
  const offs: string[] = [];
  let o = 96;
  for (const p of ps) {
    offs.push(w(BigInt(o)));
    o += 32 + p.length / 2;
  }
  const arr = w(3n) + offs.join("") + ps.map(bl).join(""),
    inp = w(64n) + w(128n) + bl("060c0f") + arr;
  return "0x3593564c" + w(96n) + w(160n) + w(dl) + bl("10") + w(1n) + w(32n) + bl(inp);
}

// Kleos's inbox message builder (al) for signed txs, ported.
function siteL2Message(raws: Hex[]): Hex {
  const t = raws.map((e) => concatHex(["0x04", e]));
  return t.length === 1 ? t[0]! : concatHex(["0x03", ...t.flatMap((e) => [numberToHex(size(e), { size: 8 }), e])]);
}

// Stockium's hubPath, ported.
function siteHubPath(side: "buy" | "sell", token: Address, pair: Address, poolFee: number, hubFee: number, whype: Address): Hex {
  return side === "buy"
    ? encodePacked(["address", "uint24", "address", "uint24", "address"], [whype, hubFee, pair, poolFee, token])
    : encodePacked(["address", "uint24", "address", "uint24", "address"], [token, poolFee, pair, hubFee, whype]);
}

const TOKEN = "0x84dc97aa81ec1b4456025976e7bbb19febdf4623" as Address;

describe("ElysPump v2 Universal Router calldata", () => {
  it("matches elysp.com byte for byte (buy)", () => {
    const dl = 1_800_000_000n;
    expect(v4SwapCalldata(TOKEN, true, 10n ** 16n, 12345n, dl)).toBe(siteV2x(TOKEN, true, 10n ** 16n, 12345n, dl));
  });
  it("matches elysp.com byte for byte (sell)", () => {
    const dl = 1_800_000_123n;
    expect(v4SwapCalldata(TOKEN, false, 987654321n * 10n ** 9n, 1n, dl)).toBe(siteV2x(TOKEN, false, 987654321n * 10n ** 9n, 1n, dl));
  });
});

describe("Kleos inbox message", () => {
  it("one tx", () => {
    expect(encodeL2Message(["0x02aabb"])).toBe(siteL2Message(["0x02aabb"]));
  });
  it("batch of txs", () => {
    const raws: Hex[] = ["0x02aabbcc", "0xf86c01", "0x02" + "ff".repeat(300) as Hex];
    expect(encodeL2Message(raws)).toBe(siteL2Message(raws));
  });
});

describe("Stockium hub path", () => {
  const whype = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address;
  const hub = "0x1E0Cc793904F7D33fc632E97FE23B81a00a762a3" as Address;
  it("buy and sell paths match the site's hubPath", () => {
    expect(encodePath([whype, hub, TOKEN], [10000, 3000])).toBe(siteHubPath("buy", TOKEN, hub, 3000, 10000, whype));
    expect(encodePath([TOKEN, hub, whype], [3000, 10000])).toBe(siteHubPath("sell", TOKEN, hub, 3000, 10000, whype));
  });
});
