import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import logger from './src/logger';
import { PolymarketService } from './src/polymarket';
import { TelegramService } from './src/telegram';
import { BotState, Trade } from './src/types';
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
  MAX_DAILY_TRADES = '500000',
} = process.env;

// --- State ---
const state: BotState = {
  enabled: false,
  totalTradesToday: 0,
  winRate: 0,
  pnlToday: 0,
  lastTrades: []
};

// --- Initialization ---
let polymarket: PolymarketService | null = null;
let telegram: TelegramService | null = null;
let initError: string | null = null;

async function bootstrap() {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      logger.info('Connecting to MongoDB...');
      await mongoose.connect(dbUrl);
      logger.info('Connected to MongoDB successfully.');
    } catch (err: any) {
      logger.error('Failed to connect to MongoDB:', err);
    }
  } else {
    logger.warn('DATABASE_URL is missing in environment variables. Running without MongoDB.');
  }

  const privateKey = process.env.POLYGON_PRIVATE_KEY?.trim() || POLYGON_PRIVATE_KEY?.trim();
  const proxyAddress = process.env.PROXY_ADDRESS?.trim() || PROXY_ADDRESS?.trim();

  if (proxyAddress) {
    try {
      const isValidKey = privateKey && privateKey.match(/^(0x)?[0-9a-fA-F]{64}$/);
      
      if (!isValidKey) {
        logger.warn(`Invalid or missing private key format (length: ${privateKey?.length || 0}). Live trading will be disabled.`);
      } else {
        logger.info(`Initializing Polymarket Live Trading Service for proxy: ${proxyAddress.slice(0, 6)}...`);
      }
      
      polymarket = new PolymarketService(privateKey, proxyAddress);
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
      () => ({ ...state, polymarket }),
      async () => {
        if (polymarket) return await polymarket.getBalance();
        return { usdc: 0, shares: 0 };
      },
      async () => {
        if (polymarket) {
          return await getUpcomingBTCMarkets();
        }
        return [];
      }
    );
  } else {
    logger.warn('⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID is missing in environment variables. Telegram Service and Sniper loop will not start.');
  }

  // --- Background Sync Loop ---
  async function backgroundLoop() {
    if (!telegram) return;
  
    try {
      // Check daily limit
      if (state.totalTradesToday >= parseInt(MAX_DAILY_TRADES)) {
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
  
  initSniper({
    getPolymarketService: () => polymarket,
    telegramService: telegram,
    tradingLimit: parseFloat(TRADING_LIMIT_PER_TRADE),
    maxDailyTrades: parseInt(MAX_DAILY_TRADES)
  });
  // Delay auto-start by 3s to let Telegram polling flush any stale /snipes off commands
  setTimeout(() => {
    startSniper();
    state.enabled = true;
    logger.info('Sniper auto-started after 3s flush delay');
  }, 3000);
}

bootstrap().catch(err => {
  logger.error("Failed to bootstrap application:", err);
});

// --- Health Check Server ---
const app = express();
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (req, res) => {
  res.status(200).send('✅ Bot is awake and running!');
});

app.get('/status', async (req, res) => {
  try {
    res.status(200).json({
      status: 'online',
      time: new Date().toISOString(),
      botEnabled: state.enabled,
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
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health server started on port ${PORT}`);
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    logger.warn(`Port ${PORT} is already in use. Skipping Express health server on local bot.`);
  } else {
    logger.error('Express server error:', err);
  }
});
