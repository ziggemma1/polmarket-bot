import axios from 'axios';
import { Wallet, providers, Contract, utils } from 'ethers';
import { ClobClient, Side, OrderType, SignatureTypeV2 } from '@polymarket/clob-client-v2';
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
          const isProxy = this.proxyAddress && this.proxyAddress.toLowerCase() !== this.wallet.address.toLowerCase();
          const sigType = isProxy ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA;
        this.client = new ClobClient({
          host: 'https://clob.polymarket.com',
          chain: 137 as any,
          signer: this.wallet as any,
          creds: undefined,
          signatureType: sigType,
          funderAddress: isProxy ? this.proxyAddress : undefined
        });
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

      // Polymarket USD (pUSD): 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
      // Native USDC on Polygon: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
      // USDC.e (Bridged USDC): 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
      const pusdAddress = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
      const usdcEAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const nativeUsdcAddress = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

      const usdcAbi = ['function balanceOf(address owner) view returns (uint256)'];
      const rpcUrls = [
        'https://polygon-bor-rpc.publicnode.com',
        'https://1rpc.io/matic',
        'https://polygon-rpc.com'
      ];

      let balPusd = '0';
      let balUsdcE = '0';
      let balNative = '0';

      for (const rpcUrl of rpcUrls) {
        try {
          const provider = new providers.JsonRpcProvider(rpcUrl);
          const contractPusd = new Contract(pusdAddress, usdcAbi, provider);
          const contractUsdcE = new Contract(usdcEAddress, usdcAbi, provider);
          const contractNativeUsdc = new Contract(nativeUsdcAddress, usdcAbi, provider);

          const [b0, b1, b2] = await Promise.all([
            contractPusd.balanceOf(targetAddress),
            contractUsdcE.balanceOf(targetAddress),
            contractNativeUsdc.balanceOf(targetAddress)
          ]);

          balPusd = b0.toString();
          balUsdcE = b1.toString();
          balNative = b2.toString();
          if (b0.gt(0) || b1.gt(0) || b2.gt(0)) {
            break; // Found balance successfully
          }
        } catch (e) {
          // Try next RPC provider
        }
      }

      // USDC/pUSD uses 6 decimals
      const pusdFormatted = parseFloat(utils.formatUnits(balPusd, 6));
      const usdcEFormatted = parseFloat(utils.formatUnits(balUsdcE, 6));
      const nativeFormatted = parseFloat(utils.formatUnits(balNative, 6));
      const totalUsdc = pusdFormatted + usdcEFormatted + nativeFormatted;

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
        if (apiCreds && this.wallet) {
          const isProxy = this.proxyAddress && this.proxyAddress.toLowerCase() !== this.wallet?.address.toLowerCase();
          const sigType = isProxy ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA;
          this.client = new ClobClient({
            host: 'https://clob.polymarket.com',
            chain: 137 as any,
            signer: this.wallet as any,
            creds: apiCreds,
            signatureType: sigType,
            funderAddress: isProxy ? this.proxyAddress : undefined
          });
        }
      } catch (e: any) {
        logger.warn('Failed to derive CLOB API credentials:', e?.message || e);
      }
      
      // 2. Fetch live order book & depth check
      let orderbook: any = null;
      try {
        orderbook = await this.client.getOrderBook(tokenId);
      } catch (e: any) {
        logger.warn(`[CLOB Client] Failed to fetch orderbook for ${side}: ${e?.message || e}`);
      }

      const asks = orderbook?.asks || [];
      if (!asks || asks.length === 0) {
        return { success: false, error: 'No liquidity available on orderbook' };
      }

      // Asks sorted ascending
      const bestAsk = parseFloat(asks[0].price);
      // Marketable price: bestAsk + 0.001 buffer, capped at 0.999 max limit
      const targetPrice = Math.min(0.999, Math.max(price, bestAsk + 0.001));

      // Order book depth check: sum available ask size at or below targetPrice
      let availableShares = 0;
      for (const ask of asks) {
        const askPrice = parseFloat(ask.price);
        if (askPrice <= targetPrice) {
          availableShares += parseFloat(ask.size);
        }
      }

      if (availableShares < 1) {
        return { success: false, error: 'No liquidity available at this price' };
      }

      // Cap requested shares to available depth
      const fillableSize = Math.floor(Math.min(size, availableShares));
      if (fillableSize < 1) {
        return { success: false, error: 'Available share depth less than 1 share' };
      }

      const cleanPrice = Math.round(targetPrice * 1000) / 1000;
      logger.info(`[CLOB Client] Marketable Price: $${cleanPrice} | Available Depth: ${availableShares.toFixed(2)} | Order Size: ${fillableSize} shares`);

      // Explicitly pass OrderType.FAK (Fill-And-Kill) as 3rd argument
      const order = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: cleanPrice,
          side: Side.BUY,
          size: fillableSize
        },
        {},
        OrderType.FAK as any
      );

      logger.info(`[CLOB Client] Order Post Result: ${JSON.stringify(order)}`);

      if (!order || !order.success || order.errorMsg) {
        const errMsg = typeof order?.errorMsg === 'string' ? order.errorMsg : JSON.stringify(order?.errorMsg || order);
        logger.error(`Live snipe order response: ${JSON.stringify(order)}`);
        if (errMsg.includes('insufficient funds')) {
          return { success: false, error: 'Insufficient funds on Polymarket proxy wallet.' };
        }
        return { success: false, error: errMsg };
      }

      return {
        success: true,
        trade: {
          timestamp: new Date().toISOString(),
          marketId: market.id,
          side,
          entryPrice: cleanPrice,
          btcPrice: 0,
          amount: fillableSize,
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
