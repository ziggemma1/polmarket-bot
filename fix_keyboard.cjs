const fs = require('fs');

let telegram = fs.readFileSync('src/telegram.ts', 'utf8');

telegram = telegram.replace(
    /const mainKeyboard = {[\s\S]+?resize_keyboard: true,/g,
    `const mainKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '/start' }, { text: '/status' }],
          [{ text: '/snipes on' }, { text: '/snipes off' }],
          [{ text: '/paper on' }, { text: '/paper off' }],
          [{ text: '/markets' }, { text: '/recent' }],
          [{ text: '/close all' }, { text: '/paper balance' }],
          [{ text: '/help' }]
        ],
        resize_keyboard: true,`
);

fs.writeFileSync('src/telegram.ts', telegram);
