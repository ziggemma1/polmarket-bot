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
}
let config: SniperConfig | null = null;

export function initSniper(cfg: SniperConfig) {
  config = cfg;
}

let sniperActive = false;
let lastExecutedMarketId: string | null = null;
let tradesToday = 0;
let consecutiveLosses = 0;

const CHECK_INTERVAL = 2000; // 2 seconds
const SNIPE_WINDOW = 10;
const MAX_DAILY_TRADES = 4;

async function tick() {
    if (!sniperActive) {
        setTimeout(tick, CHECK_INTERVAL);
        return;
    }

    try {
        // Check daily limit
        if (tradesToday >= MAX_DAILY_TRADES) {
            console.log(`[Sniper] Daily limit reached. Pausing.`);
            sniperActive = false;
            if (config?.telegramService) {
                config.telegramService.sendAlert(`⛔ Daily limit reached (${MAX_DAILY_TRADES} trades). Sniper paused.`);
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
        // 1. Fetch BTC price from Binance
        const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        const binanceData = await binanceResponse.json();
        const btcPrice = parseFloat(binanceData.price);
        console.log(`[Sniper] BTC Price: $${btcPrice}`);

        // 2. Extract strike price from market question
        // The market object should have a 'strikePrice' property or we parse it
        // For now, use the market's 'price' or 'strikePrice'
        const strikePrice = market.strikePrice || market.price || 66000; // Fallback
        console.log(`[Sniper] Strike Price: $${strikePrice}`);

        // 3. Determine winning side
        const side = btcPrice > strikePrice ? 'YES' : 'NO';
        console.log(`[Sniper] ${side} is winning (BTC $${btcPrice} vs strike $${strikePrice})`);

        // 4. Get the PaperTrader instance
        const paperTrader = await getPaperTrader();
        if (!paperTrader) {
            return { success: false, error: 'Paper trader not initialized' };
        }

        // 5. Execute the trade
        const shares = 5; // Minimum shares
        const entryPrice = 0.97;
        const result = await paperTrader.executeTrade({
            marketId: market.id,
            question: market.question,
            side: side,
            shares: shares,
            entryPrice: entryPrice,
            btcPrice: btcPrice,
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
            return { success: false, error: result.error || 'Trade failed' };
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
    setTimeout(tick, 1000);
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
