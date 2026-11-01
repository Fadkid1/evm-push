# HYPE Trading Bot (Telegram)

A private Telegram bot that trades tokens from **Kleos** (thekleos.xyz), **ElysPump** (elysp.com) and **Stockium** (stockium.fun). They trade on **Elysium**, the Arbitrum Orbit chain on HyperEVM that uses HYPE for gas, and Stockium's bonding curves trade on **HyperEVM** itself. Trades are one tap: there are no confirmation prompts, for trades, withdrawals or bridging. Only your admin Telegram account can use the bot.

One private key, so one address, trades on both chains.

## How each token is routed

The bot finds which launchpad launched the token and trades it exactly the way that launchpad's own site does: the same contracts, the same calls, and the same endpoint for submitting.

| Launchpad | Token type | Route |
|---|---|---|
| Kleos | v4 launch (HYPE pool) | Kleos v4 router `buy` / `sell` |
| Kleos | KLEOS-paired launch | Kleos pair router (HYPE → KLEOS → token, in one call) |
| Kleos | First-generation launch | KleosSwap pool via the Kleos SwapRouter (sell = swap + unwrap in one multicall) |
| ElysPump | v2 launch | Universal Router `V4_SWAP` on the ElysPump-hook pool. Sells go through Permit2, as on elysp.com |
| ElysPump | v1 launch | ElysPump SwapRouter |
| Stockium | Not graduated yet | The bonding curve's own `buy` / `sell` on HyperEVM |
| Stockium | Graduated | StockiumSwap on Elysium: one hop for HYPE pairs, HYPE → hub → token for hub pairs |

**Submission:**
- **Kleos:** the signed trade goes to the Kleos relay (`rpc.thekleos.xyz/rpc`) and to the live Elysium RPC at the same time. It is the same signed transaction to the same Kleos router, so it executes once, on whichever path is faster. The live path takes about a second. If it hasn't confirmed within 6s, the bot also posts the trade into the Elysium inbox from your wallet on HyperEVM (`sendL2Message`, the Kleos site's "send it now" path). That needs a little HYPE on HyperEVM.
- **ElysPump:** `rpc-live.elysp.com` (live execution).
- **Stockium:** `rpc.stockium.fun` and `rpc-live.elysp.com` at once, which is what stockium.fun does.

## Speed

- Reads (balances, quotes) go to ElysPump's and Stockium's live RPCs at once and use the first answer. ElysPump's RPC rate-limits under load.
- A pasted token's launchpad is checked on all three pads in parallel, then cached, so the buy and sell buttons skip it.
- The nonce and gas price are loaded at startup. The quote, balance and metadata are fetched together. Elysium swaps use a fixed gas limit (as elysp.com does) instead of an estimate.
- A trade is accepted as soon as one RPC takes it, and confirmations are polled every 250 ms on all live RPCs.

Balances, quotes and gas estimates are always read from live state. The Kleos relay's own state lags the live chain by minutes, so it is used only for submitting.

## What the bot shows

- **Token card:** launchpad, route, price (USD and HYPE), market cap, liquidity, your **entry price** and **entry market cap**, PnL, holdings, and their **worth in HYPE and USD**.
- **Buy buttons:** 0.1 / 0.5 / 1 HYPE and **X** (asks for an amount, then buys straight away). You can edit them in Settings.
- **Sell buttons:** 25 / 50 / 75 / 100 %, also editable. The first sell of a token sends its approval and the sell back to back, with no extra tap.
- **Positions:** every token worth **more than $1** (editable). The bot finds them from your Elysium transfer history plus the tokens you open in the bot.
- **Slippage:** 25% by default (1–99%). A fill worse than this reverts.
- **Bridge HYPE → Elysium:** deposits through the Orbit inbox (`depositEth`), the same call ElysPump's bridge makes.
- **Withdraw:** HYPE on either chain, or any token from its card. The address is checked (valid, and not the bot's own wallet), then the transfer is sent at once.

Entry price and PnL come from the bot's own trade log (actual fills, read from the receipts). Tokens bought outside the bot have no entry.

## Funding

1. Send HYPE to the wallet address on **HyperEVM**.
2. Use **🌉 Bridge HYPE → Elysium** for the amount you want to trade on Elysium.
3. Keep some HYPE on HyperEVM too: it pays for Stockium curve trades and for posting Kleos trades to the inbox.

The bot always leaves 0.003 HYPE on Elysium and 0.01 HYPE on HyperEVM for gas.

## Setup

```bash
npm ci && npm run build
cp .env.example .env && nano .env && chmod 600 .env   # BOT_TOKEN, ADMIN_ID, PRIVATE_KEY
npm start                                              # try DRY_RUN=true first: buttons show the exact transactions without sending
```

Keep it running with pm2: `pm2 start ecosystem.config.cjs && pm2 save`.

**Railway:** deploy this repo with the service's **Root Directory** set to `hype-bot`, add a Volume mounted at `/data`, and set `BOT_TOKEN`, `ADMIN_ID`, `PRIVATE_KEY` and `DB_PATH=/data/bot.db`. Run only one copy of the bot: Telegram rejects two copies polling the same token.

## Security

- The private key only lives in `.env` on your server. Keep it `chmod 600` and never commit it (`.env` is git-ignored).
- Use a dedicated trading wallet that holds only what you are willing to trade. Every action fires without confirmation, withdrawals included.

## Commands

```bash
npm test                         # unit tests (encoders checked byte for byte against the sites' own)
npm run typecheck
npm run quote                    # read-only: one sample token per route; resolves, quotes and simulates the buy tx
npm run quote -- 0xToken <link>  # same, for your tokens
```
