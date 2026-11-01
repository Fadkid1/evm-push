import { getAddress, isAddress, type Address } from "viem";
import { detectElysp } from "./elysp.js";
import { detectKleos } from "./kleos.js";
import { detectStockium } from "./stockium.js";
import type { Pad, Venue } from "./types.js";

export interface ParsedInput {
  address: Address;
  /** Launchpad named by the link, tried first. */
  hint?: Pad;
}

const HOSTS: Array<[RegExp, Pad]> = [
  [/thekleos\.xyz/i, "Kleos"],
  [/elysp\.com|elysiumpump\.com/i, "ElysPump"],
  [/stockium\.fun/i, "Stockium"],
];

/** A bare 0x address, or a token link from thekleos.xyz, elysp.com or stockium.fun. */
export function parseInput(text: string): ParsedInput | null {
  const t = text.trim();
  const m = t.match(/0x[0-9a-fA-F]{40}/);
  if (!m || !isAddress(m[0], { strict: false })) return null;
  const hint = HOSTS.find(([re]) => re.test(t))?.[1];
  return { address: getAddress(m[0].toLowerCase()), hint };
}

const DETECT: Record<Pad, (a: Address) => Promise<Venue | null>> = {
  Kleos: detectKleos,
  ElysPump: detectElysp,
  Stockium: detectStockium,
};
/** Without a link, the launch registries are checked in this order; a token only has one launchpad. */
const ORDER: Pad[] = ["Kleos", "ElysPump", "Stockium"];

const cache = new Map<string, { at: number; venue: Venue }>();
const TTL = 60_000;

/** The token's launchpad and its original route. Cached briefly (a Stockium curve can graduate). */
export async function resolveVenue(input: ParsedInput): Promise<Venue | null> {
  const key = input.address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.venue;
  const order = input.hint ? [input.hint, ...ORDER.filter((p) => p !== input.hint)] : ORDER;
  for (const pad of order) {
    const v = await DETECT[pad](input.address).catch(() => null);
    if (v) {
      cache.set(key, { at: Date.now(), venue: v });
      cache.set(v.token.toLowerCase(), { at: Date.now(), venue: v });
      return v;
    }
  }
  return null;
}
