[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arianda17/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arianda17/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# pump.fun paper-trading bot

Entry for the make.fun competition **Pump.fun Bot Sprint: Make Bot And Win**
(slug `u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`).

## What the bot does

`main.ts` is a paper-trading bot that speaks the `agent-fun/replay/v2` protocol (NDJSON over
stdio). It reads the harness's replay of pump.fun bonding-curve events (CreateEvent, TradeEvent,
CompleteEvent) one batch per slot and replies with exactly one order batch per slot — buys on coins
showing early buy momentum, sells on take-profit / stop-loss / time-exit rules, and an immediate
full exit whenever a coin's curve completes.

## Strategy

Momentum sniper:

1. **Entry.** On each new coin's CreateEvent the bot starts tracking it as a candidate. It watches
   the first TradeEvents for consecutive buys and cumulative SOL buy volume. Once at least 3
   consecutive buys and 0.01 SOL of cumulative buy volume are seen, it buys ~0.2 SOL (capped at 100
   bps of the mint's real SOL reserve, never exceeding available cash minus tx fees).
2. **Chasing guard.** Coins whose price has already run up more than ~20% from their create price
   are skipped — buying tops loses to the ~125 bps of fees per round trip plus per-tx costs.
3. **Exits.** Each position is watched against its entry cost:
   - take profit at ~+25% on cost,
   - stop loss at ~-12% on cost,
   - trailing stop giving back 12% from peak while in profit (after a 10-slot minimum hold),
   - hard time exit after 300 slots,
   - immediate full sell on CompleteEvent for that mint.
4. **Risk.** Max 5 open positions, max 100 bps of a mint's real SOL reserve per order, max 16
   orders per batch, no shorts, no leverage. Size is chosen to clear fees so small scalps don't
   bleed.

## Determinism

No clock reads, no environment variables, no `Math.random`. All state is derived from the replay
itself, so the bot is byte-for-byte identical across the two graded executions.

## How to run

The repo runs with Node 22 (no build, no install):

```
node main.ts
```

Pipe a valid `hello` / `batch` / `done` NDJSON stream (per `protocol.schema.json`) into stdin; the
bot writes exactly one `{"type":"reply","seq":...,"orders":[...]}` line to stdout per batch and
exits cleanly on `done`. Diagnostics go to stderr.

## Guardrails targeted

- Round trip of at least 0.01 SOL on at least 20 distinct coins.
- Max drawdown of 50% or less.
- Net PnL above 0 SOL after every fee (protocol ~95 bps + creator ~30 bps + ~105,000 lamports tx
  fees per fill).
- Max 5 open positions, max order 100 bps of real reserve, max 16 orders per batch.

## Files

- `main.ts` — bot entrypoint (imports `runBot` from `./vendor/makefun-bot.ts`)
- `vendor/makefun-bot.ts` — protocol shim (copy of the kit's `sdk/ts/makefun-bot.ts`)
- `LICENSE` — MIT
- `.makefun/freshness.json` — drand round anchor
- `.makefun/owner.json` — claim wallet

## How it was built

Written as erasable TypeScript with zero dependencies and no network access, matching the
competition's erasable-TS and no-secret rules. See the session transcripts for the build history
and revisions.
