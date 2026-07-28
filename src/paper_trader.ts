import fs from 'fs';
import path from 'path';
import logger from './logger';
import axios from 'axios';

export interface PaperTrade {
  id: number;
  marketId: string;
  question: string;
  slug: string;
  side: 'YES' | 'NO';
  shares: number;
  entry_price: number;
  exit_price?: number;
  cost: number;
  pnl: number;
  status: 'open' | 'closed';
  entry_time: string;
  exit_time?: string;
  btc_price: number;
  strike_price: number;
}

export interface PaperState {
  balance: number;
  initialBalance: number;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  pnlToday: number;
  trades: PaperTrade[];
}

export class PaperTraderService {
  private dbPath: string;
  private state: PaperState;

  private telegramService: any = null;

  constructor(dbPath?: string, initialBalance?: number) {
    this.dbPath = dbPath || process.env.PAPER_DB_PATH || path.join(process.cwd(), 'paper_trades.json');
    const initBal = initialBalance || parseFloat(process.env.PAPER_INITIAL_BALANCE || '10000');

    this.state = {
      balance: initBal,
      initialBalance: initBal,
      tradesToday: 0,
      winsToday: 0,
      lossesToday: 0,
      pnlToday: 0,
      trades: []
    };

    this.loadState();
  }

  public setTelegramService(telegramService: any) {
    this.telegramService = telegramService;
  }

  private loadState() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.state = { ...this.state, ...parsed };
        logger.info(`Paper Trader state loaded from ${this.dbPath}. Balance: $${this.state.balance.toFixed(2)}`);
      } else {
        this.saveState();
      }
    } catch (e: any) {
      logger.error('Failed to load Paper Trader state:', e.message);
    }
  }

  private saveState() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dbPath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e: any) {
      logger.error('Failed to save Paper Trader state:', e.message);
    }
  }

  public getBalance(): number {
    return this.state.balance;
  }

  public getTrades(): PaperTrade[] {
    return this.state.trades;
  }

  public getStats() {
    const closedTrades = this.state.trades.filter(t => t.status === 'closed');
    const wins = closedTrades.filter(t => t.pnl > 0).length;
    const losses = closedTrades.filter(t => t.pnl < 0).length;
    const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

    const cryptoAnalysis: Record<string, any> = {
      btc: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
      eth: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
      sol: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } },
      bnb: { totalPnL: 0, wins: 0, losses: 0, totalTrades: 0, winRate: 0, tier1: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 }, tier10: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 } }
    };

    closedTrades.forEach(t => {
      let asset = 'btc';
      const slug = t.slug || '';
      if (slug.startsWith('eth')) asset = 'eth';
      else if (slug.startsWith('sol')) asset = 'sol';
      else if (slug.startsWith('bnb')) asset = 'bnb';

      const ca = cryptoAnalysis[asset];
      if (ca) {
        ca.totalTrades++;
        ca.totalPnL += t.pnl;
        if (t.pnl > 0) ca.wins++;
        else if (t.pnl < 0) ca.losses++;
        ca.winRate = ca.totalTrades > 0 ? (ca.wins / ca.totalTrades) * 100 : 0;

        ca.tier1.trades++;
        ca.tier1.pnl += t.pnl;
        if (t.pnl > 0) ca.tier1.wins++;
        else if (t.pnl < 0) ca.tier1.losses++;
        ca.tier1.winRate = ca.tier1.trades > 0 ? (ca.tier1.wins / ca.tier1.trades) * 100 : 0;
      }
    });

    return {
      balance: this.state.balance,
      initialBalance: this.state.initialBalance,
      tradesToday: this.state.tradesToday,
      wins,
      losses,
      winRate,
      totalPnL,
      pnlToday: this.state.pnlToday,
      cryptoAnalysis
    };
  }

  public resetBalance(newBalance?: number): PaperState {
    const initBal = newBalance || parseFloat(process.env.PAPER_INITIAL_BALANCE || '10000');
    this.state = {
      balance: initBal,
      initialBalance: initBal,
      tradesToday: 0,
      winsToday: 0,
      lossesToday: 0,
      pnlToday: 0,
      trades: []
    };
    this.saveState();
    logger.info(`Paper Trader balance reset to $${initBal.toFixed(2)}`);
    return this.state;
  }

  public placePaperTrade(
    market: any,
    side: 'YES' | 'NO',
    entryPrice: number,
    shares: number,
    btcPrice: number,
    strikePrice: number
  ): { success: boolean; trade?: PaperTrade; error?: string } {
    const cost = shares * entryPrice;
    if (this.state.balance < cost) {
      return { success: false, error: `Insufficient paper balance ($${this.state.balance.toFixed(2)} < $${cost.toFixed(2)})` };
    }

    // Deduct cost from paper balance
    this.state.balance -= cost;

    const newTrade: PaperTrade = {
      id: this.state.trades.length + 1,
      marketId: market.id || market.slug,
      question: market.question || market.title || 'BTC Up or Down 5m',
      slug: market.slug || '',
      side: side,
      shares: shares,
      entry_price: entryPrice,
      cost: cost,
      pnl: 0,
      status: 'open',
      entry_time: new Date().toISOString(),
      btc_price: btcPrice,
      strike_price: strikePrice
    };

    this.state.trades.unshift(newTrade);
    this.state.tradesToday++;
    this.saveState();

    logger.info(`[PaperTrader] 📄 Order Executed: BUY ${shares} ${side} @ $${entryPrice} ($${cost.toFixed(2)}). New Balance: $${this.state.balance.toFixed(2)}`);

    // Schedule automatic settlement check after candle expiry boundary
    const startTimestamp = parseInt(newTrade.slug.split('-').pop() || '0');
    const endTimestamp = startTimestamp > 0 ? startTimestamp + 300 : Math.floor(Date.now() / 1000) + 60;
    const delayMs = Math.max(15000, (endTimestamp + 5 - Math.floor(Date.now() / 1000)) * 1000);

    setTimeout(() => this.resolveTrade(newTrade.id), delayMs);

    return { success: true, trade: newTrade };
  }

  public async resolveTrade(tradeId: number) {
    const trade = this.state.trades.find(t => t.id === tradeId && t.status === 'open');
    if (!trade) return;

    try {
      const startTimestamp = parseInt(trade.slug.split('-').pop() || '0');
      const endTimestamp = startTimestamp + 300;
      const nowSec = Math.floor(Date.now() / 1000);

      // Do not settle until the candle has officially closed
      if (nowSec < endTimestamp) {
        const remainingMs = (endTimestamp + 5 - nowSec) * 1000;
        setTimeout(() => this.resolveTrade(tradeId), Math.max(5000, remainingMs));
        return;
      }

      let endPrice = 0;
      let asset = 'btc';
      const slug = trade.slug || '';
      if (slug.startsWith('eth')) asset = 'eth';
      else if (slug.startsWith('sol')) asset = 'sol';
      else if (slug.startsWith('bnb')) asset = 'bnb';

      const pythFeeds: Record<string, string> = {
        btc: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
        eth: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        sol: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        bnb: '2f958158b2235b12e57082c241e205a2f4776b7933fbc742d6bd441703649520'
      };

      const binanceSymbols: Record<string, string> = {
        btc: 'BTCUSDT',
        eth: 'ETHUSDT',
        sol: 'SOLUSDT',
        bnb: 'BNBUSDT'
      };

      const pythId = pythFeeds[asset];
      const binanceSymbol = binanceSymbols[asset];

      try {
        const res = await axios.get(`https://hermes.pyth.network/v2/updates/price/${endTimestamp}?ids[]=${pythId}`, { timeout: 5000 });
        if (res.data?.parsed?.[0]?.price) {
          const p = res.data.parsed[0].price;
          endPrice = parseFloat(p.price) * Math.pow(10, p.expo);
        }
      } catch (e) {}

      if (!endPrice || isNaN(endPrice)) {
        // Fallback to Binance
        try {
          const bvRes = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${binanceSymbol}&interval=5m&limit=5`, { timeout: 5000 });
          if (Array.isArray(bvRes.data)) {
            const candle = bvRes.data.find((k: any) => Math.floor(k[0] / 1000) === startTimestamp);
            if (candle) {
              endPrice = parseFloat(candle[4]); // Index 4 is close price
            }
          }
        } catch (e) {}
      }

      if (endPrice && endPrice > 0) {
        const winningSide = endPrice > trade.strike_price ? 'YES' : 'NO';
        const isWin = trade.side === winningSide;

        if (isWin) {
          const payout = trade.shares * 1.00;
          trade.pnl = payout - trade.cost;
          trade.exit_price = 1.00;
          this.state.balance += payout;
          this.state.winsToday++;
        } else {
          trade.pnl = -trade.cost;
          trade.exit_price = 0.00;
          this.state.lossesToday++;
        }

        trade.status = 'closed';
        trade.exit_time = new Date().toISOString();
        this.state.pnlToday += trade.pnl;
        this.saveState();

        logger.info(`[PaperTrader] 🏁 Trade #${trade.id} Settled: ${isWin ? 'WIN 🟢' : 'LOSS 🔴'} | Winner: ${winningSide} | End Price: $${endPrice} vs Strike $${trade.strike_price} | PnL: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} | New Balance: $${this.state.balance.toFixed(2)}`);

        if (this.telegramService) {
          try {
            this.telegramService.sendAlert(
              `🏁 TRADE SETTLED: ${isWin ? 'WIN 🟢' : 'LOSS 🔴'}\n\n` +
              `Market: ${trade.question}\n` +
              `Outcome: ${winningSide} Won\n` +
              `PnL: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}\n` +
              `Paper Balance: $${this.state.balance.toFixed(2)} USDC`
            );
          } catch (e) {}
        }
      } else {
        // Re-try resolving in 15 seconds if candle is not finalized yet
        setTimeout(() => this.resolveTrade(tradeId), 15000);
      }
    } catch (e: any) {
      logger.error(`[PaperTrader] Error resolving trade #${tradeId}:`, e.message);
    }
  }
}
