import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
import logger from './src/logger';
import { PolymarketService } from './src/polymarket';
import { TelegramService } from './src/telegram';
import { BotState, Trade } from './src/types';
import { getPaperTrader } from './src/paper_trader';
import { getUpcomingBTCMarkets } from './src/polymarket/scanner';
import { initSniper, startSniper, stopSniper } from './src/strategies/sniper';

dotenv.config();

// Handle uncaught exceptions globally so the bot never crashes
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const {
  POLYGON_PRIVATE_KEY,
  PROXY_ADDRESS,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_USER_ID,
  TRADING_LIMIT_PER_TRADE = '1.00',
  MAX_DAILY_TRADES = '4',
  PAPER_MODE = 'true',
  PAPER_INITIAL_BALANCE = '10000',
} = process.env;

// --- State ---
const state: BotState = {
  enabled: false,
  paperMode: PAPER_MODE === 'true',
  totalTradesToday: 0,
  winRate: 0,
  pnlToday: 0,
  lastTrades: []
};

// --- Initialization ---
let polymarket: PolymarketService | null = null;
let telegram: TelegramService | null = null;
let initError: string | null = null;
let paperTrader: any = null;

async function bootstrap() {
  paperTrader = await getPaperTrader();

  if (PROXY_ADDRESS) {
    try {
      const sanitizedKey = POLYGON_PRIVATE_KEY?.trim();
      const isValidKey = sanitizedKey && sanitizedKey.match(/^(0x)?[0-9a-fA-F]{64}$/);
      
      if (!isValidKey && !state.paperMode) {
        logger.warn(`Invalid private key format (length: ${sanitizedKey?.length || 0}). Live trading will be disabled.`);
      }
      
      polymarket = new PolymarketService(sanitizedKey, PROXY_ADDRESS);
    } catch (err: any) {
      initError = `Polymarket initialization failed: ${err.message}`;
      logger.error(initError);
    }
  } else {
    initError = 'PROXY_ADDRESS is missing in environment.';
    logger.warn(initError);
  }

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_USER_ID) {
    telegram = new TelegramService(
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_USER_ID,
      (enabled) => { 
        state.enabled = enabled;
        if (enabled) {
          startSniper();
        } else {
          stopSniper();
        }
      },
      (paperMode) => { state.paperMode = paperMode; },
      () => state,
      async () => {
        if (state.paperMode) {
          const stats = paperTrader.getStats();
          return { usdc: stats.balance, shares: stats.openPositions };
        }
        if (polymarket) return await polymarket.getBalance();
        return { usdc: 0, shares: 0 };
      },
      async () => {
        if (polymarket) {
          return await getUpcomingBTCMarkets();
        }
        return [];
      },
      paperTrader
    );
  }

  // --- Background Sync Loop ---
  async function backgroundLoop() {
    if (!telegram) return;
  
    try {
      // Check daily limit
      const currentTradesToday = state.paperMode ? paperTrader.getStats().tradesToday : state.totalTradesToday;
      if (currentTradesToday >= parseInt(MAX_DAILY_TRADES)) {
        if (state.enabled) {
          state.enabled = false;
          stopSniper();
          telegram.sendAlert("🛑 *Bot Paused*: Max daily trades reached.");
        }
      }
    } catch (error) {
      logger.error('Error in backgroundLoop:', error);
    }
  
    setTimeout(backgroundLoop, 5000);
  }
  
  // Start the loop
  setTimeout(backgroundLoop, 5000);
  
  // Initialize sniper module
  if (polymarket && telegram) {
    initSniper({
      paperMode: state.paperMode,
      paperTrader,
      polymarketService: polymarket,
      telegramService: telegram,
      tradingLimit: parseFloat(TRADING_LIMIT_PER_TRADE)
    });
  }
}

bootstrap().catch(err => {
  logger.error("Failed to bootstrap application:", err);
});

// --- Health Check Server ---
const app = express();
app.get('/health', (req, res) => {
  res.status(200).send('✅ Bot is awake and running!');
});

app.get('/status', async (req, res) => {
  try {
    let paperStats = { balance: 0, totalTrades: 0, winRate: 0, totalPnL: 0 };
    if (paperTrader) {
      paperStats = paperTrader.getStats();
    }
    
    // Using simple snippet for getSniperStatus if not fully exported with correct types, but it is exported.
    res.status(200).json({
      status: 'online',
      time: new Date().toISOString(),
      botEnabled: state.enabled,
      paperMode: state.paperMode,
      paperTrading: paperStats,
      liveTrading: {
        tradesToday: state.totalTradesToday,
        pnlToday: state.pnlToday
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: String(error) });
  }
});

app.get('/', (req, res) => {
  if (initError) {
    res.status(500).send(`<h1>Configuration Error</h1><p>${initError}</p><p>Please ensure you have set the correct <b>POLYGON_PRIVATE_KEY</b> and <b>PROXY_ADDRESS</b> in the Settings panel.</p>`);
  } else {
    res.send('<h1>Polymarket Headless Bot</h1><p>Bot is active and listening for Telegram commands. Use /health for pinging.</p>');
  }
});

const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health server started on port ${PORT}`);
});

server.on('error', (err) => {
  logger.error('Express server error:', err);
});
