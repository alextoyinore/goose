import type { Candle, Timeframe } from './data/types'
import type { AccountState, AnalyzeCandles, EngineAnalysis, EngineStatus, EngineTradeMarked, EngineHistory, BacktestRequest, BacktestResult, RiskSettings } from './data/engine'

declare global {
  interface Window {
    aurum?: {
      analyze: (candles: AnalyzeCandles | Candle[]) => Promise<EngineAnalysis & AccountState>
      markTaken: (signalId: string, actualEntry?: number, manualOverride?: boolean) => Promise<EngineTradeMarked & { account?: AccountState; error?: string; manualOverride?: boolean }>
      saveSettings: (settings: RiskSettings) => Promise<AccountState>
      getState: () => Promise<AccountState>
      closeTrade: (tradeId: number, exitPrice: number) => Promise<{ updated: boolean; error?: string; account?: AccountState; realizedPnl?: number }>
      updateTrackedStop: (tradeId: number, stop: number) => Promise<{ updated: boolean; error?: string; account?: AccountState }>
      forgetTrackedTrade: (tradeId: number) => Promise<{ updated: boolean; error?: string; signalId?: string; account?: AccountState }>
      mt5Connect: () => Promise<{ connected: boolean; error?: string; terminalPath?: string; server?: string; currency?: string; accountMode?: string; tradeAllowed?: boolean; balance?: number; equity?: number; margin?: number; freeMargin?: number }>
      mt5StartTerminal: () => Promise<{ started: boolean; alreadyRunning?: boolean; terminalPath?: string; error?: string }>
      mt5ShowTerminal: () => Promise<{ shown: boolean }>
      mt5Positions: (symbol?: string) => Promise<{ positions: Mt5Position[] }>
      mt5Candles: (symbol: string, timeframe: Timeframe, count?: number, startPos?: number) => Promise<{ symbol: string; timeframe: Timeframe; candles: Candle[] }>
      cacheMt5History: (request: { symbol: string; timeframe: Timeframe; startDate: string; endDate: string; server?: string }) => Promise<{ symbol: string; timeframe: Timeframe; bars: number; cachedBars: number; newBars: number; availableStart: string | null; availableEnd: string | null }>
      mt5Quote: (symbol: string) => Promise<{ symbol: string; bid: number; ask: number; time: number }>
      mt5History: (symbol?: string) => Promise<{ exits: Mt5Exit[] }>
      mt5PlaceOrder: (order: { symbol: string; direction: 'LONG'|'SHORT'; volume: number; stop: number; target: number }) => Promise<{ accepted: boolean; ticket?: number; price?: number; message?: string }>
      mt5ClosePosition: (ticket: number) => Promise<{ accepted: boolean; ticket?: number; price?: number; message?: string }>
      mt5UpdatePositionStop: (ticket: number, stop: number) => Promise<{ accepted: boolean; ticket?: number; stop?: number; target?: number; message?: string }>
      windowControls: { minimize: () => void; toggleMaximize: () => void; close: () => void; showMain: () => void; quit: () => void }
      ping: () => Promise<{ status: string; type: string }>
      getHistory: (limit?: number) => Promise<EngineHistory>
      runBacktest: (payload: BacktestRequest) => Promise<BacktestResult>
      updateSignal: (signal: unknown, notify?: boolean) => void
      updateMarket: (market: { symbol: string; bid: number; ask: number; time: number }) => void
      setLanView: (enabled: boolean) => Promise<{ enabled: boolean; urls?: string[]; error?: string }>
      toggleAlwaysOnTop: () => void
      openMiniWindow: () => void
      onEngineEvent: (callback: (event: EngineStatus) => void) => () => void
    }
  }
}

export type Mt5Position = { ticket: number; symbol: string; direction: 'LONG'|'SHORT'; volume: number; entry: number; stop: number; target: number; price: number; profit: number; openedAt: number; comment: string }
export type Mt5Exit = { ticket: number; positionId: number; symbol: string; direction: 'LONG'|'SHORT'; volume: number; price: number; profit: number; time: number; reason: string }

export {}
