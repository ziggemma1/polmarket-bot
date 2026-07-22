import path from 'path';
import fs from 'fs';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const DB_PATH = process.env.PAPER_DB_PATH || path.join(logsDir, 'paper_trades.json');
const INITIAL_BALANCE = parseFloat(process.env.PAPER_INITIAL_BALANCE || '10000');

let instance: PaperTrader | null = null;

export class PaperTrader {
    private balance: number = INITIAL_BALANCE;
    private trades: any[] = [];
    private positions: any[] = [];
    private initialized: boolean = false;
    private nextTradeId: number = 1;

    private constructor() {}

    static async getInstance(): Promise<PaperTrader> {
        if (!instance) {
            instance = new PaperTrader();
            await instance.init();
        }
        return instance;
    }

    async init() {
        if (this.initialized) return;

        // Load existing trades from JSON
        await this.loadTrades();
        this.initialized = true;
        console.log(`[PaperTrader] Initialized with balance: $${this.balance}`);
    }

    private saveState() {
        try {
            const data = {
                balance: this.balance,
                trades: this.trades,
                positions: this.positions,
                nextTradeId: this.nextTradeId
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('Failed to save paper state:', err);
        }
    }

    private async loadTrades() {
        try {
            if (fs.existsSync(DB_PATH)) {
                const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
                this.balance = data.balance ?? INITIAL_BALANCE;
                this.trades = data.trades ?? [];
                this.positions = data.positions ?? [];
                this.nextTradeId = data.nextTradeId ?? 1;
            } else {
                this.balance = INITIAL_BALANCE;
                this.saveState();
            }
        } catch (err) {
            console.error('Failed to load paper state:', err);
            this.balance = INITIAL_BALANCE;
        }

        console.log(`[PaperTrader] Loaded ${this.trades.length} trades, ${this.positions.length} open positions`);
    }

    getOpenPositions() {
        return this.positions.filter(p => p.status === 'open');
    }

    getPositionById(id: number) {
        return this.positions.find(p => p.id === id);
    }

    async executeTrade(params: {
        marketId: string;
        question?: string;
        side: 'YES' | 'NO';
        shares: number;
        entryPrice: number;
        btcPrice?: number;
        strikePrice?: number;
    }): Promise<{ success: boolean; trade?: any; error?: string }> {
        try {
            const cost = params.shares * params.entryPrice;
            
            // Check balance
            if (cost > this.balance) {
                return { 
                    success: false, 
                    error: `Insufficient balance: need $${cost.toFixed(2)}, have $${this.balance.toFixed(2)}` 
                };
            }

            // Deduct from balance
            this.balance -= cost;

            const now = new Date().toISOString();
            
            const trade = {
                id: this.nextTradeId++,
                marketId: params.marketId,
                question: params.question || 'Unknown',
                side: params.side,
                shares: params.shares,
                entry_price: params.entryPrice,
                btc_price: params.btcPrice,
                strike_price: params.strikePrice,
                status: 'open',
                entry_time: now,
                pnl: 0
            };

            this.positions.push(trade);
            this.trades.push(trade);
            this.saveState();

            console.log(`[PaperTrader] ✅ Trade recorded: ${params.side} at $${params.entryPrice}`);
            console.log(`[PaperTrader] 💰 New balance: $${this.balance.toFixed(2)}`);

            return { success: true, trade };

        } catch (error) {
            console.error('[PaperTrader] Error executing trade:', error);
            return { success: false, error: String(error) };
        }
    }

    async closePosition(tradeId: number, exitPrice: number): Promise<{ success: boolean; pnl?: number; error?: string }> {
        try {
            const tradeIndex = this.positions.findIndex(p => p.id === tradeId);
            if (tradeIndex === -1) {
                return { success: false, error: 'Trade not found' };
            }
            
            const trade = this.positions[tradeIndex];
            if (trade.status === 'closed') {
                return { success: false, error: 'Trade already closed' };
            }

            const proceeds = trade.shares * exitPrice;
            const cost = trade.shares * trade.entry_price;
            const pnl = proceeds - cost;

            // Update balance
            this.balance += proceeds;

            const now = new Date().toISOString();

            // Update in-memory state
            trade.status = 'closed';
            trade.exit_price = exitPrice;
            trade.pnl = pnl;
            trade.exit_time = now;

            // Remove from positions
            this.positions.splice(tradeIndex, 1);
            
            // Note: The trade is already in this.trades (by reference if pushed together, or we can update it)
            const mainTradeIndex = this.trades.findIndex(p => p.id === tradeId);
            if (mainTradeIndex !== -1) {
                this.trades[mainTradeIndex] = { ...trade };
            }
            
            this.saveState();

            console.log(`[PaperTrader] 📊 Trade ${tradeId} closed: PnL = $${pnl.toFixed(2)}`);
            console.log(`[PaperTrader] 💰 New balance: $${this.balance.toFixed(2)}`);

            return { success: true, pnl };

        } catch (error) {
            console.error('[PaperTrader] Error closing position:', error);
            return { success: false, error: String(error) };
        }
    }
    
    async syncPositions(fetchMarket: (id: string) => Promise<any>) {
        for (const pos of [...this.positions]) {
            try {
                const market = await fetchMarket(pos.marketId);
                if (market && market.closed) {
                    const outcomes = JSON.parse(market.outcomePrices || '[]');
                    const yesPrice = parseFloat(outcomes[0] || '0');
                    const noPrice = parseFloat(outcomes[1] || '0');
                    
                    let exitPrice = 0;
                    if (pos.side === 'YES') {
                        exitPrice = yesPrice;
                    } else {
                        exitPrice = noPrice;
                    }
                    
                    await this.closePosition(pos.id, exitPrice);
                }
            } catch (err) {
                console.error(`Error syncing paper position ${pos.marketId}:`, err);
            }
        }
    }

    getBalance(): number {
        return this.balance;
    }

    getStats() {
        const closedTrades = this.trades.filter(t => t.status === 'closed');
        const openPositions = this.positions.length;
        const totalTrades = closedTrades.length;
        const wins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

        return {
            balance: this.balance,
            openPositions,
            totalTrades,
            winRate,
            totalPnL,
            tradesToday: this.getTradesToday(),
        };
    }

    getTradesToday(): number {
        const today = new Date().toDateString();
        const todayTrades = this.trades.filter(t => {
            const tradeDate = new Date(t.entry_time).toDateString();
            return tradeDate === today;
        });
        return todayTrades.length;
    }

    getRecentTrades(limit: number = 10) {
        return this.trades
            .sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime())
            .slice(0, limit);
    }

    async reset() {
        this.balance = INITIAL_BALANCE;
        this.positions = [];
        this.trades = [];
        this.nextTradeId = 1;
        this.saveState();
        console.log(`[PaperTrader] 🔄 Reset. Balance: $${this.balance}`);
    }
    
    public getDailyPnl(): number {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        
        let dailyPnl = 0;
        for (const trade of this.trades) {
            if (trade.status === 'closed' && new Date(trade.entry_time).getTime() >= startOfDay) {
                 dailyPnl += trade.pnl || 0;
            }
        }
        return dailyPnl;
    }

    public checkLossStreak(maxStreak: number): boolean {
        const closed = this.trades.filter(t => t.status === 'closed');
        if (closed.length < maxStreak) return false;
        
        const recent = closed.slice(-maxStreak);
        return recent.every(t => t.pnl !== undefined && t.pnl < 0);
    }

    async closeAllPositions(exitPrice: number) {
        for (const pos of this.positions) {
            await this.closePosition(pos.id, exitPrice);
        }
    }
}

export async function getPaperTrader(): Promise<PaperTrader> {
    return await PaperTrader.getInstance();
}
// UI Sync
