export interface Trade {
  timestamp: string;
  marketId: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  btcPrice: number;
  amount: number;
  status: 'FILLED' | 'MISSED' | 'ERROR';
  profit?: number;
}

export interface BotState {
  enabled: boolean;
  paperMode: boolean;
  totalTradesToday: number;
  winRate: number;
  pnlToday: number;
  lastTrades: Trade[];
}

export interface MarketMetadata {
  id: string;
  question: string;
  description: string;
  endDate: string;
  strikePrice: number;
  yesTokenId: string;
  noTokenId: string;
}
