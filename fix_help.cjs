const fs = require('fs');
let telegram = fs.readFileSync('src/telegram.ts', 'utf8');

const regex = /const help = \`🛠 \*Available Commands\*\\n\\n\` \+[\s\S]+?`/g;

telegram = telegram.replace(regex, 
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
// wait actually it was duplicated, let me just replace the entire help method:
const startIdx = telegram.indexOf('this.bot.onText(/\\/help/, (msg) => {');
const endIdx = telegram.indexOf('private checkWhitelist');
if (startIdx !== -1 && endIdx !== -1) {
    telegram = telegram.substring(0, startIdx) + 
`this.bot.onText(/\\/help/, (msg) => {
      if (!this.checkWhitelist(msg)) return;
      const help = \`🛠 *Available Commands*\\n\\n\` +
        \`/start - Bot status & menu\\n\` +
        \`/snipes on - Start sniping\\n\` +
        \`/snipes off - Stop sniping\\n\` +
        \`/status - Detailed performance\\n\` +
        \`/balance - Check wallet balance\\n\` +
        \`/recent - Last 5 trades\\n\` +
        \`/markets - Upcoming BTC markets\\n\` +
        \`/close all - Close all open positions (emergency)\\n\` +
        \`/close {id} - Close a specific position\\n\` +
        \`/help - This message\`;
      this.bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown', ...mainKeyboard });
    });
  }

  ` + telegram.substring(endIdx);
}

fs.writeFileSync('src/telegram.ts', telegram);
