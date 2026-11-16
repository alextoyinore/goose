import type { Drawing } from '../drawings/schema'
import type { Candle } from './types'

export type EngineSignal = {
  id: string
  timestamp: number
  isoTime: string
  setup: string
  setupName: string
  session: string
  direction: 'LONG' | 'SHORT'
  entry: number
  stop: number
  target: number
  riskDollars: number
  positionSizeLots: number
  eligible: boolean
  blockReason: string | null
  rMultiple: number
  atr: number
  volumeRatio: number
  confidence: number
  rationale: string
  timeframeBiases?: Partial<Record<'M5'|'M15'|'H1'|'H4', 'BUY'|'SELL'|'NEUTRAL'>>
  timeframeStates?: Partial<Record<'M5'|'M15'|'H1'|'H4', string>>
  alignmentEligible?: boolean
  alignmentBlockReason?: string | null
  manualOverride?: boolean
  confidenceOverride?: boolean
  m5TriggerDirection?: 'BUY'|'SELL'
  drawings: Drawing[]
  taken: boolean
}

export type EngineAnalysis = { type: 'analysis'; status: string; candlesAnalyzed: number; riskBlockedCount?: number; signals: EngineSignal[] }
export type EngineStatus = { type: 'status'; status: string; engine?: string; version?: string; message?: string }
export type EngineTradeMarked = { type: 'trade_marked'; status: string; updated: boolean }
export type SetupFlags = { A: boolean; B: boolean; C: boolean }
export type AnalyzeCandles = { M5: Candle[]; M15: Candle[]; H1: Candle[]; H4: Candle[]; spread?: number }
export type HistoryRecord = EngineSignal & { status: 'ready'|'blocked'|'open'|'closed'; tradeId: number|null; openedAt: string|null; closedAt: string|null; exitPrice: number|null; realizedPnl: number|null; resultR: number|null; outcome: 'win'|'loss'|null; outcomeTime: number|null; outcomePrice: number|null; outcomeR: number|null }
export type HistoryWinRate = { wins: number; losses: number; settled: number; winRate: number }
export type EngineHistory = { records: HistoryRecord[]; counts: Record<string, number>; total: number; stats: { signals: HistoryWinRate; tracked: HistoryWinRate } }
export type BacktestRequest = { candlesByTimeframe?: { M5: Candle[]; M15: Candle[]; H1: Candle[]; H4: Candle[] }; historical?: { symbol: string; server?: string; startDate: string; endDate: string }; spread: number; session: 'All'|'Asia'|'London'|'New York'; excludeNews: boolean }
export type BacktestDataReport = { source: string; symbol: string; range: string; availableRange?: string; counts: Record<string, number>; gaps: Record<string, number>; sessions: Record<string, number>; spreadSamples: number; cachedBars?: number }
export type BacktestPeriodResult = { trades: number; settled: number; winRate: number; expectancyR: number; netPnl: number; maxDrawdown: number }
export type BacktestResult = { trades: number; wins: number; losses: number; openTrades: number; winRate: number; averageR: number; expectancyR: number; netPnl: number; maxDrawdown: number; bySetup: { setup: string; trades: number; wins: number; losses: number; openTrades: number; winRate: number; averageR: number; netPnl: number }[]; skipped: Record<string, number>; spread: number; spreadStats: { samples: number; historicalSamples: number; fallbackSamples: number; average: number; median: number; maximum: number }; spreadSource: string; session: string; newsFiltered: boolean; assumptions: string[]; dataReport?: BacktestDataReport | null; outOfSample?: { splitDate: string; training: BacktestPeriodResult; holdout: BacktestPeriodResult } | null; error?: string }
export type RiskSettings = { startCapital: number; riskPercent: number; spreadLimit: number; contractSizeOz: number; positionTrackingEnabled: boolean; lanViewEnabled: boolean; maxSignalsPerDay: number; maxOpenPositions: number; maxConsecutiveLosses: number; newsEvents: { time: string; label: string; blackoutMinutes?: number }[]; enabledSetups: SetupFlags }
export type AccountState = { settings: RiskSettings; equity: number; realizedPnl: number; consecutiveLosses: number; openTrades: { id: number; signalId: string; direction: 'LONG'|'SHORT'; entry: number; stop: number; target: number; riskDollars: number; openedAt: string }[] }
