import "dotenv/config";
import type { Hex } from "viem";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing ${key} in .env (see .env.example)`);
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

export interface Config {
  botToken: string;
  adminId: number;
  privateKey: Hex;
  dryRun: boolean;
  dbPath: string;
}

export function loadConfig(): Config {
  const adminId = Number(required("ADMIN_ID"));
  if (!Number.isSafeInteger(adminId)) throw new Error("ADMIN_ID must be your numeric Telegram user ID");
  let privateKey = required("PRIVATE_KEY");
  if (!privateKey.startsWith("0x")) privateKey = `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("PRIVATE_KEY must be a 32-byte hex EVM private key (64 hex characters)");
  return {
    botToken: required("BOT_TOKEN"),
    adminId,
    privateKey: privateKey as Hex,
    dryRun: process.env.DRY_RUN?.trim() === "true",
    dbPath: optional("DB_PATH") ?? "data/bot.db",
  };
}
