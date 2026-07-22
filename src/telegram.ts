import TelegramBot from 'node-telegram-bot-api';
import logger from './logger';
import { BotState, Trade } from './types';

export class TelegramService {
  private bot: TelegramBot;
  private whitelist: number;

  constructor(
    token: string, 
    whitelistId: string, 
    private onToggle: (enabled: boolean) => void,
    private onPaperToggle: (enabled: boolean) => void,
    private getStatus: () => any,
    private getBalance: () => Promise<any>,
    private getMarkets: () => Promise<any[]>,
    private paperTrader: any
  ) {
    this.bot = new TelegramBot(token, { 
      polling: {
        interval: 300,
        autoStart: true
      },
      request: {
        timeoutMs: 30000
      }
    });
    this.whitelist = parseInt(whitelistId);
    this.setupCommands();
    
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });

    this.bot.on('error', (error) => {
      logger.error('Telegram general error:', error);
    });
    
    logger.info('Telegram Bot initialized');
  }

  private setupCommands() {
    const mainKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '/start' }, { text: '/status' }],
          [{ text: '/snipes on' }, { text: '/snipes off' }],
          [{ text: '/paper on' }, { text: '/paper off' }],
          [{ text: '/paper balance' }, { text: '/balance' }],
          [{ text: '/markets' }, { text: '/recent' }],
          [{ text: '/help' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    };

    this.bot.onText(/\/start/, (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const status = this.getStatus();
      this.bot.sendMessage(msg.chat.id, 
        `🤖 *Polymarket Sniper Bot*\n\n` +
        `Status: ${status.enabled ? '🟢 RUNNING' : '🔴 STOPPED'}\n` +
        `Win Rate: ${status.winRate.toFixed(1)}%\n` +
        `Daily P&L: $${status.pnlToday.toFixed(2)}\n\n` +
        `Use the menu below or type /help to see all commands.`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
    });

    this.bot.onText(/\/snipes (on|off)/, (msg, match) => {
      if (!this.checkWhitelist(msg)) return;
      const enabled = match![1] === 'on';
      this.onToggle(enabled);
      this.bot.sendMessage(msg.chat.id, `Sniper loop turned ${enabled ? 'ON 🟢' : 'OFF 🔴'}`, mainKeyboard);
    });

    this.bot.onText(/\/paper (on|off|balance|reset|history)/, async (msg, match) => {
      if (!this.checkWhitelist(msg)) return;
      const cmd = match![1];

      if (cmd === 'on') {
        this.onPaperToggle(true);
        this.bot.sendMessage(msg.chat.id, "📄 Paper Trading Mode: *ENABLED*", { parse_mode: 'Markdown', ...mainKeyboard });
      } else if (cmd === 'off') {
        const isConfirm = msg.text?.includes('confirm');
        if (isConfirm) {
          this.onPaperToggle(false);
          this.bot.sendMessage(msg.chat.id, "🔴 Live Trading Mode: *ENABLED* (Use with caution!)", { parse_mode: 'Markdown', ...mainKeyboard });
        } else {
          this.bot.sendMessage(msg.chat.id, "⚠️ *Switching to LIVE Mode*\n\nReal USDC will be used for trades. Are you sure?\n\nType `/paper off confirm` to proceed.", { parse_mode: 'Markdown' });
        }
      } else if (cmd === 'balance') {
        const stats = this.paperTrader.getStats();
        this.bot.sendMessage(msg.chat.id, 
          `📄 *Paper Trading Stats*\n\n` +
          `Balance: $${parseFloat(stats.balance).toLocaleString()} USDC\n` +
          `Open Positions: ${stats.openPositions}\n` +
          `Total Trades: ${stats.totalTrades}\n` +
          `Win Rate: ${stats.winRate}\n` +
          `Total P&L: $${stats.totalPnl}\n` +
          `Trades Today: ${stats.tradesToday}`,
          { parse_mode: 'Markdown', ...mainKeyboard }
        );
      } else if (cmd === 'reset') {
        this.paperTrader.reset();
        this.bot.sendMessage(msg.chat.id, "🔄 Paper trading state has been reset to $10,000.", mainKeyboard);
      } else if (cmd === 'history') {
        const history = this.paperTrader.getHistory(10);
        if (history.length === 0) {
          this.bot.sendMessage(msg.chat.id, "No paper trades in history.", mainKeyboard);
          return;
        }
        const historyText = history.map((t: any) => 
          `${t.pnl > 0 ? '🟢' : '🔴'} ${t.side} ${t.question.slice(0, 20)}... P&L: $${t.pnl.toFixed(2)}`
        ).join('\n');
        this.bot.sendMessage(msg.chat.id, `🕒 *Recent Paper Trades*\n\n${historyText}`, { parse_mode: 'Markdown', ...mainKeyboard });
      }
    });

    this.bot.onText(/\/status/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const status = this.getStatus();
      let tradesToday = status.totalTradesToday;
      let winRate = status.winRate;
      let pnlToday = status.pnlToday;
      
      if (status.paperMode) {
          const stats = this.paperTrader.getStats();
          tradesToday = stats.tradesToday;
          winRate = stats.winRate;
          pnlToday = stats.totalPnL;
      }
      
      this.bot.sendMessage(msg.chat.id, 
        `📊 *System Status*\n\n` +
        `Sniping: ${status.enabled ? 'Active 🟢' : 'Idle 🔴'}\n` +
        `Mode: ${status.paperMode ? '📄 PAPER' : '🔴 LIVE'}\n` +
        `Trades Today: ${tradesToday}\n` +
        `Win Rate: ${winRate.toFixed(1)}%\n` +
        `Current P&L: $${pnlToday.toFixed(2)}`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
    });

    this.bot.onText(/\/balance/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      this.bot.sendChatAction(msg.chat.id, 'typing');
      const balance = await this.getBalance();
      this.bot.sendMessage(msg.chat.id, 
        `💰 *Wallet Balance*\n\n` +
        `USDC: $${balance.usdc.toFixed(2)}\n` +
        `Pending Shares: ${balance.shares}`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
    });

    this.bot.onText(/\/markets/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      this.bot.sendChatAction(msg.chat.id, 'typing');
      try {
        const markets = await this.getMarkets();
        const market = markets.length > 0 ? markets[0] : null;

        if (!market) {
            const now = new Date();
            const utcTime = now.toISOString();
            
            await this.bot.sendMessage(
                msg.chat.id,
                `⏳ *Current BTC 5-Min Market*\n\n` +
                `🔄 Market not yet available.\n` +
                `🕒 Current UTC time: ${utcTime}\n\n` +
                `💡 Markets appear ~10-15 seconds after each 5-minute window starts.\n` +
                `   Try again in 15-20 seconds.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const endDate = new Date(market.endDate);
        const secondsLeft = Math.round((endDate.getTime() - Date.now()) / 1000);

        let message = `📊 *Current BTC 5-Min Market*\n\n`;
        message += `*Question:* ${market.question}\n`;
        message += `⏳ Expires in ${secondsLeft}s\n`;
        message += `📈 Volume: $${(market.volume || 0).toLocaleString()}\n`;
        message += `🆔 ID: ${market.id}\n`;
        message += `🔗 Slug: ${market.slug}\n`;
        message += `\n💡 Use /snipes on to start sniper automation.`;

        await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await this.bot.sendMessage(msg.chat.id, `❌ Error fetching market: ${error.message}`);
      }
    });

    this.bot.onText(/\/recent/, (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const status = this.getStatus();
      
      if (status.paperMode) {
          const recent = this.paperTrader.getRecentTrades(5);
          if (recent.length === 0) {
              this.bot.sendMessage(msg.chat.id, "📭 No recent paper trades found.", mainKeyboard);
              return;
          }
          let message = `📊 *Recent Paper Trades*\n\n`;
          for (const trade of recent) {
              const tradeStatus = trade.status === 'open' ? '🟡 Open' : '✅ Closed';
              const pnl = trade.pnl ? `$${trade.pnl.toFixed(2)}` : 'N/A';
              message += `${tradeStatus} | ${trade.side} | $${trade.entry_price} | PnL: ${pnl}\n`;
              message += `   ${trade.question}\n\n`;
          }
          this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', ...mainKeyboard });
          return;
      }
      
      if (status.lastTrades.length === 0) {
        this.bot.sendMessage(msg.chat.id, "No recent trades found.", mainKeyboard);
        return;
      }

      const tradeList = status.lastTrades.map((t: Trade) => 
        `${t.status === 'FILLED' ? '✅' : '❌'} ${t.side} at $${t.entryPrice.toFixed(2)} (${t.marketId.slice(0, 8)}...)`
      ).join('\n');
      
      this.bot.sendMessage(msg.chat.id, `🕒 *Recent Trades*\n\n${tradeList}`, { parse_mode: 'Markdown', ...mainKeyboard });
    });

    
    this.bot.onText(/\/close all/, async (msg) => {
        if (!this.checkWhitelist(msg)) return;
        try {
            const openPositions = this.paperTrader.getOpenPositions();
            
            if (openPositions.length === 0) {
                await this.bot.sendMessage(msg.chat.id, '📭 No open positions to close.', mainKeyboard);
                return;
            }

            let closed = 0;
            let totalPnL = 0;
            for (const pos of openPositions) {
                const result = await this.paperTrader.closePosition(pos.id, 0.00);
                if (result.success) {
                    closed++;
                    totalPnL += result.pnl || 0;
                }
            }

            await this.bot.sendMessage(
                msg.chat.id,
                `🔒 Emergency Close Complete\n` +
                `Closed: ${closed}/${openPositions.length} positions\n` +
                `Total PnL: ${totalPnL.toFixed(2)}`,
                mainKeyboard
            );
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
        }
    });

    this.bot.onText(/\/close (\d+)/, async (msg, match) => {
        if (!this.checkWhitelist(msg)) return;
        try {
            const positionId = parseInt(match[1]);
            const position = this.paperTrader.getPositionById(positionId);
            
            if (!position) {
                await this.bot.sendMessage(msg.chat.id, `❌ Position ${positionId} not found.`, mainKeyboard);
                return;
            }

            let exitPrice = 0;
            try {
                const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
                const binanceData = await binanceResponse.json();
                const btcPrice = parseFloat(binanceData.price);
                const strikePrice = position.strike_price || 66000;
                
                if (position.side === 'YES' && btcPrice > strikePrice) {
                    exitPrice = 1.00;
                } else if (position.side === 'NO' && btcPrice < strikePrice) {
                    exitPrice = 1.00;
                }
            } catch (e) {
                exitPrice = 0.00;
            }

            const result = await this.paperTrader.closePosition(positionId, exitPrice);
            
            if (result.success) {
                await this.bot.sendMessage(
                    msg.chat.id,
                    `✅ Position ${positionId} closed\nPnL: ${(result.pnl || 0).toFixed(2)}`,
                    mainKeyboard
                );
            } else {
                await this.bot.sendMessage(msg.chat.id, `❌ Failed to close: ${result.error}`);
            }
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
        }
    });
    this.bot.onText(/\/help/, (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const help = `🛠 *Available Commands*\n\n` +
        `/start - Bot status & menu\n` +
        `/snipes on - Start sniping\n` +
        `/snipes off - Stop sniping\n` +
        `/status - Detailed performance\n` +
        `/balance - Check wallet balance\n` +
        `/recent - Last 5 trades\n` +
        `/markets - Upcoming BTC markets\n` +
        `/close all - Close all open positions (emergency)\n` +
        `/close {id} - Close a specific position\n` +
        `/help - This message`;
      this.bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown', ...mainKeyboard });
    });
  }

  private checkWhitelist(msg: any): boolean {
    if (msg.from?.id !== this.whitelist) {
      logger.warn(`Unauthorized access attempt from ${msg.from?.id}`);
      this.bot.sendMessage(msg.chat.id, "⛔ Unauthorized access.");
      return false;
    }
    return true;
  }

  public sendAlert(message: string) {
    this.bot.sendMessage(this.whitelist, message, { parse_mode: 'Markdown' });
  }
}
// UI Sync
