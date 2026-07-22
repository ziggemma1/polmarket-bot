import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
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
  MAX_DAILY_TRADES = '500',
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
  } else {
    logger.warn('⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID is missing in environment variables. Telegram Service and Sniper loop will not start.');
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
      tradingLimit: parseFloat(TRADING_LIMIT_PER_TRADE),
      maxDailyTrades: parseInt(MAX_DAILY_TRADES)
    });
  }
}

bootstrap().catch(err => {
  logger.error("Failed to bootstrap application:", err);
});

// --- Health Check Server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).send('✅ Bot is awake and running!');
});

app.get('/api/trades', (req, res) => {
  try {
    if (paperTrader) {
      res.json(paperTrader.getRecentTrades(100));
    } else {
      res.json([]);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    if (paperTrader) {
      const stats = paperTrader.getStats();
      const recent = paperTrader.getRecentTrades(100);
      
      const closed = recent.filter((t: any) => t.status === 'closed');
      const wins = closed.filter((t: any) => t.pnl > 0).length;
      const losses = closed.filter((t: any) => t.pnl <= 0).length;
      
      const yesTrades = recent.filter((t: any) => t.side === 'YES').length;
      const noTrades = recent.filter((t: any) => t.side === 'NO').length;
      
      const avgPnL = closed.length > 0 ? stats.totalPnL / closed.length : 0;
      
      let topMarket = 'N/A';
      let bestTrade = 0;
      let worstTrade = 0;
      let totalShares = 0;
      
      if (recent.length > 0) {
        const marketCounts: { [key: string]: number } = {};
        recent.forEach((t: any) => {
          marketCounts[t.question] = (marketCounts[t.question] || 0) + 1;
          if (t.status === 'closed') {
            if (t.pnl > bestTrade) bestTrade = t.pnl;
            if (t.pnl < worstTrade) worstTrade = t.pnl;
          }
          totalShares += t.shares || 0;
        });
        
        let maxCount = 0;
        for (const m in marketCounts) {
          if (marketCounts[m] > maxCount) {
            maxCount = marketCounts[m];
            topMarket = m;
          }
        }
      }
      
      const avgTradeSize = recent.length > 0 ? totalShares / recent.length : 0;
      
      res.json({
        ...stats,
        winLossDist: { wins, losses },
        sideDist: { yes: yesTrades, no: noTrades },
        avgPnL,
        topMarket,
        bestTrade,
        worstTrade,
        avgTradeSize
      });
    } else {
      res.status(500).json({ error: 'Paper trader not initialized' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health server started on port ${PORT}`);
});

server.on('error', (err) => {
  logger.error('Express server error:', err);
});
// UI Sync
