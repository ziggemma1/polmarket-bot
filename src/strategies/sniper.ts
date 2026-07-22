import { getCurrentMarket } from '../polymarket/scanner';
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
const executedMarketIds = new Set<string>();
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

        console.log(`[Sniper] Found ${expired.length} expired paper positions. Resolving outcomes...`);

        // Cache prices to avoid multiple fetches for the same ticker
        const priceCache: { [key: string]: number | null } = { btc: null, eth: null, sol: null, xrp: null };
        const getPrice = async (t: 'btc' | 'eth' | 'sol' | 'xrp') => {
            if (priceCache[t] !== null) return priceCache[t];
            try {
                const response = await fetch(`https://api.coinbase.com/v2/prices/${t.toUpperCase()}-USD/spot`);
                const data = await response.json();
                const price = parseFloat(data.data.amount);
                console.log(`[Sniper] Expiry ${t.toUpperCase()} Price from Coinbase: $${price}`);
                priceCache[t] = price;
                return price;
            } catch (err) {
                console.error(`[Sniper] Failed to fetch ${t.toUpperCase()} price for instant settlement:`, err);
                return null;
            }
        };

        for (const position of expired) {
            console.log(`[Sniper] 🔄 Settling expired position ${position.id} instantly...`);

            // Parse ticker from question text
            let ticker: 'btc' | 'eth' | 'sol' | 'xrp' = 'btc';
            const q = (position.question || '').toLowerCase();
            if (q.includes('ethereum')) {
                ticker = 'eth';
            } else if (q.includes('solana')) {
                ticker = 'sol';
            } else if (q.includes('xrp')) {
                ticker = 'xrp';
            }

            const price = await getPrice(ticker);

            let exitPrice = 0.00;
            let outcome = '❌ LOSS';

            if (price !== null) {
                const strikePrice = position.strike_price || 0;
                if (position.side === 'YES' && price > strikePrice) {
                    exitPrice = 1.00;
                    outcome = '✅ WIN';
                } else if (position.side === 'NO' && price < strikePrice) {
                    exitPrice = 1.00;
                    outcome = '✅ WIN';
                }
            } else {
                console.log(`[Sniper] Price is null for ${ticker.toUpperCase()} position ${position.id}, defaulting to LOSS`);
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
                        `${ticker.toUpperCase()} at Expiry: $${price ? price.toLocaleString() : 'N/A'}\n` +
                        `Strike Price: ${position.strike_price ? position.strike_price.toLocaleString() : 'N/A'}\n` +
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

        // Clean up executed IDs map
        if (executedMarketIds.size > 20) {
            executedMarketIds.clear();
        }

        // Scan BTC, ETH, SOL, and XRP markets in parallel
        const tickers: ('btc' | 'eth' | 'sol' | 'xrp')[] = ['btc', 'eth', 'sol', 'xrp'];
        for (const ticker of tickers) {
            const market = await getCurrentMarket(ticker);
            if (!market) continue;

            if (executedMarketIds.has(market.id)) continue;

            // Check expiration
            const endDate = new Date(market.endDate);
            const secondsLeft = Math.round((endDate.getTime() - Date.now()) / 1000);

            // Execute snipe in final window
            if (secondsLeft <= SNIPE_WINDOW && secondsLeft > 0) {
                console.log(`[Sniper] 🎯 Executing ${ticker.toUpperCase()} snipe at T-${secondsLeft}s`);
                
                const result = await executeSnipe(market, ticker);
                
                if (result.success) {
                    tradesToday++;
                    executedMarketIds.add(market.id);
                    console.log(`[Sniper] ✅ ${ticker.toUpperCase()} Snipe executed. Trades today: ${tradesToday}`);
                    
                    // Send detailed Telegram alert
                    if (config?.telegramService) {
                        config.telegramService.sendAlert(
                            `📄 PAPER: Snipe Executed\n` +
                            `Market: ${market.question}\n` +
                            `Side: ${result.side}\n` +
                            `Price: $${result.price}\n` +
                            `Shares: ${result.shares}\n` +
                            `${ticker.toUpperCase()} at entry: $${result.priceValue}`
                        );
                    }
                } else {
                    console.log(`[Sniper] ❌ ${ticker.toUpperCase()} Snipe failed: ${result.error}`);
                    if (config?.telegramService) {
                        config.telegramService.sendAlert(`❌ ${ticker.toUpperCase()} Snipe failed: ${result.error}`);
                    }
                }
            }
        }

    } catch (error) {
        console.error('[Sniper] Error in tick:', error);
    }

    setTimeout(tick, CHECK_INTERVAL);
}

async function executeSnipe(market: any, ticker: 'btc' | 'eth' | 'sol' | 'xrp'): Promise<{ 
    success: boolean; 
    side?: string; 
    price?: number; 
    shares?: number;
    priceValue?: number; 
    error?: string;
}> {
    try {
        // 1. Fetch spot price from Coinbase
        const coinbaseResponse = await fetch(`https://api.coinbase.com/v2/prices/${ticker.toUpperCase()}-USD/spot`);
        const coinbaseData = await coinbaseResponse.json();
        const priceValue = parseFloat(coinbaseData.data.amount);
        console.log(`[Sniper] ${ticker.toUpperCase()} Price from Coinbase: $${priceValue}`);

        // 2. Fetch the strike price (open price of the 5m candle) from Coinbase Exchange API
        let strikePrice = 0;
        try {
            const startTimestamp = parseInt(market.slug.split('-').pop() || '0');
            if (startTimestamp > 0) {
                const cbResponse = await fetch(`https://api.exchange.coinbase.com/products/${ticker.toUpperCase()}-USD/candles?granularity=300`, {
                    headers: { 'User-Agent': 'polmarket-bot' }
                });
                const klines = await cbResponse.json();
                if (Array.isArray(klines) && klines.length > 0) {
                    const candle = klines.find((k: any) => k[0] === startTimestamp);
                    if (candle) {
                        strikePrice = parseFloat(candle[3]); // Index 3 is open price
                        console.log(`[Sniper] Found Coinbase candle for ${ticker.toUpperCase()} start timestamp ${startTimestamp}. Open price (strikePrice): $${strikePrice}`);
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
            strikePrice = priceValue || (ticker === 'btc' ? 66000 : (ticker === 'eth' ? 3500 : (ticker === 'sol' ? 150 : 0.50)));
        }
        console.log(`[Sniper] Final Strike Price: $${strikePrice}`);

        // 3. Determine winning side
        const side = priceValue > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] ${side} is winning (${ticker.toUpperCase()} $${priceValue} vs strike $${strikePrice})`);

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
                btcPrice: priceValue,
                strikePrice: strikePrice,
                expiryTime: market.endDate,
            });

            if (result.success) {
                return {
                    success: true,
                    side: side,
                    price: entryPrice,
                    shares: shares,
                    priceValue: priceValue,
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
                    priceValue: priceValue,
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
    executedMarketIds.clear();
    tradesToday = 0;
    consecutiveLosses = 0;
    console.log('[Sniper] 🟢 Started');
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
