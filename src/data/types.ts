export type Timeframe = 'M5' | 'M15' | 'H1' | 'H4'
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; spread?: number }
export type DataSource = { getCandles(timeframe: Timeframe, count: number): Promise<Candle[]>; getQuote(): Promise<{ bid: number; ask: number }> }
