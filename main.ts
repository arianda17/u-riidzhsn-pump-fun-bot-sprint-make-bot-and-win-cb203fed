import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput, type Curve } from './vendor/makefun-bot.ts';

const BUY_SIZE_LAMPORTS = LAMPORTS_PER_SOL / 20n;          // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;          // 0.005 SOL minimum
const MAX_SLIPPAGE_BPS = 10_000;
const TAKE_PROFIT_BPS = 2_500;                             // +25%
const STOP_LOSS_BPS = 1_200;                               // -12%
const MIN_HOLD_SLOTS = 10;                                 // minimum slots before trailing exit
const MAX_HOLD_SLOTS = 300;                                // time exit after this many slots
const TRAILING_STOP_BPS = 1_200;                           // give back 12% from peak, only while in profit
const MOMENTUM_MIN_BUYS = 3;                               // need at least this many consecutive buys
const MOMENTUM_MIN_VOLUME_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL cumulative buy volume
const MAX_PRICE_RUNUP_BPS = 2_000;                         // skip if price already up >20% from create
const MIN_REAL_TOKEN_FRACTION_NUM = 5;                     // skip coins whose curve is <5% from complete

interface Candidate {
  mint: string;
  firstSeenSlot: number;
  consecutiveBuys: number;
  totalBuyVolume: bigint;
  lastVirtualPrice: bigint; // virtual_quote_reserves / virtual_token_reserves * 1e9 (scaled)
  createVirtualPrice: bigint;
  decided: boolean;
}

interface PositionMeta {
  mint: string;
  entryPrice: bigint;      // virtual price at entry (scaled 1e9)
  highestPrice: bigint;    // highest virtual price since entry (scaled 1e9)
  entrySlot: number;
  tokenAmount: bigint;
  costLamports: bigint;
}

const candidates = new Map<string, Candidate>();
const positionMeta = new Map<string, PositionMeta>();

function virtualPrice(curve: Curve): bigint {
  // Returns price as lamports per token * 1e9 for precision
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (curve.virtual_quote_reserves * 1_000_000_000n) / curve.virtual_token_reserves;
}

function priceChangeBps(from: bigint, to: bigint): number {
  if (from === 0n) return 0;
  return Number(((to - from) * 10_000n) / from);
}

// True when the curve is so close to completion that buying now risks a forced sell at an
// uncertain migration price: real token reserves are under 5% of the virtual float.
function nearCompletion(curve: Curve): boolean {
  return curve.real_token_reserves * 100n < curve.virtual_token_reserves * BigInt(MIN_REAL_TOKEN_FRACTION_NUM);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    let freeCash = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const orders: (BuyInput | SellInput)[] = [];

    // Update position metadata from fills and account.
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && fill.side === 'buy') {
        const curve = state.curves.get(fill.mint);
        if (curve) {
          const price = virtualPrice(curve);
          positionMeta.set(fill.mint, {
            mint: fill.mint,
            entryPrice: price,
            highestPrice: price,
            entrySlot: batch.slot,
            tokenAmount: BigInt(fill.token_amount),
            costLamports: BigInt(fill.quote_lamports),
          });
        }
      } else if (fill.status === 'rejected' && fill.side === 'buy') {
        // The buy never landed: drop the candidate so we do not retry and burn tx fees.
        candidates.delete(fill.mint);
      } else if (fill.status === 'filled' && fill.side === 'sell') {
        positionMeta.delete(fill.mint);
        candidates.delete(fill.mint);
      }
    }

    // Sync with account positions (covers harness closes and any fill we missed).
    for (const pos of state.positions.values()) {
      if (!positionMeta.has(pos.mint)) {
        const curve = state.curves.get(pos.mint);
        if (curve) {
          const price = virtualPrice(curve);
          positionMeta.set(pos.mint, {
            mint: pos.mint,
            entryPrice: price,
            highestPrice: price,
            entrySlot: batch.slot,
            tokenAmount: pos.token_amount,
            costLamports: pos.cost_lamports,
          });
        }
      }
    }

    // Process events to update candidates and force exits on completion.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const curve = state.curves.get(event.mint);
        if (curve) {
          const price = virtualPrice(curve);
          candidates.set(event.mint, {
            mint: event.mint,
            firstSeenSlot: batch.slot,
            consecutiveBuys: 0,
            totalBuyVolume: 0n,
            lastVirtualPrice: price,
            createVirtualPrice: price,
            decided: false,
          });
        }
      } else if (event.event === 'TradeEvent') {
        const cand = candidates.get(event.mint);
        const curve = state.curves.get(event.mint);
        if (!curve) continue;

        const price = virtualPrice(curve);
        const isBuy = event.is_buy;

        // Update candidate momentum tracking.
        if (cand && !cand.decided) {
          if (isBuy) {
            cand.consecutiveBuys += 1;
            cand.totalBuyVolume += BigInt(event.sol_amount);
          } else {
            cand.consecutiveBuys = 0; // a sell breaks the buy streak
          }
          cand.lastVirtualPrice = price;
        }

        // Track the high-water mark for held positions.
        const meta = positionMeta.get(event.mint);
        if (meta && price > meta.highestPrice) meta.highestPrice = price;
      } else if (event.event === 'CompleteEvent') {
        // Curve completed - force sell any position we hold in it.
        const meta = positionMeta.get(event.mint);
        if (meta && orders.length < caps.max_orders_per_batch && freeCash >= txFee) {
          orders.push({
            side: 'sell',
            mint: event.mint,
            token_amount: meta.tokenAmount,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          freeCash -= txFee;
          positionMeta.delete(event.mint);
        }
        candidates.delete(event.mint);
      }
    }

    // Check exits for existing positions.
    for (const [mint, meta] of positionMeta) {
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;

      const currentPrice = virtualPrice(curve);
      if (currentPrice === 0n) continue;

      const pnlBps = priceChangeBps(meta.entryPrice, currentPrice);
      const drawdownBps = priceChangeBps(meta.highestPrice, currentPrice);
      const holdSlots = batch.slot - meta.entrySlot;

      let shouldSell = false;

      if (pnlBps >= TAKE_PROFIT_BPS) {
        shouldSell = true;                              // take profit
      } else if (pnlBps <= -STOP_LOSS_BPS) {
        shouldSell = true;                              // stop loss
      } else if (holdSlots >= MAX_HOLD_SLOTS) {
        shouldSell = true;                              // time exit
      } else if (holdSlots >= MIN_HOLD_SLOTS && pnlBps > 0 && drawdownBps <= -TRAILING_STOP_BPS) {
        shouldSell = true;                              // trailing stop, only while in profit
      }

      if (shouldSell && orders.length < caps.max_orders_per_batch && freeCash >= txFee) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: meta.tokenAmount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        freeCash -= txFee;
        positionMeta.delete(mint);
      }
    }

    // Evaluate candidates for entry.
    for (const [mint, cand] of candidates) {
      if (cand.decided) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) {
        cand.decided = true;
        continue;
      }

      // Need enough real reserve to buy, and the curve must not be about to migrate.
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      if (nearCompletion(curve)) {
        cand.decided = true;
        continue;
      }

      // Momentum gate: consecutive buys and cumulative buy volume.
      if (cand.consecutiveBuys < MOMENTUM_MIN_BUYS) continue;
      if (cand.totalBuyVolume < MOMENTUM_MIN_VOLUME_LAMPORTS) continue;

      // Do not chase a coin that already ran up far from its create price.
      const currentPrice = virtualPrice(curve);
      const runupBps = priceChangeBps(cand.createVirtualPrice, currentPrice);
      if (runupBps > MAX_PRICE_RUNUP_BPS) {
        cand.decided = true;
        continue;
      }

      // Position and reply-size limits.
      if (openSlots <= 0) break;
      if (orders.length >= caps.max_orders_per_batch) break;

      const amount = cap < BUY_SIZE_LAMPORTS ? cap : BUY_SIZE_LAMPORTS;
      if (freeCash < amount + txFee) break;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      freeCash -= amount + txFee;
      openSlots -= 1;
      cand.decided = true;
    }

    return orders;
  },
});