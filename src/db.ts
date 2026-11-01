import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface Settings {
  /** Buy buttons, in HYPE. */
  buyPresets: number[];
  /** Sell buttons, in percent of holdings. */
  sellPresets: number[];
  slippagePct: number;
  /** Positions worth less than this (USD) are hidden. */
  minPositionUsd: number;
}

export const DEFAULT_SETTINGS: Settings = {
  buyPresets: [0.1, 0.5, 1],
  sellPresets: [25, 50, 75, 100],
  slippagePct: 25,
  minPositionUsd: 1,
};

export interface TradeRow {
  /** Wallet that made the trade. */
  account: string;
  chainId: number;
  /** Token address on chainId, lowercase. */
  token: string;
  side: "buy" | "sell";
  hype: number;
  tokens: number;
  usd: number;
  via: string;
  txHash: string;
  ts: number;
}

export interface KnownToken {
  chainId: number;
  token: string;
  /** What to resolve to reopen the card (the pasted address: a curve, a HyperEVM or an Elysium token). */
  ref: string;
}

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refs (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL, chain_id INTEGER NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL,
        hype REAL NOT NULL, tokens REAL NOT NULL, usd REAL NOT NULL,
        via TEXT NOT NULL, tx_hash TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trades_token ON trades(account, chain_id, token);
      CREATE TABLE IF NOT EXISTS known (
        account TEXT NOT NULL, chain_id INTEGER NOT NULL, token TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (account, chain_id, token)
      );
    `);
  }

  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  /** Short numeric id for a token ref, so Telegram button data stays under 64 bytes. */
  refId(ref: string): number {
    const r = ref.toLowerCase();
    this.db.prepare("INSERT OR IGNORE INTO refs (ref) VALUES (?)").run(r);
    return (this.db.prepare("SELECT id FROM refs WHERE ref = ?").get(r) as { id: number }).id;
  }

  ref(id: number): string | null {
    return (this.db.prepare("SELECT ref FROM refs WHERE id = ?").get(id) as { ref: string } | undefined)?.ref ?? null;
  }

  addTrade(t: TradeRow): void {
    this.db
      .prepare("INSERT INTO trades (account, chain_id, token, side, hype, tokens, usd, via, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.account.toLowerCase(), t.chainId, t.token.toLowerCase(), t.side, t.hype, t.tokens, t.usd, t.via, t.txHash, t.ts);
  }

  /** One wallet's logged trades of a token, oldest first. */
  trades(account: string, chainId: number, token: string): TradeRow[] {
    return (
      this.db
        .prepare("SELECT * FROM trades WHERE account = ? AND chain_id = ? AND token = ? ORDER BY ts, id")
        .all(account.toLowerCase(), chainId, token.toLowerCase()) as Array<Record<string, number | string>>
    ).map((r) => ({
      account: String(r.account),
      chainId: Number(r.chain_id),
      token: String(r.token),
      side: r.side as "buy" | "sell",
      hype: Number(r.hype),
      tokens: Number(r.tokens),
      usd: Number(r.usd),
      via: String(r.via),
      txHash: String(r.tx_hash),
      ts: Number(r.ts),
    }));
  }

  remember(account: string, k: KnownToken): void {
    this.db
      .prepare("INSERT INTO known (account, chain_id, token, ref) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET ref = excluded.ref")
      .run(account.toLowerCase(), k.chainId, k.token.toLowerCase(), k.ref.toLowerCase());
  }

  known(account: string): KnownToken[] {
    return (this.db.prepare("SELECT chain_id, token, ref FROM known WHERE account = ?").all(account.toLowerCase()) as Array<{ chain_id: number; token: string; ref: string }>).map((r) => ({
      chainId: r.chain_id,
      token: r.token,
      ref: r.ref,
    }));
  }
}
