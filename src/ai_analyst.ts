import axios from 'axios';
import logger from './logger';

export class AIAnalystService {
  private openRouterApiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.openRouterApiKey = apiKey || process.env.OPENROUTER_API_KEY || '';
    // Default to active free OpenRouter model
    this.model = model || process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';
  }

  public isConfigured(): boolean {
    return Boolean(this.openRouterApiKey && this.openRouterApiKey.trim().length > 0);
  }

  public async askAnalyst(userQuery: string, tradeHistory: any[], currentMarketData?: any): Promise<string> {
    if (!this.isConfigured()) {
      return "⚠️ OpenRouter API key is not configured. Please set `OPENROUTER_API_KEY` in your environment variables.";
    }

    try {
      // Build quantitative snapshot context
      const tradesSummary = tradeHistory.slice(0, 15).map((t: any) => {
        const outcomeStr = t.status === 'closed' 
          ? (t.pnl > 0 ? 'WIN (+1.00)' : 'LOSS (-0.97)')
          : 'OPEN';
        return `- [Trade #${t.id}] Market: ${t.question} | Side: ${t.side} | Entry Price: $${t.entry_price} | Strike: $${t.strike_price || 'N/A'} | SpotAtEntry: $${t.btc_price || 'N/A'} | Status: ${outcomeStr} | PnL: $${t.pnl?.toFixed(2) || '0.00'}`;
      }).join('\n');

      const marketContext = currentMarketData ? JSON.stringify(currentMarketData, null, 2) : "No active 5m market live snapshot.";

      const systemPrompt = `You are an expert read-only Quantitative Crypto & Polymarket Analyst assistant embedded in a Polymarket trading bot.
IMPORTANT SAFETY DIRECTIVE:
1. You have strictly READ-ONLY monitoring and analysis authorization.
2. You CANNOT place, modify, or execute trades under any circumstances.
3. Your goal is to analyze past trading performance, identify win/loss patterns, evaluate market conditions, and answer user queries to help improve trading strategy.

CURRENT LIVE MARKET DATA:
${marketContext}

RECENT TRADE HISTORY (LAST 15 TRADES):
${tradesSummary || 'No recent trades logged yet.'}

Respond directly and concisely in GitHub-style Markdown. Be analytical, insightful, and practical.`;

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userQuery }
          ],
          temperature: 0.7,
          max_tokens: 800
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openRouterApiKey}`,
            'HTTP-Referer': 'https://polmarket-bot.onrender.com',
            'X-Title': 'Polymarket AI Analyst Bot',
            'Content-Type': 'application/json'
          },
          timeout: 25000
        }
      );

      const aiReply = response.data?.choices?.[0]?.message?.content;
      if (aiReply) {
        return aiReply;
      }
      return "⚠️ Received an empty response from OpenRouter AI.";

    } catch (error: any) {
      logger.error('[AI Analyst] Error querying OpenRouter:', error?.response?.data || error.message);
      if (error?.response?.status === 401) {
        return "❌ OpenRouter Authorization Failed: Invalid API key.";
      }
      if (error?.response?.status === 429) {
        return "⏳ OpenRouter Rate Limit reached for free model. Please wait a moment and try again.";
      }
      return `❌ AI Analyst Error: ${error?.response?.data?.error?.message || error.message}`;
    }
  }

  public async generateTradeInsight(tradeHistory: any[]): Promise<string> {
    const prompt = "Please perform a quick performance audit of my recent trades. Highlight what's working well, identify key loss patterns (e.g. entry timing, price gaps), and recommend specific strategy tweaks to maximize win rate.";
    return this.askAnalyst(prompt, tradeHistory);
  }
}
