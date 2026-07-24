import axios from 'axios';
import { Wallet } from 'ethers';
import { ClobClient, Side, OrderType, SignatureType } from '@polymarket/clob-client';
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
          // Initialize base CLOB client with polygon chain ID (137) and wallet
          const sigType = this.proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
          this.client = new ClobClient('https://clob.polymarket.com', 137, this.wallet, undefined, sigType, this.proxyAddress || undefined);
          logger.info('Polymarket trading client wallet attached successfully.');
        } else {
          logger.warn('Invalid private key format provided. PolymarketService running in discovery mode.');
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
      let totalUsdc = usdcEFormatted + nativeFormatted;

      // Fallback: If RPC returned 0, query official Polymarket Gamma User Portfolio API
      if (totalUsdc === 0 && targetAddress) {
        try {
          const gammaRes = await axios.get(`https://gamma-api.polymarket.com/users/${targetAddress.toLowerCase()}`);
          if (gammaRes.data && (gammaRes.data.cash || gammaRes.data.portfolioValue)) {
            totalUsdc = parseFloat(gammaRes.data.cash || gammaRes.data.portfolioValue || '0');
          }
        } catch (e) {}
      }

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

  async placeSnipe(market: MarketMetadata, side: 'YES' | 'NO', price: number, size: number): Promise<{ success: boolean; trade?: Trade; error?: string }> {
    if (!this.client || !this.wallet) return { success: false, error: 'CLOB Client not initialized (Missing Private Key)' };

    try {
      const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
      if (!tokenId) {
        return { success: false, error: `Missing token ID for outcome ${side}` };
      }

      // 1. Deriving Level-2 API Credentials from Ethers Wallet Signature
      try {
        const apiCreds = await this.client.createOrDeriveApiKey();
        if (apiCreds && apiCreds.key) {
          // Re-instantiate ClobClient with Level-2 API credentials attached
          const sigType = this.proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
          this.client = new ClobClient('https://clob.polymarket.com', 137, this.wallet, apiCreds, sigType, this.proxyAddress || undefined);
        }
      } catch (e: any) {
        logger.warn('Failed to derive CLOB API credentials:', e?.message || e);
      }
      
      // 2. Post order with Level-2 credentials attached
      const order = await this.client.createAndPostOrder({
        tokenID: tokenId,
        price: price,
        side: Side.BUY,
        size: Math.max(1, Math.floor(size / price)), // Amount of shares
      } as any);

      logger.info(`Live snipe order response: ${JSON.stringify(order)}`);

      if (order && (order.errorMsg || order.success === false)) {
        return { success: false, error: order.errorMsg || 'Order was rejected by Polymarket CLOB' };
      }

      return {
        success: true,
        trade: {
          timestamp: new Date().toISOString(),
          marketId: market.id,
          side,
          entryPrice: price,
          btcPrice: 0,
          amount: size,
          status: 'FILLED'
        }
      };
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || String(err);
      logger.error('Live snipe order execution failed:', errorMsg);
      return { success: false, error: errorMsg };
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
