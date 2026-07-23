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
const SNIPE_WINDOW = 12; // 12 seconds before expiry (T-12s window)


async function settleExpiredPositions() {
    try {
        const paperTrader = await getPaperTrader();
        if (!paperTrader) return;

        const openPositions = paperTrader.getOpenPositions();
        if (openPositions.length === 0) return;

        const now = Date.now();
        const expired = openPositions.filter(pos => pos.expiry_time && now >= new Date(pos.expiry_time).getTime());
        if (expired.length === 0) return;

        console.log(`[Sniper] Found ${expired.length} expired paper positions. Resolving outcomes...`);

        const cgMap: { [key: string]: string } = {
            btc: 'bitcoin',
            eth: 'ethereum',
            sol: 'solana',
            bnb: 'binancecoin'
        };

        for (const position of expired) {
            console.log(`[Sniper] 🔄 Settling expired position ${position.id} (${position.question})...`);

            // Parse ticker from question text
            let ticker: 'btc' | 'eth' | 'sol' | 'bnb' = 'btc';
            const q = (position.question || '').toLowerCase();
            if (q.includes('ethereum') || q.includes('eth')) ticker = 'eth';
            else if (q.includes('solana') || q.includes('sol')) ticker = 'sol';
            else if (q.includes('bnb') || q.includes('binance')) ticker = 'bnb';

            let strikePrice = position.strike_price || 0;
            let closePrice = 0;
            let resolvedViaPolymarket = false;
            let exitPrice = 0.00;
            let outcome = '🔴 LOSS';

            // 1. Try fetching official Polymarket resolution status first
            try {
                const polyRes = await fetch(`https://gamma-api.polymarket.com/markets/${position.marketId}`);
                const polyMarket = await polyRes.json();
                if (polyMarket && polyMarket.closed && polyMarket.outcomePrices) {
                    const outcomePrices = typeof polyMarket.outcomePrices === 'string' 
                        ? JSON.parse(polyMarket.outcomePrices) 
                        : polyMarket.outcomePrices;
                    const yesWon = parseFloat(outcomePrices[0] || '0') > 0.5;
                    const noWon = parseFloat(outcomePrices[1] || '0') > 0.5;

                    if ((position.side === 'YES' && yesWon) || (position.side === 'NO' && noWon)) {
                        exitPrice = 1.00;
                        outcome = '🟢 WIN';
                    } else {
                        exitPrice = 0.00;
                        outcome = '🔴 LOSS';
                    }
                    resolvedViaPolymarket = true;
                    console.log(`[Sniper] Resolved position ${position.id} via official Polymarket API: ${outcome}`);
                }
            } catch (err) {}

            // 2. If Polymarket has not closed/resolved yet, resolve via Binance Vision 5m Candle Close Price
            if (!resolvedViaPolymarket) {
                try {
                    const bvRes = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${ticker.toUpperCase()}USDT&interval=5m&limit=10`);
                    const bvKlines = await bvRes.json();
                    if (Array.isArray(bvKlines) && bvKlines.length > 0) {
                        // Get latest completed 5m candle close price
                        const latestCandle = bvKlines[bvKlines.length - 1];
                        if (latestCandle) {
                            if (!strikePrice) strikePrice = parseFloat(latestCandle[1]); // Index 1 is Open price
                            closePrice = parseFloat(latestCandle[4]); // Index 4 is Close price
                            console.log(`[Sniper] Expiry ${ticker.toUpperCase()} Binance Vision 5m Candle: Open=$${strikePrice}, Close=$${closePrice}`);
                        }
                    }
                } catch (err) {}

                // Fallback to CoinGecko live spot price if Binance Vision fails
                if (!closePrice || isNaN(closePrice)) {
                    try {
                        const cgId = cgMap[ticker] || ticker;
                        const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`);
                        const cgData = await cgRes.json();
                        closePrice = parseFloat(cgData?.[cgId]?.usd);
                    } catch (err) {}
                }

                if (closePrice > 0 && strikePrice > 0) {
                    if (position.side === 'YES' && closePrice > strikePrice) {
                        exitPrice = 1.00;
                        outcome = '🟢 WIN';
                    } else if (position.side === 'NO' && closePrice < strikePrice) {
                        exitPrice = 1.00;
                        outcome = '🟢 WIN';
                    } else {
                        exitPrice = 0.00;
                        outcome = '🔴 LOSS';
                    }
                } else if (closePrice > 0) {
                    // Fallback comparison with entry asset price if strike missing
                    const entryPriceRef = position.btc_price || 0;
                    if (entryPriceRef > 0) {
                        if (position.side === 'YES' && closePrice > entryPriceRef) {
                            exitPrice = 1.00;
                            outcome = '🟢 WIN';
                        } else if (position.side === 'NO' && closePrice < entryPriceRef) {
                            exitPrice = 1.00;
                            outcome = '🟢 WIN';
                        } else {
                            exitPrice = 0.00;
                            outcome = '🔴 LOSS';
                        }
                    }
                }
            }

            const result = await paperTrader.closePosition(position.id, exitPrice);
            if (result.success) {
                const pnl = result.pnl || 0;
                console.log(`[Sniper] Settled position ${position.id} (${position.question}): ${outcome} (ExitPrice: $${exitPrice}, PnL: $${pnl.toFixed(2)})`);

                if (config?.telegramService) {
                    config.telegramService.sendAlert(
                        `📄 PAPER: Position Settled\n` +
                        `Market: ${position.question}\n` +
                        `Outcome: ${outcome}\n` +
                        `Exit Price: $${exitPrice}\n` +
                        `Net PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
                    );
                }
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

        // Clean up executed IDs map
        if (executedMarketIds.size > 20) {
            executedMarketIds.clear();
        }

        // Scan BTC, ETH, SOL, and BNB markets in parallel
        const tickers: ('btc' | 'eth' | 'sol' | 'bnb')[] = ['btc', 'eth', 'sol', 'bnb'];
        for (const ticker of tickers) {
            const market = await getCurrentMarket(ticker);
            if (!market) continue;

            if (executedMarketIds.has(market.id)) continue;

            // Check expiration
            const endDate = new Date(market.endDate);
            const secondsLeft = Math.round((endDate.getTime() - Date.now()) / 1000);

            // Execute snipe in final window
            if (secondsLeft <= SNIPE_WINDOW && secondsLeft > 0) {
                // Mark immediately so the bot NEVER retries this market in the remaining seconds of this cycle
                executedMarketIds.add(market.id);
                console.log(`[Sniper] 🎯 Executing ${ticker.toUpperCase()} snipe at T-${secondsLeft}s`);
                
                const result = await executeSnipe(market, ticker);
                
                if (result.success) {
                    tradesToday++;
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

async function executeSnipe(market: any, ticker: 'btc' | 'eth' | 'sol' | 'bnb'): Promise<{ 
    success: boolean; 
    side?: string; 
    price?: number; 
    shares?: number;
    priceValue?: number; 
    error?: string;
}> {
    try {
        const cgMap: { [key: string]: string } = {
            btc: 'bitcoin',
            eth: 'ethereum',
            sol: 'solana',
            bnb: 'binancecoin'
        };

        // 1. Fetch spot price (Coinbase -> CoinGecko -> Binance Vision)
        let priceValue = 0;
        try {
            const coinbaseResponse = await fetch(`https://api.coinbase.com/v2/prices/${ticker.toUpperCase()}-USD/spot`);
            const coinbaseData = await coinbaseResponse.json();
            priceValue = parseFloat(coinbaseData?.data?.amount);
        } catch (e) {}

        if (!priceValue || isNaN(priceValue)) {
            try {
                const cgId = cgMap[ticker] || ticker;
                const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`);
                const cgData = await cgRes.json();
                priceValue = parseFloat(cgData?.[cgId]?.usd);
            } catch (e) {}
        }

        if (!priceValue || isNaN(priceValue)) {
            try {
                const binanceResponse = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${ticker.toUpperCase()}USDT`);
                const binanceData = await binanceResponse.json();
                priceValue = parseFloat(binanceData?.price);
            } catch (e) {}
        }

        if (!priceValue || isNaN(priceValue)) {
            return { success: false, error: `Could not fetch spot price for ${ticker.toUpperCase()}` };
        }
        console.log(`[Sniper] ${ticker.toUpperCase()} Spot Price: $${priceValue}`);

        // 2. Fetch the strike price (open price of the 5m candle) from Binance Vision API (STRICT MATCH ONLY)
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
                        console.log(`[Sniper] ✅ Strict Binance Vision candle match for ${ticker.toUpperCase()} (timestamp ${startTimestamp}). Open price: $${strikePrice}`);
                    }
                }
            }
        } catch (e: any) {}

        // Fallback to Coinbase Exchange candles for BTC/ETH/SOL ONLY if timestamp strictly matches
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
                            strikePrice = parseFloat(candle[3]); // Index 3 is open price
                            console.log(`[Sniper] ✅ Strict Coinbase candle match for ${ticker.toUpperCase()} (timestamp ${startTimestamp}). Open price: $${strikePrice}`);
                        }
                    }
                }
            } catch (e: any) {}
        }

        // STRICT NO-FALLBACK GUARD: Abort execution if exact 5m candle strike price is missing
        if (!strikePrice || isNaN(strikePrice) || strikePrice <= 0) {
            return { success: false, error: `Exact 5m candle strike price (timestamp ${startTimestamp}) not found for ${ticker.toUpperCase()}` };
        }
        console.log(`[Sniper] Verified Strike Price: $${strikePrice}`);

        // 3. Determine winning side
        const side = priceValue > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] ${side} is winning (${ticker.toUpperCase()} $${priceValue} vs strike $${strikePrice})`);

        // 4. Determine trade execution parameters
        const entryPrice = 0.97;
        const tradingLimit = config?.tradingLimit || 1.00;
        let shares = Math.floor(tradingLimit / entryPrice) || 1;

        // Custom Sizing Logic per Crypto:
        // Bitcoin (BTC): If BTC spot price is $70+ above or below the strike price, boost position size to 10 shares
        if (ticker === 'btc') {
            const priceGap = Math.abs(priceValue - strikePrice);
            if (priceGap >= 70) {
                shares = 10;
                console.log(`[Sniper] 🚀 BTC Custom Strategy Met: Price gap is $${priceGap.toFixed(2)} (>= $70). Boosting position size to 10 shares!`);
            } else {
                console.log(`[Sniper] ℹ️ BTC Price gap is $${priceGap.toFixed(2)} (< $70). Standard ${shares} share.`);
            }
        }
        // Ethereum (ETH): If ETH spot price is $5+ above or below the strike price, boost position size to 10 shares
        else if (ticker === 'eth') {
            const priceGap = Math.abs(priceValue - strikePrice);
            if (priceGap >= 5) {
                shares = 10;
                console.log(`[Sniper] 🚀 ETH Custom Strategy Met: Price gap is $${priceGap.toFixed(2)} (>= $5). Boosting position size to 10 shares!`);
            } else {
                console.log(`[Sniper] ℹ️ ETH Price gap is $${priceGap.toFixed(2)} (< $5). Standard ${shares} share.`);
            }
        }
        // Solana (SOL): If SOL spot price is $0.19+ above or below the strike price, boost position size to 10 shares
        else if (ticker === 'sol') {
            const priceGap = Math.abs(priceValue - strikePrice);
            if (priceGap >= 0.19) {
                shares = 10;
                console.log(`[Sniper] 🚀 SOL Custom Strategy Met: Price gap is $${priceGap.toFixed(2)} (>= $0.19). Boosting position size to 10 shares!`);
            } else {
                console.log(`[Sniper] ℹ️ SOL Price gap is $${priceGap.toFixed(2)} (< $0.19). Standard ${shares} share.`);
            }
        }
        // Binance Coin (BNB): If BNB spot price is $0.60+ above or below the strike price, boost position size to 10 shares
        else if (ticker === 'bnb') {
            const priceGap = Math.abs(priceValue - strikePrice);
            if (priceGap >= 0.60) {
                shares = 10;
                console.log(`[Sniper] 🚀 BNB Custom Strategy Met: Price gap is $${priceGap.toFixed(2)} (>= $0.60). Boosting position size to 10 shares!`);
            } else {
                console.log(`[Sniper] ℹ️ BNB Price gap is $${priceGap.toFixed(2)} (< $0.60). Standard ${shares} share.`);
            }
        }

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
