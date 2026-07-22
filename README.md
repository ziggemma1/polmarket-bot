# Polymarket Sniper Bot

A headless Telegram bot that monitors 5-minute BTC Polymarket markets and executes trades.

## Local Development
1. Clone the repository
2. Run \`npm install\`
3. Create a \`.env\` file with required variables.
4. Run \`npm run dev\`

## Render Deployment (Free Tier)

This bot is fully compatible with Render's Free tier and includes a built-in keep-alive HTTP server to prevent it from going to sleep.

### 1. Render Setup
1. Create a new **Web Service** on Render
2. Connect your GitHub repository
3. Set the following details:
   - **Build Command:** \`npm install && npm run build\`
   - **Start Command:** \`npm start\`
   - **Instance Type:** Free

### 2. Environment Variables (Render Secrets)
Add these variables in your Render dashboard:
- \`TELEGRAM_BOT_TOKEN\` – Your BotFather token
- \`TELEGRAM_USER_ID\` – Your Telegram User ID
- \`POLYGON_PRIVATE_KEY\` – Your Polymarket private key
- \`PROXY_ADDRESS\` – Your Polymarket proxy address
- \`PAPER_MODE\` – \`true\` (recommended for testing)
- \`PAPER_INITIAL_BALANCE\` – \`10000\`
- \`PORT\` – Leave empty (Render sets this automatically)

### 3. External Keep-Alive Setup (cron-job.org)
Render's Free tier spins down web services after 15 minutes of no incoming HTTP traffic. The bot uses Telegram long-polling, which doesn't count as incoming traffic.

To keep the bot awake 24/7 so it doesn't miss the 5-minute snipe windows:
1. Go to [cron-job.org](https://cron-job.org) and create a free account
2. Click **Create Cronjob**
3. **Title:** Polymarket Sniper Wake
4. **URL:** \`https://YOUR-APP-NAME.onrender.com/health\` (replace with your actual Render URL)
5. **Schedule:** Every 5 minutes
6. Click **Create**

Alternatively, you can use [UptimeRobot](https://uptimerobot.com) to ping the \`/health\` endpoint every 5 minutes.

### 4. Testing
Once deployed:
1. Visit \`https://YOUR-APP-NAME.onrender.com/health\` – you should see "✅ Bot is awake and running!"
2. Visit \`https://YOUR-APP-NAME.onrender.com/status\` – you should see JSON with bot stats
3. In Telegram, send \`/status\` to verify it responds immediately.

> **Note on Free Tier:** The Free tier has limited CPU. During the 10-second snipe window, CPU throttling may delay your snipe by 1-3 seconds. For paper trading, this is fine. When switching to real money, it is highly recommended to upgrade to Render's **Starter tier ($7/mo)** to ensure your snipes fill consistently.
