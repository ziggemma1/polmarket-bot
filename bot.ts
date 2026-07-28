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
import { initSniper, startSniper, stopSniper, activeAssetsConfig, toggleAssetConfig } from './src/strategies/sniper';

import { PaperTraderService } from './src/paper_trader';

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

let isPaperMode = process.env.PAPER_MODE !== 'false'; // Default paper mode enabled unless explicitly set to false
const paperTrader = new PaperTraderService();

// --- Initialization ---
let polymarket: PolymarketService | null = null;
let telegram: TelegramService | null = null;
let initError: string | null = null;

async function bootstrap() {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      await mongoose.connect(dbUrl);
      logger.info('Connected to MongoDB');
    } catch (e: any) {
      logger.warn('Failed to connect to MongoDB:', e.message);
    }
  } else {
    logger.warn('DATABASE_URL is missing in environment variables. Running without MongoDB.');
  }

  // Polymarket initialization
  if (PROXY_ADDRESS && POLYGON_PRIVATE_KEY) {
    try {
      polymarket = new PolymarketService(POLYGON_PRIVATE_KEY, PROXY_ADDRESS);
      logger.info('Polymarket trading client wallet attached successfully.');
    } catch (err: any) {
      initError = `Failed to initialize Polymarket service: ${err.message}`;
      logger.error(initError);
    }
  } else {
    initError = 'PROXY_ADDRESS or POLYGON_PRIVATE_KEY is missing in environment variables.';
    logger.warn(`⚠️ ${initError}`);
  }

  // Telegram Service
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
      () => ({
        enabled: state.enabled,
        totalTradesToday: isPaperMode ? paperTrader.getStats().tradesToday : state.totalTradesToday,
        winRate: isPaperMode ? paperTrader.getStats().winRate : state.winRate,
        pnlToday: isPaperMode ? paperTrader.getStats().pnlToday : state.pnlToday,
        polymarket: polymarket,
        paperMode: isPaperMode,
        paperTrader: paperTrader
      }),
      async () => {
        if (polymarket) {
          return await polymarket.getBalance();
        }
        return { usdc: 0, shares: 0 };
      },
      async () => {
        if (polymarket) {
          return await getUpcomingBTCMarkets();
        }
        return [];
      },
      (enabled) => {
        isPaperMode = enabled;
        logger.info(`Trading mode changed to: ${isPaperMode ? '📄 PAPER MODE' : '🔴 LIVE TRADING'}`);
      }
    );
    paperTrader.setTelegramService(telegram);
  } else {
    logger.warn('⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID is missing in environment variables. Telegram Service and Sniper loop will not start.');
  }

  // --- Background Sync Loop ---
  async function backgroundLoop() {
    if (!telegram) return;
  
    try {
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
  
  setTimeout(backgroundLoop, 5000);
  
  initSniper({
    getPolymarketService: () => polymarket,
    getPaperTraderService: () => paperTrader,
    telegramService: telegram,
    tradingLimit: parseFloat(TRADING_LIMIT_PER_TRADE),
    maxDailyTrades: parseInt(MAX_DAILY_TRADES)
  });

  setTimeout(() => {
    startSniper();
    state.enabled = true;
    logger.info('Sniper auto-started after 3s flush delay');
  }, 3000);
}

bootstrap().catch(err => {
  logger.error("Failed to bootstrap application:", err);
});

// --- Health Check & Express Server ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (req, res) => {
  res.status(200).send('✅ Bot is awake and running!');
});

app.get('/status', async (req, res) => {
  try {
    let balance = { usdc: 0, shares: 0 };
    if (isPaperMode) {
      balance = { usdc: paperTrader.getBalance(), shares: 0 };
    } else if (polymarket) {
      try {
        balance = await polymarket.getBalance();
      } catch (e) {}
    }

    const pStats = paperTrader.getStats();

    res.status(200).json({
      status: 'online',
      time: new Date().toISOString(),
      botEnabled: state.enabled,
      paperMode: isPaperMode,
      proxyAddress: process.env.PROXY_ADDRESS || '',
      liveTrading: {
        tradesToday: isPaperMode ? pStats.tradesToday : state.totalTradesToday,
        pnlToday: isPaperMode ? pStats.pnlToday : state.pnlToday,
        balance: balance.usdc,
        shares: balance.shares
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: String(error) });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    if (isPaperMode) {
      const pStats = paperTrader.getStats();
      return res.json({
        balance: pStats.balance,
        tradesToday: pStats.tradesToday,
        totalPnL: pStats.totalPnL,
        avgPnL: pStats.tradesToday > 0 ? pStats.totalPnL / pStats.tradesToday : 0,
        winRate: pStats.winRate,
        cryptoAnalysis: pStats.cryptoAnalysis
      });
    }

    let balance = { usdc: 0, shares: 0 };
    if (polymarket) {
      try {
        balance = await polymarket.getBalance();
      } catch (e) {}
    }
    res.json({
      balance: balance.usdc,
      tradesToday: state.totalTradesToday,
      totalPnL: state.pnlToday,
      avgPnL: 0,
      winRate: state.winRate,
      cryptoAnalysis: {
        btc: { totalPnL: state.pnlToday, wins: 0, losses: 0, totalTrades: state.totalTradesToday, winRate: state.winRate, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
        eth: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
        sol: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
        bnb: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } }
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/trades', (req, res) => {
  if (isPaperMode) {
    return res.json(paperTrader.getTrades());
  }
  res.json(state.lastTrades || []);
});

app.post('/api/snipes/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    state.enabled = enabled;
    if (enabled) startSniper();
    else stopSniper();
    logger.info(`Dashboard toggled sniping engine to: ${enabled ? 'ACTIVE 🟢' : 'PAUSED 🔴'}`);
    return res.json({ success: true, enabled: state.enabled });
  }
  res.status(400).json({ error: 'Invalid enabled boolean parameter' });
});

app.post('/api/mode/toggle', (req, res) => {
  const { paperMode } = req.body;
  if (typeof paperMode === 'boolean') {
    isPaperMode = paperMode;
    logger.info(`Dashboard toggled trading mode to: ${isPaperMode ? '📄 PAPER MODE' : '🔴 LIVE TRADING'}`);
    return res.json({ success: true, paperMode: isPaperMode });
  }
  res.status(400).json({ error: 'Invalid paperMode boolean parameter' });
});

app.post('/api/reset', (req, res) => {
  try {
    const newState = paperTrader.resetBalance(10000);
    res.json({ success: true, message: 'Paper balance reset to $10,000.00 USDC', balance: newState.balance });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/assets', (req, res) => {
  res.json(activeAssetsConfig);
});

app.post('/api/assets/toggle', (req, res) => {
  const { asset, enabled } = req.body;
  if (asset && typeof enabled === 'boolean' && ['btc', 'eth', 'sol', 'bnb'].includes(asset)) {
    toggleAssetConfig(asset as any, enabled);
    return res.json({ success: true, activeAssets: activeAssetsConfig });
  }
  res.status(400).json({ error: 'Invalid asset or enabled parameter' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT || "3001");
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
