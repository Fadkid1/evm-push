import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { Address } from "viem";
import { elysium, hyperEvm } from "../chains.js";
import type { Db, Settings } from "../db.js";
import { hypeUsd } from "../market.js";
import type { Trader } from "../trader.js";
import { parseInput } from "../venues/resolve.js";
import { chainName, compact, esc, hype, pct, pnlEmoji, tokenCard, tradeResult, txLink, usd } from "./format.js";

type Pending =
  | { kind: "buyX"; rid: number }
  | { kind: "setBuy" }
  | { kind: "setSell" }
  | { kind: "setSlip" }
  | { kind: "setMin" }
  | { kind: "wdAddr"; chainId: number; asset: "native" | Address; rid?: number }
  | { kind: "wdAmount"; chainId: number; asset: "native" | Address; to: string; rid?: number }
  | { kind: "bridge" };

interface Deps {
  token: string;
  adminId: number;
  db: Db;
  trader: Trader;
  dryRun: boolean;
}

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

const ignoreNotModified = (e: unknown) => {
  if (e instanceof GrammyError && /not modified/.test(e.description)) return;
  throw e;
};

const errText = (e: unknown) => esc(((e as Error)?.message ?? String(e)).split("\n")[0]!.slice(0, 300));

export function createBot(d: Deps): Bot {
  const bot = new Bot(d.token);
  const pending = new Map<number, Pending>();
  /** The live card message for each token, so a trade can replace it with a fresh one below. */
  const liveCards = new Map<number, number>();

  // Only the admin can use the bot; everyone else is ignored.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== d.adminId) return;
    await next();
  });

  // ------------------------------------------------------------- views

  function cardKeyboard(rid: number, settings: Settings, held: boolean): InlineKeyboard {
    const kb = new InlineKeyboard();
    settings.buyPresets.forEach((amt, i) => {
      kb.text(`🟢 Buy ${amt}`, `b:${rid}:${i}`);
      if (i % 3 === 2) kb.row();
    });
    kb.text("🟢 Buy X HYPE", `bx:${rid}`).row();
    settings.sellPresets.forEach((p) => kb.text(`🔴 ${p}%`, `s:${rid}:${p}`));
    kb.row();
    if (held) kb.text("💸 Withdraw token", `w:${rid}`).row();
    kb.text("🔄 Refresh", `o:${rid}`).text("📈 Positions", "pos").text("⚙️", "set");
    return kb;
  }

  async function renderCard(ref: string): Promise<{ text: string; kb: InlineKeyboard; rid: number }> {
    const rid = d.db.refId(ref);
    const s = await d.trader.snapshot(ref);
    return { text: tokenCard(s), kb: cardKeyboard(rid, d.db.settings(), s.balance > 0n), rid };
  }

  async function postCard(chatId: number, ref: string): Promise<void> {
    const { text, kb, rid } = await renderCard(ref);
    const old = liveCards.get(rid);
    const m = await bot.api.sendMessage(chatId, text, { ...HTML, reply_markup: kb });
    liveCards.set(rid, m.message_id);
    if (old && old !== m.message_id) await bot.api.deleteMessage(chatId, old).catch(() => {});
  }

  async function home(ctx: Context, edit = false): Promise<void> {
    const [ely, hyp, price] = await Promise.all([
      d.trader.wallet.balance(elysium.id).catch(() => 0n),
      d.trader.wallet.balance(hyperEvm.id).catch(() => 0n),
      hypeUsd(),
    ]);
    const e = Number(ely) / 1e18;
    const h = Number(hyp) / 1e18;
    const text = [
      `<b>HYPE Trading Bot</b>${d.dryRun ? " · <i>DRY RUN</i>" : ""}`,
      `<code>${d.trader.address}</code>`,
      `🟣 Elysium: ${hype(e)} · ${usd(e * price)}`,
      `🔷 HyperEVM: ${hype(h)} · ${usd(h * price)}`,
      `HYPE: ${usd(price)}`,
      "",
      "Paste a token address or a <b>Kleos</b> / <b>ElysPump</b> / <b>Stockium</b> link. Trades go through the token's own launchpad route, with no confirmations.",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("📈 Positions", "pos").text("⚙️ Settings", "set").row()
      .text("🌉 Bridge HYPE → Elysium", "br").row()
      .text("💸 Withdraw (Elysium)", `wn:${elysium.id}`).text("💸 Withdraw (HyperEVM)", `wn:${hyperEvm.id}`).row()
      .text("🔄 Refresh", "home");
    if (edit) await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
    else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }

  function settingsView(): { text: string; kb: InlineKeyboard } {
    const s = d.db.settings();
    const text = [
      "<b>⚙️ Settings</b>",
      "",
      `🟢 Buy buttons: ${s.buyPresets.map((x) => `${x} HYPE`).join(", ")} + X`,
      `🔴 Sell buttons: ${s.sellPresets.map((x) => `${x}%`).join(", ")}`,
      `🎚 Slippage: ${s.slippagePct}%`,
      `👁 Hide positions under: $${s.minPositionUsd}`,
      "🛣 Route: always the token's own launchpad route",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("✏️ Buy buttons", "set:buy").text("✏️ Sell buttons", "set:sell").row()
      .text("🎚 Slippage", "set:slip").text("👁 Min position $", "set:min").row()
      .text("⬅️ Home", "home");
    return { text, kb };
  }

  async function positions(ctx: Context, edit: boolean): Promise<void> {
    const settings = d.db.settings();
    const { rows } = await d.trader.positions(settings);
    const total = rows.reduce((a, r) => a + r.worthUsd, 0);
    const totalHype = rows.reduce((a, r) => a + r.worthHype, 0);
    const lines = [`<b>📈 Positions</b> (over $${settings.minPositionUsd})`, ""];
    if (!rows.length) lines.push("No positions above the minimum.");
    for (const r of rows) lines.push(`${pnlEmoji(r.pnl)} <b>${esc(r.symbol)}</b> · ${r.pad} · ${hype(r.worthHype)} · ${usd(r.worthUsd)} · ${pct(r.pnl)}`);
    if (rows.length) lines.push("", `Total: <b>${hype(totalHype)}</b> · <b>${usd(total)}</b>`);
    const kb = new InlineKeyboard();
    rows.slice(0, 30).forEach((r, i) => {
      kb.text(r.symbol.slice(0, 16), `o:${d.db.refId(r.ref)}:n`);
      if (i % 3 === 2) kb.row();
    });
    kb.row().text("🔄 Refresh", "pos").text("⬅️ Home", "home");
    if (edit) await ctx.editMessageText(lines.join("\n"), { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
    else await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  }

  // ------------------------------------------------------------- trades (no confirmation, run in the background)

  function runTrade(ctx: Context, rid: number, label: string, fn: () => Promise<Parameters<typeof tradeResult>[0]>): void {
    const chatId = ctx.chat!.id;
    void (async () => {
      const status = await bot.api.sendMessage(chatId, `⏳ ${label}…`, HTML);
      try {
        const o = await fn();
        await bot.api.editMessageText(chatId, status.message_id, tradeResult(o), HTML);
      } catch (e) {
        await bot.api.editMessageText(chatId, status.message_id, `❌ ${label}: ${errText(e)}`, HTML).catch(() => {});
      }
      const ref = d.db.ref(rid);
      if (ref) await postCard(chatId, ref).catch(() => {});
    })();
  }

  function buy(ctx: Context, rid: number, amount: number): void {
    const ref = d.db.ref(rid);
    if (!ref) return;
    runTrade(ctx, rid, `Buying with ${amount} HYPE`, () => d.trader.buy(ref, amount, d.db.settings()));
  }

  // ------------------------------------------------------------- commands

  bot.command("start", (ctx) => home(ctx));
  bot.command("positions", (ctx) => positions(ctx, false));
  bot.command("settings", (ctx) => {
    const v = settingsView();
    return ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
  });

  // ------------------------------------------------------------- buttons

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [cmd, a, b] = data.split(":");
    const chat = ctx.chat!.id;
    try {
      if (cmd === "home") return await (ctx.answerCallbackQuery(), home(ctx, true));
      if (cmd === "pos") return await (ctx.answerCallbackQuery(), positions(ctx, true));
      if (cmd === "set" && !a) {
        await ctx.answerCallbackQuery();
        const v = settingsView();
        return await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.kb }).catch(ignoreNotModified);
      }
      if (cmd === "set") {
        await ctx.answerCallbackQuery();
        const prompts: Record<string, [Pending, string]> = {
          buy: [{ kind: "setBuy" }, "Send the buy buttons in HYPE, comma separated (e.g. <code>0.1, 0.5, 1, 5</code>)."],
          sell: [{ kind: "setSell" }, "Send the sell buttons in %, comma separated (e.g. <code>25, 50, 100</code>)."],
          slip: [{ kind: "setSlip" }, "Send the slippage in % (1–99)."],
          min: [{ kind: "setMin" }, "Send the minimum position value in USD to show."],
        };
        const p = prompts[a!];
        if (!p) return;
        pending.set(chat, p[0]);
        return await ctx.reply(p[1], HTML);
      }
      if (cmd === "o") {
        await ctx.answerCallbackQuery();
        const ref = d.db.ref(Number(a));
        if (!ref) return;
        if (b === "n") return await postCard(chat, ref);
        const { text, kb, rid } = await renderCard(ref);
        await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
        liveCards.set(rid, ctx.callbackQuery.message!.message_id);
        return;
      }
      if (cmd === "b") {
        const amount = d.db.settings().buyPresets[Number(b)];
        await ctx.answerCallbackQuery({ text: amount ? `Buying ${amount} HYPE` : "Unknown button" });
        if (amount) buy(ctx, Number(a), amount);
        return;
      }
      if (cmd === "bx") {
        await ctx.answerCallbackQuery();
        pending.set(chat, { kind: "buyX", rid: Number(a) });
        return await ctx.reply("How much HYPE to buy with? It buys as soon as you send it.");
      }
      if (cmd === "s") {
        const rid = Number(a);
        const p = Number(b);
        const ref = d.db.ref(rid);
        await ctx.answerCallbackQuery({ text: `Selling ${p}%` });
        if (ref) runTrade(ctx, rid, `Selling ${p}%`, () => d.trader.sell(ref, p, d.db.settings()));
        return;
      }
      if (cmd === "w") {
        await ctx.answerCallbackQuery();
        const rid = Number(a);
        const ref = d.db.ref(rid);
        if (!ref) return;
        const v = await d.trader.venue(ref);
        pending.set(chat, { kind: "wdAddr", chainId: v.chainId, asset: v.token, rid });
        return await ctx.reply(`Send the ${chainName(v.chainId)} address to withdraw this token to.`);
      }
      if (cmd === "wn") {
        await ctx.answerCallbackQuery();
        const chainId = Number(a);
        pending.set(chat, { kind: "wdAddr", chainId, asset: "native" });
        return await ctx.reply(`Send the ${chainName(chainId)} address to withdraw HYPE to.`);
      }
      if (cmd === "br") {
        await ctx.answerCallbackQuery();
        pending.set(chat, { kind: "bridge" });
        return await ctx.reply("How much HYPE to move from HyperEVM to Elysium? (a number, or <code>max</code>). It's sent through the Elysium inbox right away.", HTML);
      }
      await ctx.answerCallbackQuery();
    } catch (e) {
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.reply(`❌ ${errText(e)}`, HTML);
    }
  });

  // ------------------------------------------------------------- text: answers to prompts, or a token to open

  const nums = (t: string) => t.split(/[,\s]+/).filter(Boolean).map(Number);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const chat = ctx.chat.id;
    const p = pending.get(chat);
    try {
      if (p) {
        pending.delete(chat);
        switch (p.kind) {
          case "buyX": {
            const amount = Number(text.replace(",", "."));
            if (!(amount > 0)) return await ctx.reply("That isn't a positive amount.");
            return buy(ctx, p.rid, amount);
          }
          case "setBuy": {
            const v = nums(text);
            if (!v.length || v.some((x) => !(x > 0)) || v.length > 9) return await ctx.reply("Send 1–9 positive amounts.");
            d.db.saveSettings({ buyPresets: v });
            break;
          }
          case "setSell": {
            const v = nums(text);
            if (!v.length || v.some((x) => !(x > 0 && x <= 100)) || v.length > 6) return await ctx.reply("Send 1–6 percentages between 1 and 100.");
            d.db.saveSettings({ sellPresets: v });
            break;
          }
          case "setSlip": {
            const v = Number(text.replace("%", ""));
            if (!(v >= 1 && v <= 99)) return await ctx.reply("Slippage must be 1–99.");
            d.db.saveSettings({ slippagePct: v });
            break;
          }
          case "setMin": {
            const v = Number(text.replace("$", ""));
            if (!(v >= 0)) return await ctx.reply("Send a number.");
            d.db.saveSettings({ minPositionUsd: v });
            break;
          }
          case "wdAddr": {
            if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return await ctx.reply("That isn't a 0x address. Start again from the button.");
            if (text.toLowerCase() === d.trader.address.toLowerCase()) return await ctx.reply("That's the bot's own wallet.");
            pending.set(chat, { ...p, kind: "wdAmount", to: text });
            return await ctx.reply("How much? (a number, or <code>max</code>). It sends as soon as you reply.", HTML);
          }
          case "wdAmount": {
            const amount = text.toLowerCase() === "max" ? "max" : text.replace(",", ".");
            const msg = await ctx.reply("⏳ Sending…");
            try {
              const r = await d.trader.withdraw(p.chainId, p.asset, p.to, amount);
              const done = `${r.pending ? "⏳ Sent, not confirmed yet" : "✅ Sent"} ${compact(r.amount)} ${esc(r.symbol)} on ${chainName(p.chainId)} to <code>${p.to}</code> · ${txLink(p.chainId, r.hash)}`;
              await ctx.api.editMessageText(chat, msg.message_id, d.dryRun ? `🧪 DRY RUN: would send ${compact(r.amount)} ${esc(r.symbol)}` : done, HTML);
            } catch (e) {
              await ctx.api.editMessageText(chat, msg.message_id, `❌ ${errText(e)}`, HTML);
            }
            if (p.rid) {
              const ref = d.db.ref(p.rid);
              if (ref) await postCard(chat, ref).catch(() => {});
            }
            return;
          }
          case "bridge": {
            const amount = text.toLowerCase() === "max" ? "max" : text.replace(",", ".");
            const msg = await ctx.reply("⏳ Depositing into the Elysium inbox…");
            try {
              const r = await d.trader.bridgeToElysium(amount);
              const out = d.dryRun
                ? `🧪 DRY RUN: would bridge ${hype(r.amount)}`
                : `${r.credited ? "✅ Bridged" : "⏳ Deposited (Elysium credits it shortly)"} ${hype(r.amount)} to Elysium · ${txLink(hyperEvm.id, r.hash)}`;
              await ctx.api.editMessageText(chat, msg.message_id, out, HTML);
            } catch (e) {
              await ctx.api.editMessageText(chat, msg.message_id, `❌ ${errText(e)}`, HTML);
            }
            return;
          }
        }
        const v = settingsView();
        return await ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
      }

      const input = parseInput(text);
      if (!input) return await ctx.reply("Paste a token address or a Kleos / ElysPump / Stockium token link.");
      await ctx.replyWithChatAction("typing");
      await postCard(chat, input.address);
    } catch (e) {
      await ctx.reply(`❌ ${errText(e)}`, HTML);
    }
  });

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}
