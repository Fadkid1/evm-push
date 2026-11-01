import { describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot/app.js";
import type { Db } from "../src/db.js";
import { DEFAULT_SETTINGS } from "../src/db.js";
import type { Trader } from "../src/trader.js";

const ADMIN = 42;

/** A bot whose Telegram API calls are answered locally; answerCallbackQuery fails like a stale tap. */
function setup() {
  const buy = vi.fn(async () => {
    throw new Error("stub trader");
  });
  const db = { settings: () => DEFAULT_SETTINGS, ref: () => "0x021959958a85e1b222597103660ae4ada25168f7", refId: () => 1 } as unknown as Db;
  const trader = { buy } as unknown as Trader;
  const bot = createBot({ token: "1:x", adminId: ADMIN, db, trader, dryRun: true });
  bot.botInfo = { id: 1, is_bot: true, first_name: "t", username: "t" } as never;
  const calls: string[] = [];
  bot.api.config.use(async (_prev, method) => {
    calls.push(method);
    if (method === "answerCallbackQuery") return { ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" } as never;
    return { ok: true, result: { message_id: 7, chat: { id: ADMIN }, date: 0 } } as never;
  });
  return { bot, buy, calls };
}

const tap = (data: string, from = ADMIN) => ({
  update_id: 1,
  callback_query: { id: "q", from: { id: from, is_bot: false, first_name: "a" }, chat_instance: "c", data, message: { message_id: 5, date: 0, chat: { id: ADMIN, type: "private" } } },
});

describe("button taps", () => {
  it("still trades when Telegram rejects a stale tap's ack, without an unhandled error", async () => {
    const { bot, buy, calls } = setup();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    await bot.handleUpdate(tap("b:1:0") as never);
    await new Promise((r) => setTimeout(r, 50));
    process.off("unhandledRejection", unhandled);
    expect(calls).toContain("answerCallbackQuery");
    expect(buy).toHaveBeenCalledWith("0x021959958a85e1b222597103660ae4ada25168f7", DEFAULT_SETTINGS.buyPresets[0], DEFAULT_SETTINGS);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("ignores everyone but the admin", async () => {
    const { bot, buy, calls } = setup();
    await bot.handleUpdate(tap("b:1:0", 7) as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(buy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
