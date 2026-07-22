const fs = require('fs');

let telegram = fs.readFileSync('src/telegram.ts', 'utf8');

const closeCommand = `
    this.bot.onText(/\\/close all/, async (msg) => {
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
                \`🔒 Emergency Close Complete\\n\` +
                \`Closed: \${closed}/\${openPositions.length} positions\\n\` +
                \`Total PnL: $\${totalPnL.toFixed(2)}\`,
                mainKeyboard
            );
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, \`❌ Error: \${error.message}\`);
        }
    });

    this.bot.onText(/\\/close (\\d+)/, async (msg, match) => {
        if (!this.checkWhitelist(msg)) return;
        try {
            const positionId = parseInt(match[1]);
            const position = this.paperTrader.getPositionById(positionId);
            
            if (!position) {
                await this.bot.sendMessage(msg.chat.id, \`❌ Position \${positionId} not found.\`, mainKeyboard);
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
                    \`✅ Position \${positionId} closed\\nPnL: $\${(result.pnl || 0).toFixed(2)}\`,
                    mainKeyboard
                );
            } else {
                await this.bot.sendMessage(msg.chat.id, \`❌ Failed to close: \${result.error}\`);
            }
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, \`❌ Error: \${error.message}\`);
        }
    });
`;

telegram = telegram.replace(
    'this.bot.onText(/\\/help/, (msg) => {',
    closeCommand + '\\n    this.bot.onText(/\\/help/, (msg) => {'
);

telegram = telegram.replace(
    /const help = \`🛠 \*Available Commands\*\\n\\n\` \+[\s\S]+?`/g,
    `const help = \`🛠 *Available Commands*\\n\\n\` +
        \`/start - Bot status & menu\\n\` +
        \`/snipes on - Start sniping\\n\` +
        \`/snipes off - Stop sniping\\n\` +
        \`/status - Detailed performance\\n\` +
        \`/balance - Check wallet balance\\n\` +
        \`/recent - Last 5 trades\\n\` +
        \`/markets - Upcoming BTC markets\\n\` +
        \`/close all - Close all open positions (emergency)\\n\` +
        \`/close {id} - Close a specific position\\n\` +
        \`/help - This message\``
);

fs.writeFileSync('src/telegram.ts', telegram);
