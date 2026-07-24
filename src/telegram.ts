import TelegramBotModule from 'node-telegram-bot-api';
type TelegramBot = any; // fallback type
const TelegramBot = (TelegramBotModule as any).default || TelegramBotModule;
import logger from './logger';
import { BotState, Trade } from './types';
import { AIAnalystService } from './ai_analyst';

export class TelegramService {
  private bot: TelegramBot;
  private whitelist: number;
  private aiAnalyst: AIAnalystService;

  constructor(
    token: string, 
    whitelistId: string, 
    private onToggle: (enabled: boolean) => void,
    private getStatus: () => any,
    private getBalance: () => Promise<any>,
    private getMarkets: () => Promise<any[]>
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
    this.aiAnalyst = new AIAnalystService();
    this.setupCommands();
    
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });

    this.bot.on('error', (error) => {
      logger.error('Telegram general error:', error);
    });
    
    logger.info('Telegram Bot initialized with AI Analyst integration');
  }

  private setupCommands() {
    const mainKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '/start' }, { text: '/status' }],
          [{ text: '/balance' }],
          [{ text: '/snipes on' }, { text: '/snipes off' }],
          [{ text: '/ai' }, { text: '/aiinsights' }],
          [{ text: '/markets' }, { text: '/recent' }]
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



    this.bot.onText(/\/status/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const status = this.getStatus();
      let tradesToday = status.totalTradesToday;
      let winRate = status.winRate;
      let pnlToday = status.pnlToday;
      
      this.bot.sendMessage(msg.chat.id, 
        `📊 *System Status*\n\n` +
        `Sniping: ${status.enabled ? 'Active 🟢' : 'Idle 🔴'}\n` +
        `Mode: 🔴 LIVE\n` +
        `Trades Today: ${tradesToday}\n` +
        `Win Rate: ${winRate.toFixed(1)}%\n` +
        `Current P&L: $${pnlToday.toFixed(2)}`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
    });

    this.bot.onText(/\/balance/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      this.bot.sendChatAction(msg.chat.id, 'typing');
      
      let balance = { usdc: 0, shares: 0 };
      if (this.getStatus().polymarket) {
        balance = await this.getStatus().polymarket.getBalance();
      } else if (this.getBalance) {
        balance = await this.getBalance();
      }

      this.bot.sendMessage(msg.chat.id, 
        `💰 *Live Wallet Balance (Polygon)*\n\n` +
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

    
    this.bot.onText(/\/aiinsights/, async (msg) => {
      if (!this.checkWhitelist(msg)) return;
      this.bot.sendChatAction(msg.chat.id, 'typing');
      
      const history = this.getStatus().lastTrades;
      const aiResponse = await this.aiAnalyst.generateTradeInsight(history);
      this.bot.sendMessage(msg.chat.id, `🤖 *AI Trade Performance Insights*\n\n${aiResponse}`, { parse_mode: 'Markdown', ...mainKeyboard });
    });

    this.bot.onText(/\/(ai|ask)(?:\s+(.*))?/, async (msg, match) => {
      if (!this.checkWhitelist(msg)) return;
      const userPrompt = match![2]?.trim();

      if (!userPrompt) {
        this.bot.sendMessage(
          msg.chat.id,
          `🤖 *AI Market Analyst*\n\n` +
          `You can chat directly with your read-only AI Analyst using OpenRouter!\n\n` +
          `*Usage:* Type \`/ask <your question>\` or simply send any text message.\n\n` +
          `*Examples:*\n` +
          `• \`/ask Why did my last BTC trade win or lose?\` \n` +
          `• \`/ask Analyze my win rate across past 20 paper trades\`\n` +
          `• \`/ask Is the market currently trending UP or DOWN?\``,
          { parse_mode: 'Markdown', ...mainKeyboard }
        );
        return;
      }

      this.bot.sendChatAction(msg.chat.id, 'typing');
      const history = this.getStatus().lastTrades;
      const markets = await this.getMarkets();
      const aiResponse = await this.aiAnalyst.askAnalyst(userPrompt, history, markets?.[0] || null);

      this.bot.sendMessage(msg.chat.id, `🤖 *AI Analyst Response*\n\n${aiResponse}`, { parse_mode: 'Markdown', ...mainKeyboard });
    });

    // Conversational Fallback: Any regular text message sent by authorized user will be answered by AI Analyst
    this.bot.on('message', async (msg: any) => {
      if (!this.checkWhitelist(msg)) return;
      const text = msg.text?.trim();

      // Skip slash commands
      if (!text || text.startsWith('/')) return;

      this.bot.sendChatAction(msg.chat.id, 'typing');
      const history = this.getStatus().lastTrades;
      const markets = await this.getMarkets();
      const aiResponse = await this.aiAnalyst.askAnalyst(text, history, markets?.[0] || null);

      this.bot.sendMessage(msg.chat.id, `🤖 *AI Analyst Response*\n\n${aiResponse}`, { parse_mode: 'Markdown', ...mainKeyboard });
    });

    this.bot.onText(/\/help/, (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const help = `🛠 *Available Commands*\n\n` +
        `/start - Bot status & menu\n` +
        `/ask {question} - Chat with AI Market Analyst\n` +
        `/aiinsights - Generate AI performance insights\n` +
        `/snipes on - Start sniping\n` +
        `/snipes off - Stop sniping\n` +
        `/status - Detailed performance\n` +
        `/balance - Check wallet balance\n` +
        `/recent - Last 5 trades\n` +
        `/markets - Upcoming BTC markets\n` +
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
