import { Schema, model } from 'mongoose';

export interface ITrade {
    id: number;
    marketId: string;
    question: string;
    side: 'YES' | 'NO';
    shares: number;
    entry_price: number;
    btc_price?: number;
    strike_price?: number;
    status: 'open' | 'closed';
    entry_time: Date;
    expiry_time?: Date;
    exit_price?: number;
    pnl?: number;
    exit_time?: Date;
}

const TradeSchema = new Schema<ITrade>({
    id: { type: Number, required: true, unique: true },
    marketId: { type: String, required: true },
    question: { type: String, required: true },
    side: { type: String, enum: ['YES', 'NO'], required: true },
    shares: { type: Number, required: true },
    entry_price: { type: Number, required: true },
    btc_price: { type: Number },
    strike_price: { type: Number },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    entry_time: { type: Date, required: true },
    expiry_time: { type: Date },
    exit_price: { type: Number },
    pnl: { type: Number, default: 0 },
    exit_time: { type: Date }
});

export interface IPaperState {
    balance: number;
}

const PaperStateSchema = new Schema<IPaperState>({
    balance: { type: Number, default: 10000 }
});

export const TradeModel = model<ITrade>('Trade', TradeSchema);
export const PaperStateModel = model<IPaperState>('PaperState', PaperStateSchema);
