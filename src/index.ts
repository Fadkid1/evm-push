import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { Wallet } from "./chain/wallet.js";
import { Trader } from "./trader.js";
import { createBot } from "./bot/app.js";
import { VERSION } from "./version.js";

// A stray rejected promise must never take the bot down.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const wallet = new Wallet(cfg.privateKey, cfg.dryRun);
  const db = new Db(cfg.dbPath);
  const trader = new Trader(wallet, db);
  await wallet.warm();
  const bot = createBot({ token: cfg.botToken, adminId: cfg.adminId, db, trader, dryRun: cfg.dryRun });
  await bot.api.setMyCommands([
    { command: "start", description: "Wallet and menu" },
    { command: "positions", description: "Open positions" },
    { command: "settings", description: "Buy/sell buttons, slippage" },
  ]);

  process.once("SIGINT", () => void bot.stop());
  process.once("SIGTERM", () => void bot.stop());

  console.log(`HYPE Trading Bot v${VERSION}: trading as ${wallet.address}${cfg.dryRun ? " [DRY RUN]" : ""}`);
  await bot.start({ drop_pending_updates: true, allowed_updates: ["message", "callback_query"] });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
