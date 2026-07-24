import { getCurrentMarket } from '../polymarket/scanner';


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
    const cgMap: { [key: string]: string } = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', bnb: 'binancecoin' };
    let priceValue = 0;

    // 1. Primary: Use Binance Vision (matches exact market resolution candles)
    try {
        const binanceResponse = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${ticker.toUpperCase()}USDT`);
        const binanceData = await binanceResponse.json();
        priceValue = parseFloat(binanceData?.price);
    } catch (e) {}

    // 2. Secondary Fallback: Coinbase
    if (!priceValue || isNaN(priceValue)) {
        try {
            const coinbaseResponse = await fetch(`https://api.coinbase.com/v2/prices/${ticker.toUpperCase()}-USD/spot`);
            const coinbaseData = await coinbaseResponse.json();
            priceValue = parseFloat(coinbaseData?.data?.amount);
        } catch (e) {}
    }

    // 3. Tertiary Fallback: CoinGecko
    if (!priceValue || isNaN(priceValue)) {
        try {
            const cgId = cgMap[ticker] || ticker;
            const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`);
            const cgData = await cgRes.json();
            priceValue = parseFloat(cgData?.[cgId]?.usd);
        } catch (e) {}
    }

    return priceValue;
}

async function fetchStrikePrice(market: any, ticker: 'btc' | 'eth' | 'sol' | 'bnb'): Promise<number> {
    let strikePrice = 0;
    const startTimestamp = parseInt(market.slug.split('-').pop() || '0');

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

const MIN_GAP_THRESHOLDS: { [key in 'btc' | 'eth' | 'sol' | 'bnb']: number } = {
    btc: 30.00,
    eth: 3.00,
    sol: 0.30,
    bnb: 0.80
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

        if (executedMarketIds.size > 20) {
            executedMarketIds.clear();
        }

        // Strictly target BTC 5-minute markets for maximum precision
        const tickers: ('btc')[] = ['btc'];
        for (const ticker of tickers) {
            const market = await getCurrentMarket(ticker);
            if (!market) continue;

            if (executedMarketIds.has(market.id)) continue;

            const endDate = new Date(market.endDate);
            const secondsLeft = Math.round((endDate.getTime() - Date.now()) / 1000);

            // Execute trade at EXACT T-10s window (secondsLeft <= 10 && secondsLeft > 0)
            if (secondsLeft <= 10 && secondsLeft > 0) {
                executedMarketIds.add(market.id);
                console.log(`[Sniper] 🎯 Executing ${ticker.toUpperCase()} snipe at EXACT T-${secondsLeft}s`);
                
                const result = await executeSnipe(market, ticker);
                
                if (result.success) {
                    tradesToday++;
                    console.log(`[Sniper] ✅ ${ticker.toUpperCase()} Snipe executed at T-${secondsLeft}s. Trades today: ${tradesToday}`);
                    
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

        // 4. Position sizing fixed to 1 share per trade
        const entryPrice = 0.97;
        const shares = sharesOverride || 1;
        console.log(`[Sniper] T-10s Position Size: ${shares} share (Price Gap $${priceGap.toFixed(4)} vs Min Guard $${minGap})`);

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
