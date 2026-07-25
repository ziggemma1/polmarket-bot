import { getCurrentMarket } from '../polymarket/scanner';
import axios from 'axios';

// Use config pattern from previous file to support bot.ts injecting telegram 
import logger from '../logger';

export interface SniperConfig {
  getPaperMode: () => boolean;
  getPolymarketService: () => any; // The PolymarketService instance
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
const SNIPE_WINDOW = 12; // 12 seconds before expiry (T-12s window)



// Cache for T-12s position sizing evaluation per market ID
const marketSharesCache = new Map<string, number>();

async function fetchSpotPrice(ticker: 'btc' | 'eth' | 'sol' | 'bnb'): Promise<number> {
    let priceValue = 0;
    try {
        const feedId = PYTH_IDS[ticker];
        const response = await axios.get(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`, { timeout: 5000 });
        const data = response.data;
        if (data && data.parsed && data.parsed.length > 0) {
            const p = data.parsed[0].price;
            priceValue = parseFloat(p.price) * Math.pow(10, p.expo);
        }
    } catch (e: any) {
        logger.warn(`[Sniper] Pyth latest Spot Price API error for ${ticker.toUpperCase()}: ${e.message}`);
    }
    return priceValue;
}

const PYTH_IDS: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: string } = {
    btc: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    eth: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    sol: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    bnb: '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f'
};

async function fetchStrikePrice(market: any, ticker: 'btc' | 'eth' | 'sol' | 'bnb'): Promise<number> {
    let strikePrice = 0;
    const startTimestamp = parseInt(market.slug.split('-').pop() || '0');

    if (startTimestamp > 0) {
        try {
            const feedId = PYTH_IDS[ticker];
            logger.info(`[Sniper] Fetching Pyth for ${ticker} at ${startTimestamp}`);
            
            // Use axios to bypass Node 24 native fetch IPv6 DNS hangs
            const response = await axios.get(`https://hermes.pyth.network/v2/updates/price/${startTimestamp}?ids[]=${feedId}`, {
                timeout: 5000
            });
            const data = response.data;
            
            logger.info(`[Sniper] Pyth raw response: ${JSON.stringify(data).substring(0, 100)}...`);
            
            if (data && data.parsed && data.parsed.length > 0) {
                const p = data.parsed[0].price;
                strikePrice = parseFloat(p.price) * Math.pow(10, p.expo);
                logger.info(`[Sniper] Pyth computed strike: ${strikePrice}`);
            }

        } catch (e: any) {
            logger.warn(`[Sniper] Pyth API error for ${ticker.toUpperCase()}: ${e.message}`);
        }
    }

    if (!strikePrice || isNaN(strikePrice)) {
        try {
            if (startTimestamp > 0) {
                const bvResponse = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${ticker.toUpperCase()}USDT&interval=5m&limit=20`);
                const bvKlines = await bvResponse.json();
                if (Array.isArray(bvKlines)) {
                    // STRICT MATCH: exact candle open timestamp must match market startTimestamp
                    const candle = bvKlines.find((k: any) => Math.floor(k[0] / 1000) === startTimestamp);
                    if (candle) {
                        strikePrice = parseFloat(candle[1]); // Index 1 is open price
                    }
                }
            }
        } catch (e: any) {}
    }

    if (!strikePrice || isNaN(strikePrice)) {
        try {
            if (startTimestamp > 0) {
                const cbResponse = await fetch(`https://api.exchange.coinbase.com/products/${ticker.toUpperCase()}-USD/candles?granularity=300`, {
                    headers: { 'User-Agent': 'polmarket-bot' }
                });
                const klines = await cbResponse.json();
                if (Array.isArray(klines) && klines.length > 0) {
                    const candle = klines.find((k: any) => k[0] === startTimestamp);
                    if (candle) {
                        strikePrice = parseFloat(candle[3]); 
                    }
                }
            }
        } catch (e: any) {}
    }

    return strikePrice;
}

// Minimum spread threshold (in dollars) to trigger a snipe. 
// A higher value prevents trading on flat/noisy candles where fees/spread would wipe out profit.
const MIN_GAP_THRESHOLDS: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: number } = {
    btc: 15.00,
    eth: 1.0,
    sol: 0.05,
    bnb: 0.2
};

const BOOST_GAP_THRESHOLDS: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: number } = {
    btc: 100.00,
    eth: 10.00,
    sol: 0.50,
    bnb: 1.50
};

async function tick() {
    if (!sniperActive) {
        setTimeout(tick, CHECK_INTERVAL);
        return;
    }

    try {
        const limit = config?.maxDailyTrades || 500000;
        if (tradesToday >= limit) {
            console.log(`[Sniper] Daily limit reached. Pausing.`);
            sniperActive = false;
            if (config?.telegramService) {
                config.telegramService.sendAlert(`⛔ Daily limit reached (${limit} trades). Sniper paused.`);
            }
            setTimeout(tick, CHECK_INTERVAL);
            return;
        }

        // Calculate time until the next 5-minute wall-clock boundary
        const now = Date.now();
        const next5mBoundary = Math.ceil(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const secondsLeft = Math.round((next5mBoundary - now) / 1000);
        const boundaryKey = String(next5mBoundary); // dedup key based on the 5m boundary

        // Log countdown every tick so we can see it working
        console.log(`[Sniper] ⏱️ secondsLeft: ${secondsLeft}s | boundary: ${new Date(next5mBoundary).toISOString()}`);

        // Only fetch market and attempt trade in the T-12s window
        if (secondsLeft <= 12 && secondsLeft > 0) {
            // Check if we already executed for this specific 5-minute boundary
            if (executedMarketIds.has(boundaryKey)) {
                setTimeout(tick, CHECK_INTERVAL);
                return;
            }

            // Clean up old boundary keys
            if (executedMarketIds.size > 20) {
                executedMarketIds.clear();
            }

            const tickers: ('btc')[] = ['btc'];
            for (const ticker of tickers) {
                const market = await getCurrentMarket(ticker);
                if (!market) {
                    console.log(`[Sniper] ⚠️ No ${ticker.toUpperCase()} market found at T-${secondsLeft}s`);
                    continue;
                }

                console.log(`[Sniper] 🎯 Executing ${ticker.toUpperCase()} snipe at T-${secondsLeft}s | Market: ${market.question}`);

                // Mark this boundary as executed BEFORE the attempt to prevent double-fires
                executedMarketIds.add(boundaryKey);

                const result = await executeSnipe(market, ticker);

                if (result.success) {
                    tradesToday++;
                    console.log(`[Sniper] ✅ ${ticker.toUpperCase()} Snipe executed at T-${secondsLeft}s. Trades today: ${tradesToday}`);

                    if (config?.telegramService) {
                        config.telegramService.sendAlert(
                            `✅ LIVE: Snipe Executed\n` +
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

async function executeSnipe(market: any, ticker: 'btc' | 'eth' | 'sol' | 'bnb', sharesOverride?: number): Promise<{ 
    success: boolean; 
    side?: string; 
    price?: number; 
    shares?: number;
    priceValue?: number; 
    error?: string;
}> {
    try {
        // 1. Fetch fresh spot price AT T-10s
        const priceValue = await fetchSpotPrice(ticker);
        if (!priceValue || isNaN(priceValue)) {
            return { success: false, error: `Could not fetch spot price for ${ticker.toUpperCase()}` };
        }
        console.log(`[Sniper] ${ticker.toUpperCase()} T-10s Spot Price: $${priceValue}`);

        // 2. Fetch verified strike price
        const strikePrice = await fetchStrikePrice(market, ticker);
        const startTimestamp = parseInt(market.slug.split('-').pop() || '0');
        if (!strikePrice || isNaN(strikePrice) || strikePrice <= 0) {
            return { success: false, error: `Exact 5m candle strike price (timestamp ${startTimestamp}) not found for ${ticker.toUpperCase()}` };
        }
        console.log(`[Sniper] Verified Strike Price: $${strikePrice}`);

        // MINIMUM GAP GUARD FOR ALL 4 CRYPTOS: If price gap <= minGap, abort trade execution immediately
        const priceGap = Math.abs(priceValue - strikePrice);
        const minGap = MIN_GAP_THRESHOLDS[ticker];
        if (priceGap <= minGap) {
            console.log(`[Sniper] 🛑 ${ticker.toUpperCase()} Minimum Gap Guard Triggered: Price gap is $${priceGap.toFixed(4)} (<= $${minGap} noise band). Skipping trade.`);
            return { success: false, error: `${ticker.toUpperCase()} Price gap $${priceGap.toFixed(4)} is within $${minGap} noise band. Execution skipped.` };
        }

        // 3. Determine winning side at T-10s
        const side = priceValue > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] Side Choice: ${side} (${ticker.toUpperCase()} T-10s spot $${priceValue} vs strike $${strikePrice})`);

        // 4. Position sizing fixed to 5 shares per trade (Polymarket orderMinSize = 5)
        const entryPrice = 0.97;
        const shares = sharesOverride || 5;
        console.log(`[Sniper] T-10s Position Size: ${shares} shares (Price Gap $${priceGap.toFixed(4)} vs Min Guard $${minGap})`);

        // 5. Execute the trade
        const polymarketService = config?.getPolymarketService ? config.getPolymarketService() : null;
        if (!polymarketService) {
            return { success: false, error: 'Polymarket Service not initialized (check PROXY_ADDRESS and POLYGON_PRIVATE_KEY)' };
        }
        const cost = shares * entryPrice;
        const result = await polymarketService.placeSnipe(market, side, entryPrice, cost);

        if (result && result.success) {
            return {
                success: true,
                side: side,
                price: entryPrice,
                shares: shares,
                priceValue: priceValue,
            };
        } else {
            return { success: false, error: result?.error || 'Live trade placement failed' };
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
