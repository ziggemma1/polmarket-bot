import axios from 'axios';
import logger from '../logger';

const GAMMA_API = 'https://gamma-api.polymarket.com';

/**
 * Calculates the exact slug for the current BTC 5-minute market
 * based on the current UTC time rounded down to the nearest 5 minutes.
 */
function getCurrentBTC5mSlug(): string {
    const now = new Date();
    
    // Get UTC components
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();
    const hours = now.getUTCHours();
    const minutes = now.getUTCMinutes();
    
    // Round DOWN to the nearest 5-minute mark (e.g., 21:11 -> 21:10)
    const flooredMinutes = Math.floor(minutes / 5) * 5;
    
    // Construct the UTC date object for the floored time
    const flooredDate = new Date(Date.UTC(year, month, day, hours, flooredMinutes, 0, 0));
    
    // Convert to Unix timestamp (seconds since epoch)
    const unixTimestamp = Math.floor(flooredDate.getTime() / 1000);
    
    return `btc-updown-5m-${unixTimestamp}`;
}

export async function getCurrentBTCMarket() {
    const slug = getCurrentBTC5mSlug();
    logger.info(`[Scanner] Target slug: ${slug}`);

    try {
        // Query the specific market by its exact slug
        // This bypasses the Gamma API indexing delay
        const url = `${GAMMA_API}/markets?slug=${slug}`;
        const response = await axios.get(url);

        if (response.data && response.data.length > 0) {
            const market = response.data[0];
            logger.info(`[Scanner] ✅ Market found: ${market.question}`);
            
            // Extract tokens correctly
            let tokens: string[] = [];
            try {
              tokens = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);
            } catch (e) {
              tokens = market.tokens?.map((t: any) => t.tokenId) || [];
            }
            
            return {
                id: market.id.toString(),
                question: market.question || market.title || 'Unknown',
                slug: market.slug,
                endDate: market.endDate,
                active: market.active !== false,
                closed: market.closed === true,
                outcomes: market.outcomes || ['Yes', 'No'],
                clobTokenIds: market.clobTokenIds || [],
                volume: market.volume || 0,
                yesTokenId: tokens[0] || '',
                noTokenId: tokens[1] || '',
                strikePrice: 0
            };
        } else {
            // The market likely exists on-chain but hasn't been indexed by Gamma yet.
            logger.info(`[Scanner] ⚠️ Market not yet indexed by Gamma. Waiting for next cycle...`);
            return null;
        }
    } catch (error: any) {
        logger.error(`[Scanner] Error fetching market: ${error.message}`);
        return null;
    }
}

export async function getUpcomingBTCMarkets() {
    const market = await getCurrentBTCMarket();
    return market ? [market] : [];
}
