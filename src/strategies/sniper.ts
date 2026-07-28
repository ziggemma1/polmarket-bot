import { getCurrentMarket } from '../polymarket/scanner';
import axios from 'axios';

// Use config pattern from previous file to support bot.ts injecting telegram 
import logger from '../logger';

export interface SniperConfig {
  getPolymarketService: () => any; // The PolymarketService instance
  getPaperTraderService?: () => any;
  getIsPaperMode: () => boolean;
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
    // 1. Pyth Hermes Latest Spot API
    try {
        const feedId = PYTH_IDS[ticker];
        const response = await axios.get(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`, { timeout: 3000 });
        const data = response.data;
        if (data && data.parsed && data.parsed.length > 0) {
            const p = data.parsed[0].price;
            priceValue = parseFloat(p.price) * Math.pow(10, p.expo);
        }
    } catch (e: any) {
        logger.warn(`[Sniper] Pyth latest Spot Price API error for ${ticker.toUpperCase()}: ${e.message}`);
    }

    // 2. Binance Public Ticker Fallback
    if (!priceValue || isNaN(priceValue)) {
        try {
            const binanceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${ticker.toUpperCase()}USDT`, { timeout: 2500 });
            if (binanceRes.data?.price) {
                priceValue = parseFloat(binanceRes.data.price);
                logger.info(`[Sniper] Binance spot fallback used for ${ticker.toUpperCase()}: $${priceValue}`);
            }
        } catch (e: any) {}
    }

    // 3. Binance Vision Fallback
    if (!priceValue || isNaN(priceValue)) {
        try {
            const bvRes = await axios.get(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${ticker.toUpperCase()}USDT`, { timeout: 2500 });
            if (bvRes.data?.price) {
                priceValue = parseFloat(bvRes.data.price);
                logger.info(`[Sniper] Binance Vision spot fallback used for ${ticker.toUpperCase()}: $${priceValue}`);
            }
        } catch (e: any) {}
    }

    // 4. Coinbase Public Ticker Fallback
    if (!priceValue || isNaN(priceValue)) {
        try {
            const cbRes = await axios.get(`https://api.exchange.coinbase.com/products/${ticker.toUpperCase()}-USD/ticker`, {
                headers: { 'User-Agent': 'polmarket-bot' },
                timeout: 2500
            });
            if (cbRes.data?.price) {
                priceValue = parseFloat(cbRes.data.price);
                logger.info(`[Sniper] Coinbase spot fallback used for ${ticker.toUpperCase()}: $${priceValue}`);
            }
        } catch (e: any) {}
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
    btc: 30.00,
    eth: 1.50,
    sol: 0.10,
    bnb: 0.25
};

const BOOST_GAP_THRESHOLDS: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: number } = {
    btc: 100.00,
    eth: 15.00,
    sol: 0.75,
    bnb: 2.50
};

export const activeAssetsConfig: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: boolean } = {
    btc: true,
    eth: false,
    sol: false,
    bnb: false
};

export function toggleAssetConfig(ticker: 'btc' | 'eth' | 'sol' | 'bnb', enabled: boolean) {
    activeAssetsConfig[ticker] = enabled;
    logger.info(`[Sniper] Crypto asset ${ticker.toUpperCase()} trading set to: ${enabled ? 'ACTIVE 🟢' : 'INACTIVE ⚪'}`);
}

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
            const allTickers: ('btc' | 'eth' | 'sol' | 'bnb')[] = ['btc', 'eth', 'sol', 'bnb'];
            const tickers = allTickers.filter(t => activeAssetsConfig[t]);

            if (tickers.length === 0) {
                console.log(`[Sniper Diagnostic] ⚠️ No tickers active in activeAssetsConfig! (btc, eth, sol, bnb are all false)`);
                setTimeout(tick, CHECK_INTERVAL);
                return;
            }
            console.log(`[Sniper Diagnostic] T-12s Window Active. Active Tickers: ${tickers.map(t => t.toUpperCase()).join(', ')}`);

            for (const ticker of tickers) {
                const tickerBoundaryKey = `${boundaryKey}-${ticker}`;
                if (executedMarketIds.has(tickerBoundaryKey)) {
                    continue;
                }

                const market = await getCurrentMarket(ticker);
                if (!market) {
                    console.log(`[Sniper Diagnostic] ⚠️ getCurrentMarket('${ticker}') returned NULL at T-${secondsLeft}s (market not found/indexed yet)`);
                    continue;
                }

                console.log(`[Sniper] 🎯 Executing ${ticker.toUpperCase()} snipe at T-${secondsLeft}s | Market: ${market.question}`);

                // Mark this boundary as executed BEFORE the attempt to prevent double-fires
                executedMarketIds.add(tickerBoundaryKey);

                const result = await executeSnipe(market, ticker);

                if (result.success) {
                    tradesToday++;
                    console.log(`[Sniper] ✅ ${ticker.toUpperCase()} Snipe executed at T-${secondsLeft}s. Trades today: ${tradesToday}`);

                    if (config?.telegramService) {
                        config.telegramService.sendAlert(
                            `✅ 🔴 LIVE Snipe Executed\n\n` +
                            `Asset: ${ticker.toUpperCase()}\n` +
                            `Market: ${market.question}\n` +
                            `Side: ${result.side}\n` +
                            `Price: $${result.price}\n` +
                            `Shares: ${result.shares}\n` +
                            `Spot at entry: $${result.priceValue}`
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

        // MINIMUM GAP GUARD FOR ALL 4 CRYPTOS: Log computed gap vs threshold every time
        const priceGap = Math.abs(priceValue - strikePrice);
        const minGap = MIN_GAP_THRESHOLDS[ticker];
        console.log(`[Sniper Diagnostic] ${ticker.toUpperCase()} Computed Price Gap: $${priceGap.toFixed(4)} | Noise Guard Threshold: $${minGap}`);
        if (priceGap <= minGap) {
            console.log(`[Sniper Diagnostic] 🛑 ${ticker.toUpperCase()} Minimum Gap Guard Triggered: Price gap is $${priceGap.toFixed(4)} (<= $${minGap} noise band). Skipping trade.`);
            return { success: false, error: `${ticker.toUpperCase()} Price gap $${priceGap.toFixed(4)} is within $${minGap} noise band. Execution skipped.` };
        }

        // 3. Determine winning side at T-10s
        const side = priceValue > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] Side Choice: ${side} (${ticker.toUpperCase()} T-10s spot $${priceValue} vs strike $${strikePrice})`);

        // 4. Position sizing: Fixed at 5 shares for live trading / all trades
        const entryPrice = 0.97;
        const isBoosted = priceGap >= BOOST_GAP_THRESHOLDS[ticker];
        const defaultShares = 5;
        const shares = sharesOverride || defaultShares;
        console.log(`[Sniper] T-10s Position Size: ${shares} shares (${isBoosted ? '🚀 BOOSTED SIGNAL' : 'Standard Tier'} | Price Gap $${priceGap.toFixed(4)} vs Boost Guard $${BOOST_GAP_THRESHOLDS[ticker]})`);

        // 5. Execute the trade (Paper vs Live mode routing)
        const isPaper = config?.getIsPaperMode ? config.getIsPaperMode() : true;
        let result;
        if (isPaper) {
          const paperTrader = config?.getPaperTraderService?.();
          console.log(`[Sniper] Executing in PAPER mode for ${ticker.toUpperCase()}`);
          result = await paperTrader.placePaperTrade(market, side, entryPrice, shares, priceValue, strikePrice);
        } else {
          const polymarketService = config?.getPolymarketService?.();
          console.log(`[Sniper] Executing in LIVE mode for ${ticker.toUpperCase()}`);
          result = await polymarketService.placeSnipe(market, side, entryPrice, shares);
        }

        if (result && result.success) {
            return {
                success: true,
                side: side,
                price: entryPrice,
                shares: shares,
                priceValue: priceValue,
            };
        } else {
            const errText = typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error || 'Live trade placement failed');
            return { success: false, error: errText };
        }

    } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
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
