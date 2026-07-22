const fs = require('fs');

let paperTrader = fs.readFileSync('src/paper_trader.ts', 'utf8');

// 1. Add methods getOpenPositions() and getPositionById()
paperTrader = paperTrader.replace(
  'async executeTrade(',
  `getOpenPositions() {
        return this.positions.filter(p => p.status === 'open');
    }

    getPositionById(id: number) {
        return this.positions.find(p => p.id === id);
    }

    async executeTrade(`
);

// 2. Add strike_price to trade object
paperTrader = paperTrader.replace(
  `btc_price: params.btcPrice,`,
  `btc_price: params.btcPrice,
                strike_price: params.strikePrice,`
);

fs.writeFileSync('src/paper_trader.ts', paperTrader);


let sniper = fs.readFileSync('src/strategies/sniper.ts', 'utf8');

// 1. Add closeExpiredTrades()
const closeLogic = `
async function closeExpiredTrades() {
    try {
        const paperTrader = await getPaperTrader();
        const openPositions = paperTrader.getOpenPositions();

        if (openPositions.length === 0) {
            return;
        }

        console.log(\`[Sniper] Checking \${openPositions.length} open positions for expiry...\`);

        let btcPrice: number | null = null;
        try {
            const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
            const binanceData = await binanceResponse.json();
            btcPrice = parseFloat(binanceData.price);
        } catch (e) {
            console.log('[Sniper] Could not fetch BTC price for closing');
        }

        let closedCount = 0;

        for (const position of openPositions) {
            const entryTime = new Date(position.entry_time);
            const expiryTime = new Date(entryTime.getTime() + 5 * 60 * 1000);
            const now = new Date();
            const secondsSinceExpiry = (now.getTime() - expiryTime.getTime()) / 1000;

            if (secondsSinceExpiry > 5) {
                console.log(\`[Sniper] 🔄 Closing position \${position.id} (expired \${Math.round(secondsSinceExpiry)}s ago)\`);

                let exitPrice = 0;
                let outcome = 'LOSS';

                if (btcPrice !== null) {
                    const strikePrice = position.strike_price || 66000;
                    if (position.side === 'YES' && btcPrice > strikePrice) {
                        exitPrice = 1.00;
                        outcome = '✅ WIN';
                    } else if (position.side === 'NO' && btcPrice < strikePrice) {
                        exitPrice = 1.00;
                        outcome = '✅ WIN';
                    } else {
                        exitPrice = 0.00;
                        outcome = '❌ LOSS';
                    }
                } else {
                    exitPrice = 0.00;
                    outcome = '❌ LOSS (no BTC price)';
                }

                const result = await paperTrader.closePosition(position.id, exitPrice);
                
                if (result.success) {
                    closedCount++;
                    const pnl = result.pnl || 0;
                    console.log(\`[Sniper] \${outcome} Position \${position.id} closed: PnL = $\${pnl.toFixed(2)}\`);
                    
                    if (config?.telegramService) {
                        config.telegramService.sendAlert(
                            \`\${outcome} Position Closed\\n\` +
                            \`Market: \${position.question || 'Unknown'}\\n\` +
                            \`Side: \${position.side}\\n\` +
                            \`Entry: $\${position.entry_price}\\n\` +
                            \`Exit: $\${exitPrice.toFixed(2)}\\n\` +
                            \`PnL: $\${pnl.toFixed(2)}\`
                        );
                    }
                } else {
                    console.log(\`[Sniper] ❌ Failed to close position \${position.id}: \${result.error}\`);
                }
            }
        }

        if (closedCount > 0) {
            console.log(\`[Sniper] Closed \${closedCount} positions.\`);
        }

    } catch (error) {
        console.error('[Sniper] Error closing expired trades:', error);
    }
}

async function tick() {`;

sniper = sniper.replace('async function tick() {', closeLogic);

// 2. Call closeExpiredTrades in tick
sniper = sniper.replace(
  `    if (!sniperActive) {`,
  `    if (!sniperActive) {
        setTimeout(tick, CHECK_INTERVAL);
        return;
    }

    try {
        await closeExpiredTrades();
    } catch (error) {
        console.error('[Sniper] Error in closeExpiredTrades:', error);
    }

    if (!sniperActive) { // Need to re-check after async`
);

// 3. update executeSnipe params and call
sniper = sniper.replace(
  `        const entryPrice = 0.97;
        const result = await paperTrader.executeTrade({
            marketId: market.id,
            question: market.question,
            side: side,
            shares: shares,
            entryPrice: entryPrice,
            btcPrice: btcPrice,
        });`,
  `        const entryPrice = 0.97;
        const result = await paperTrader.executeTrade({
            marketId: market.id,
            question: market.question,
            side: side,
            shares: shares,
            entryPrice: entryPrice,
            btcPrice: btcPrice,
            strikePrice: strikePrice,
        });`
);

fs.writeFileSync('src/strategies/sniper.ts', sniper);
