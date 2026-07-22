import { getCurrentBTCMarket } from '../polymarket/scanner';
import { getPaperTrader } from '../paper_trader';

// Use config pattern from previous file to support bot.ts injecting telegram 
import logger from '../logger';

export interface SniperConfig {
  paperMode: boolean;
  paperTrader: any; // The PaperTrader instance
  polymarketService: any; // The PolymarketService instance
  telegramService: any;
  tradingLimit: number;
  maxDailyTrades: number; // Configured via environment variable
}
let config: SniperConfig | null = null;

let tickRunning = false;
export function initSniper(cfg: SniperConfig) {
  config = cfg;
  if (!tickRunning) {
    tickRunning = true;
    setTimeout(tick, 1000);
  }
}

let sniperActive = false;
let lastExecutedMarketId: string | null = null;
let tradesToday = 0;
let consecutiveLosses = 0;

const CHECK_INTERVAL = 2000; // 2 seconds
const SNIPE_WINDOW = 10;


async function settleExpiredPositions() {
    try {
        if (!config) return;
        const paperTrader = await getPaperTrader();
        const openPositions = paperTrader.getOpenPositions();

        if (openPositions.length === 0) {
            return;
        }

        const now = Date.now();
        const expired = openPositions.filter(pos => pos.expiry_time && now >= new Date(pos.expiry_time).getTime());

        if (expired.length === 0) {
            return;
        }

        console.log(`[Sniper] Found ${expired.length} expired paper positions. Fetching BTC price from Coinbase for instant settlement...`);

        let btcPrice: number | null = null;
        try {
            const response = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
            const data = await response.json();
            btcPrice = parseFloat(data.data.amount);
            console.log(`[Sniper] Expiry BTC Price from Coinbase: $${btcPrice}`);
        } catch (err) {
            console.error('[Sniper] Failed to fetch BTC price for instant settlement:', err);
        }

        for (const position of expired) {
            console.log(`[Sniper] 🔄 Settling expired position ${position.id} instantly...`);

            let exitPrice = 0.00;
            let outcome = '❌ LOSS';

            if (btcPrice !== null) {
                const strikePrice = position.strike_price || 66000;
                if (position.side === 'YES' && btcPrice > strikePrice) {
                    exitPrice = 1.00;
                    outcome = '✅ WIN';
                } else if (position.side === 'NO' && btcPrice < strikePrice) {
                    exitPrice = 1.00;
                    outcome = '✅ WIN';
                }
            } else {
                console.log(`[Sniper] BTC price is null, default to LOSS for position ${position.id}`);
            }

            const result = await paperTrader.closePosition(position.id, exitPrice);
            if (result.success) {
                const pnl = result.pnl || 0;
                console.log(`[Sniper] Instant check: ${outcome} Position ${position.id} closed: PnL = ${pnl.toFixed(2)}`);
                
                if (config.telegramService) {
                    config.telegramService.sendAlert(
                        `📊 PAPER: Position Settled (Instant)\n` +
                        `Market: ${position.question || 'Unknown'}\n` +
                        `Side: ${position.side}\n` +
                        `Result: ${outcome}\n` +
                        `BTC at Expiry: $${btcPrice ? btcPrice.toLocaleString() : 'N/A'}\n` +
                        `Strike Price: $${position.strike_price ? position.strike_price.toLocaleString() : 'N/A'}\n` +
                        `PnL: $${pnl.toFixed(2)}`
                    );
                }
            } else {
                console.error(`[Sniper] Failed to close expired position ${position.id}: ${result.error}`);
            }
        }
    } catch (error) {
        console.error('[Sniper] Error in settleExpiredPositions:', error);
    }
}

async function tick() {
    try {
        await settleExpiredPositions();
    } catch (error) {
        console.error('[Sniper] Error in settleExpiredPositions:', error);
    }
    if (!sniperActive) {
        setTimeout(tick, CHECK_INTERVAL);
        return;
    }

    if (!sniperActive) { // Need to re-check after async
        setTimeout(tick, CHECK_INTERVAL);
        return;
    }

    try {
        // Check daily limit
        const limit = config?.maxDailyTrades || 500;
        if (tradesToday >= limit) {
            console.log(`[Sniper] Daily limit reached. Pausing.`);
            sniperActive = false;
            if (config?.telegramService) {
                config.telegramService.sendAlert(`⛔ Daily limit reached (${limit} trades). Sniper paused.`);
            }
            setTimeout(tick, CHECK_INTERVAL);
            return;
        }

        // Get current market
        const market = await getCurrentBTCMarket();
        
        if (!market) {
            setTimeout(tick, CHECK_INTERVAL);
            return;
        }

        // New market detection
        if (lastExecutedMarketId && lastExecutedMarketId !== market.id) {
            console.log(`[Sniper] New market detected: ${market.id}`);
            lastExecutedMarketId = null;
        }

        // Skip if already executed
        if (lastExecutedMarketId === market.id) {
            setTimeout(tick, CHECK_INTERVAL);
            return;
        }

        // Check expiration
        const endDate = new Date(market.endDate);
        const secondsLeft = Math.round((endDate.getTime() - Date.now()) / 1000);

        // Execute snipe in final window
        if (secondsLeft <= SNIPE_WINDOW && secondsLeft > 0) {
            console.log(`[Sniper] 🎯 Executing snipe at T-${secondsLeft}s`);
            
            const result = await executeSnipe(market);
            
            if (result.success) {
                tradesToday++;
                lastExecutedMarketId = market.id;
                console.log(`[Sniper] ✅ Snipe executed. Trades today: ${tradesToday}`);
                
                // Send detailed Telegram alert
                if (config?.telegramService) {
                    config.telegramService.sendAlert(
                        `📄 PAPER: Snipe Executed\n` +
                        `Market: ${market.question}\n` +
                        `Side: ${result.side}\n` +
                        `Price: $${result.price}\n` +
                        `Shares: ${result.shares}\n` +
                        `BTC at entry: $${result.btcPrice}`
                    );
                }
            } else {
                console.log(`[Sniper] ❌ Snipe failed: ${result.error}`);
                if (config?.telegramService) {
                    config.telegramService.sendAlert(`❌ Snipe failed: ${result.error}`);
                }
            }
        }

    } catch (error) {
        console.error('[Sniper] Error in tick:', error);
    }

    setTimeout(tick, CHECK_INTERVAL);
}

async function executeSnipe(market: any): Promise<{ 
    success: boolean; 
    side?: string; 
    price?: number; 
    shares?: number;
    btcPrice?: number; 
    error?: string;
}> {
    try {
        // 1. Fetch BTC price from Coinbase
        const coinbaseResponse = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
        const coinbaseData = await coinbaseResponse.json();
        const btcPrice = parseFloat(coinbaseData.data.amount);
        console.log(`[Sniper] BTC Price from Coinbase: $${btcPrice}`);

        // 2. Fetch the strike price (open price of the 5m candle) from Coinbase Exchange API
        let strikePrice = 0;
        try {
            const startTimestamp = parseInt(market.slug.split('-').pop() || '0');
            if (startTimestamp > 0) {
                const cbResponse = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300', {
                    headers: { 'User-Agent': 'polmarket-bot' }
                });
                const klines = await cbResponse.json();
                if (Array.isArray(klines) && klines.length > 0) {
                    const candle = klines.find((k: any) => k[0] === startTimestamp);
                    if (candle) {
                        strikePrice = parseFloat(candle[3]); // Index 3 is open price
                        console.log(`[Sniper] Found Coinbase candle for start timestamp ${startTimestamp}. Open price (strikePrice): $${strikePrice}`);
                    } else {
                        // Fallback to the newest candle's open price
                        strikePrice = parseFloat(klines[0][3]);
                        console.log(`[Sniper] Start timestamp ${startTimestamp} not found in recent Coinbase candles. Using latest candle open price: $${strikePrice}`);
                    }
                }
            }
        } catch (e: any) {
            console.log(`[Sniper] Could not fetch strike price from Coinbase candles: ${e.message}. Using fallback.`);
        }

        if (!strikePrice) {
            strikePrice = btcPrice || 66000;
        }
        console.log(`[Sniper] Final Strike Price: $${strikePrice}`);

        // 3. Determine winning side
        const side = btcPrice > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] ${side} is winning (BTC $${btcPrice} vs strike $${strikePrice})`);

        // 4. Determine trade execution parameters
        const entryPrice = 0.97;
        const tradingLimit = config?.tradingLimit || 1.00;
        const shares = Math.floor(tradingLimit / entryPrice) || 1;

        // 5. Execute the trade
        if (config?.paperMode) {
            const paperTrader = await getPaperTrader();
            if (!paperTrader) {
                return { success: false, error: 'Paper trader not initialized' };
            }
            const result = await paperTrader.executeTrade({
                marketId: market.id,
                question: market.question,
                side: side,
                shares: shares,
                entryPrice: entryPrice,
                btcPrice: btcPrice,
                strikePrice: strikePrice,
                expiryTime: market.endDate,
            });

            if (result.success) {
                return {
                    success: true,
                    side: side,
                    price: entryPrice,
                    shares: shares,
                    btcPrice: btcPrice,
                };
            } else {
                return { success: false, error: result.error || 'Paper trade failed' };
            }
        } else {
            // Live Trading!
            if (!config?.polymarketService) {
                return { success: false, error: 'Polymarket Service not initialized for Live mode' };
            }
            const cost = shares * entryPrice;
            const result = await config.polymarketService.placeSnipe(market, side, entryPrice, cost);

            if (result) {
                return {
                    success: true,
                    side: side,
                    price: entryPrice,
                    shares: shares,
                    btcPrice: btcPrice,
                };
            } else {
                return { success: false, error: 'Live trade placement failed' };
            }
        }

    } catch (error) {
        return { success: false, error: String(error) };
    }
}

export function startSniper() {
    if (sniperActive) {
        console.log('[Sniper] Already running');
        return;
    }
    sniperActive = true;
    lastExecutedMarketId = null;
    tradesToday = 0;
    consecutiveLosses = 0;
    console.log('[Sniper] 🟢 Started');
    // tick is already running from initSniper
}

export function stopSniper() {
    sniperActive = false;
    console.log('[Sniper] 🔴 Stopped');
}

export function getSniperStatus() {
    return {
        active: sniperActive,
        tradesToday: tradesToday,
    };
}
// UI Sync
