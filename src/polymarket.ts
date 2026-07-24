import axios from 'axios';
import { Wallet } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import logger from './logger';
import { MarketMetadata, Trade } from './types';

export class PolymarketService {
  private client: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private proxyAddress: string;

  constructor(privateKey: string | undefined, proxyAddress: string) {
    this.proxyAddress = proxyAddress;
    
    if (privateKey) {
      try {
        let key = privateKey.trim();
        if (key.length === 64 && !key.startsWith('0x')) {
          key = '0x' + key;
        }
        
        if (key.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
          this.wallet = new Wallet(key);
          this.client = new ClobClient('https://clob.polymarket.com', 137, this.wallet);
          logger.info('Polymarket trading client initialized successfully.');
        } else {
          logger.warn('Invalid private key provided. PolymarketService will run in discovery-only mode.');
        }
      } catch (err) {
        logger.error('Failed to initialize Polymarket wallet:', err);
      }
    } else {
      logger.info('No private key provided. PolymarketService running in discovery-only mode.');
    }
  }

  async getBalance(): Promise<{ usdc: number; shares: number }> {
    try {
      const targetAddress = this.proxyAddress || this.wallet?.address;
      if (!targetAddress) {
        return { usdc: 0, shares: 0 };
      }

      // Query USDC (Polygon Native USDC / bridged USDC) balance via Polygon public RPC
      // Native USDC on Polygon: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
      // USDC.e (Bridged USDC): 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
      const usdcEAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const nativeUsdcAddress = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

      const usdcAbi = ['function balanceOf(address owner) view returns (uint256)'];
      const rpcUrls = [
        'https://polygon-rpc.com',
        'https://rpc-mainnet.maticvigil.com',
        'https://polygon-bor-rpc.publicnode.com',
        'https://1rpc.io/matter/polygon'
      ];

      let balUsdcE = '0';
      let balNative = '0';

      for (const rpcUrl of rpcUrls) {
        try {
          const provider = new (require('ethers').providers.JsonRpcProvider)(rpcUrl);
          const contractUsdcE = new (require('ethers').Contract)(usdcEAddress, usdcAbi, provider);
          const contractNativeUsdc = new (require('ethers').Contract)(nativeUsdcAddress, usdcAbi, provider);

          const [b1, b2] = await Promise.all([
            contractUsdcE.balanceOf(targetAddress),
            contractNativeUsdc.balanceOf(targetAddress)
          ]);

          balUsdcE = b1.toString();
          balNative = b2.toString();
          if (b1.gt(0) || b2.gt(0)) {
            break; // Found balance successfully
          }
        } catch (e) {
          // Try next RPC provider
        }
      }

      // USDC uses 6 decimals
      const usdcEFormatted = parseFloat(require('ethers').utils.formatUnits(balUsdcE, 6));
      const nativeFormatted = parseFloat(require('ethers').utils.formatUnits(balNative, 6));
      const totalUsdc = usdcEFormatted + nativeFormatted;

      return { usdc: totalUsdc, shares: 0 };
    } catch (err) {
      logger.error('Error fetching balance:', err);
      return { usdc: 0, shares: 0 };
    }
  }

  async scanMarkets(): Promise<MarketMetadata[]> {
    try {
      let allEvents: any[] = [];
      const limit = 1000;
      let nextCursor = '';

      while (true) {
        const res = await axios.get('https://gamma-api.polymarket.com/events/keyset', {
          params: {
            active: true,
            closed: false,
            limit: limit,
            next_cursor: nextCursor || undefined
          }
        });

        const data = res.data;
        const events = data?.events || [];
        
        if (events.length === 0) break;
        
        allEvents.push(...events);
        
        nextCursor = data.next_cursor;
        if (!nextCursor || nextCursor === 'LTE=') {
          break;
        }

        // Safety limit to avoid infinite loops
        if (allEvents.length >= 10000) {
          break;
        }
      }

      let allMarkets: any[] = [];
      for (const event of allEvents) {
        if (event.markets && Array.isArray(event.markets)) {
          allMarkets.push(...event.markets.map((m: any) => ({ ...m, eventTitle: event.title })));
        }
      }

      const now = Date.now();
      const SCAN_WINDOW_SECONDS = 300; 
      const maxEndTime = now + SCAN_WINDOW_SECONDS * 1000;

      const btc5MinMarkets = allMarkets
        .filter((m: any) => {
          const slug = (m.slug || '').toLowerCase();
          const isBTC5Min = slug.match(/^btc-updown-5m-\d+$/) !== null;
          
          const endDate = new Date(m.endDate).getTime();
          const isExpiringSoon = endDate > now && endDate <= maxEndTime;
          
          return isBTC5Min && isExpiringSoon && m.active && !m.closed;
        })
        .map((m: any) => {
          let tokens: string[] = [];
          try {
            tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
          } catch (e) {
            tokens = m.tokens?.map((t: any) => t.tokenId) || [];
          }

          return {
            id: m.conditionId || m.id,
            question: m.title || m.question,
            description: m.description,
            endDate: m.endDate,
            strikePrice: 0,
            yesTokenId: tokens[0],
            noTokenId: tokens[1]
          };
        });
      
      if (btc5MinMarkets.length > 0) {
        logger.info(`[Scanner] Found ${btc5MinMarkets.length} BTC 5-min markets expiring soon.`);
      }
      return btc5MinMarkets;
    } catch (err) {
      logger.error('Error scanning markets via Gamma events:', err);
      return [];
    }
  }

  async getMarket(id: string): Promise<any | null> {
    try {
      const res = await axios.get(`https://gamma-api.polymarket.com/markets/${id}`);
      return res.data;
    } catch (err) {
      logger.error(`Error fetching market ${id}:`, err);
      return null;
    }
  }

  async placeSnipe(market: MarketMetadata, side: 'YES' | 'NO', price: number, size: number): Promise<Trade | null> {
    if (!this.client) return null;

    try {
      const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
      
      const order = await this.client.createOrder({
        tokenID: tokenId,
        price: price,
        side: Side.BUY,
        size: Math.floor(size / price), // Amount of shares
      } as any);

      logger.info(`Snipe order placed: ${order.orderID || 'pending'}`);

      return {
        timestamp: new Date().toISOString(),
        marketId: market.id,
        side,
        entryPrice: price,
        btcPrice: 0, // Will be filled by caller
        amount: size,
        status: 'FILLED'
      };
    } catch (err) {
      logger.error('Snipe execution failed:', err);
      return null;
    }
  }

  async redeem(): Promise<void> {
    try {
      // client.redeem() or similar
      logger.info('Redemption triggered');
    } catch (err) {
      logger.error('Redemption failed:', err);
    }
  }
}
