import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Camera, ChevronDown, CircleHelp, Download, Eye, Settings2, ShieldCheck, Sparkles, Sun, Moon, Target, Wifi, Zap, Minus, Square, X, Maximize, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
import Chart, { type ChartAction } from './Chart'
import Mt5Orders from './Mt5Orders'
import { MockXauusdSource } from '../data/mockXauusd'
import type { Candle, Timeframe } from '../data/types'
import { getMockSignal, setupBDrawings, type Drawing } from '../drawings/schema'
import { calculateAtr } from '../data/indicators'
import type { EngineSignal, HistoryRecord, BacktestResult } from '../data/engine'
import type { AccountState, RiskSettings } from '../data/engine'
import type { Mt5Exit, Mt5Position } from '../global'

const frames: Timeframe[] = ['M5', 'M15', 'H1', 'H4']
const source = new MockXauusdSource()
const utcDateInput = (date: Date) => date.toISOString().slice(0, 10)
const formatFinite = (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
type TimeframeInsight = { bias: 'BUY'|'SELL'|'NEUTRAL'; state: string; rsi: number|null; detail: string }
type SnapshotTask = { record: HistoryRecord; candles: Candle[]; nonce: number }
const sessionClock = (now: Date) => {
  const sessions = [
    { name: 'Sydney', zone: 'Australia/Sydney', start: 8, end: 17 },
    { name: 'Tokyo', zone: 'Asia/Tokyo', start: 9, end: 18 },
    { name: 'London', zone: 'Europe/London', start: 8, end: 17 },
    { name: 'New York', zone: 'America/New_York', start: 8, end: 17 },
  ]
  const active = sessions.filter(session => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: session.zone, hour: '2-digit', hourCycle: 'h23' }).format(now))
    return hour >= session.start && hour < session.end
  }).map(session => session.name)
  const overlaps = [['Sydney', 'Tokyo'], ['London', 'New York']].filter(pair => pair.every(name => active.includes(name)))
  return { active, overlaps }
}
const assessTimeframe = (input: Candle[], frame: Timeframe): TimeframeInsight => {
  const seconds = ({ M5: 300, M15: 900, H1: 3600, H4: 14400 } as const)[frame]
  const period = frame === 'H1' || frame === 'H4' ? 50 : 20
  const bars = input.filter(bar => bar.time + seconds <= Date.now() / 1000)
  if (bars.length < period + 5) return { bias: 'NEUTRAL', state: 'WAIT', rsi: null, detail: `Waiting for ${period + 5} completed candles` }
  const alpha = 2 / (period + 1), emaValues: number[] = [bars[0].close]
  for (const bar of bars.slice(1)) emaValues.push(bar.close * alpha + emaValues.at(-1)! * (1 - alpha))
  const ranges = bars.slice(-15).map((bar, index, recent) => {
    const previousClose = index ? recent[index - 1].close : bars[Math.max(0, bars.length - 16)].close
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
  })
  const atr = ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length)
  const changes = bars.slice(-15).slice(1).map((bar, index, recent) => bar.close - recent[index].close)
  const gains = changes.reduce((sum, value) => sum + Math.max(0, value), 0) / 14
  const losses = changes.reduce((sum, value) => sum + Math.max(0, -value), 0) / 14
  const rsi = losses === 0 ? gains === 0 ? 50 : 100 : 100 - 100 / (1 + gains / losses)
  const lastEma = emaValues.at(-1)!, priorEma = emaValues.at(-5)!
  const distance = atr ? (bars.at(-1)!.close - lastEma) / atr : 0
  const slope = atr ? (lastEma - priorEma) / atr : 0
  const bias = distance > 0.1 ? 'BUY' : distance < -0.1 ? 'SELL' : slope > 0.08 ? 'BUY' : slope < -0.08 ? 'SELL' : 'NEUTRAL'
  const slopeBias = slope > 0.08 ? 'BUY' : slope < -0.08 ? 'SELL' : 'NEUTRAL'
  const state = bias === 'NEUTRAL' ? 'NEUTRAL' : Math.abs(distance) < 0.18 && slopeBias === bias ? `TURNING ${bias}` : Math.abs(distance) < 0.3 || slopeBias !== bias ? `LEAN ${bias}` : Math.abs(distance) >= 0.8 ? `STRONG ${bias}` : bias
  const momentum = rsi >= 70 ? ' · overbought' : rsi <= 30 ? ' · oversold' : ''
  const relation = distance > 0 ? `above EMA ${period}` : distance < 0 ? `below EMA ${period}` : `near EMA ${period}`
  const slopeText = slope > 0.08 ? 'EMA rising' : slope < -0.08 ? 'EMA falling' : 'EMA flat'
  return { bias, state, rsi, detail: `${relation}; ${slopeText}; RSI ${rsi.toFixed(0)}${momentum}` }
}
function App() {
  const [clockNow, setClockNow] = useState(() => new Date())
  useEffect(() => { const timer = window.setInterval(() => setClockNow(new Date()), 1000); return () => window.clearInterval(timer) }, [])
  const [timeframe, setTimeframe] = useState<Timeframe>('M15')
  const timeframeRef = useRef(timeframe)
  timeframeRef.current = timeframe
  const [candles, setCandles] = useState<any[]>([])
  const [chartOlderCandles, setChartOlderCandles] = useState<Candle[]>([])
  const [chartOlderLoading, setChartOlderLoading] = useState(false)
  const [chartHasOlder, setChartHasOlder] = useState(true)
  const [tab, setTab] = useState('Chart')
  const [showDrawings, setShowDrawings] = useState(true)
  const [showRiskReward, setShowRiskReward] = useState(() => localStorage.getItem('aurum-show-risk-reward') !== 'false')
  const [taken, setTaken] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('aurum-theme') === 'light' ? 'light' : 'dark')
  const [appZoom, setAppZoom] = useState(() => { const saved = Number(localStorage.getItem('aurum-app-zoom') ?? 1); return Number.isFinite(saved) ? Math.min(1.25, Math.max(0.8, saved)) : 1 })
  useEffect(() => { window.aurum?.setUiZoom(appZoom) }, [])
  const [engineStatus, setEngineStatus] = useState('starting')
  const [engineSignals, setEngineSignals] = useState<EngineSignal[]>([])
  const [activeSignalId, setActiveSignalId] = useState<string | null>(null)
  const [levelOverride, setLevelOverride] = useState<{ signalId: string; entry: number; stop: number; target: number } | null>(null)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<RiskSettings | null>(null)
  const [settingsPosition, setSettingsPosition] = useState<{ left: number; top: number } | null>(null)
  const settingsDrag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null)
  const [exitPrices, setExitPrices] = useState<Record<number, string>>({})
  const [trackingEntry, setTrackingEntry] = useState('')
  const adjustAppZoom = (delta: number) => setAppZoom(current => {
    const next = Math.min(1.25, Math.max(0.8, Math.round((current + delta) * 100) / 100))
    localStorage.setItem('aurum-app-zoom', String(next))
    window.aurum?.setUiZoom(next)
    return next
  })
  const startSettingsDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button,input,textarea,select')) return
    const dialog = event.currentTarget.parentElement
    if (!dialog) return
    const rect = dialog.getBoundingClientRect()
    settingsDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top }
    setSettingsPosition({ left: rect.left, top: rect.top })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveSettingsDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = settingsDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 560
    setSettingsPosition({ left: Math.max(0, Math.min(window.innerWidth-width, drag.left+event.clientX-drag.startX)), top: Math.max(0, Math.min(window.innerHeight-70, drag.top+event.clientY-drag.startY)) })
  }
  const endSettingsDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (settingsDrag.current?.pointerId === event.pointerId) settingsDrag.current = null
  }
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [chartAction, setChartAction] = useState<ChartAction>(null)
  const [chartFocusRequest, setChartFocusRequest] = useState<{ timestamp: number; nonce: number } | null>(null)
  const [mt5Status, setMt5Status] = useState<{ connected: boolean; error?: string; server?: string; accountMode?: string; tradeAllowed?: boolean; currency?: string; balance?: number; equity?: number; margin?: number; freeMargin?: number }>({ connected: false })
  const [mt5Positions, setMt5Positions] = useState<Mt5Position[]>([])
  const [mt5StopDrafts, setMt5StopDrafts] = useState<Record<number, string>>({})
  const [trackedStopDrafts, setTrackedStopDrafts] = useState<Record<number, string>>({})
  const [updatingStops, setUpdatingStops] = useState<Record<string, boolean>>({})
  const [mt5Exits, setMt5Exits] = useState<Mt5Exit[]>([])
  const [mt5Symbol, setMt5Symbol] = useState('XAUUSDm')
  const mt5SymbolRef = useRef(mt5Symbol)
  mt5SymbolRef.current = mt5Symbol
  const [orderDirection, setOrderDirection] = useState<'LONG'|'SHORT'>('LONG')
  const [orderVolume, setOrderVolume] = useState('0.01')
  const [orderStop, setOrderStop] = useState('')
  const [orderTarget, setOrderTarget] = useState('')
  const [mt5Busy, setMt5Busy] = useState(false)
  const [liveQuote, setLiveQuote] = useState<{ bid: number; ask: number; time: number } | null>(null)
  const [timeframeInsights, setTimeframeInsights] = useState<Record<Timeframe, TimeframeInsight>>({ M5: { bias: 'NEUTRAL', state: 'WAIT', rsi: null, detail: 'Waiting for completed candles' }, M15: { bias: 'NEUTRAL', state: 'WAIT', rsi: null, detail: 'Waiting for completed candles' }, H1: { bias: 'NEUTRAL', state: 'WAIT', rsi: null, detail: 'Waiting for completed candles' }, H4: { bias: 'NEUTRAL', state: 'WAIT', rsi: null, detail: 'Waiting for completed candles' } })
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([])
  const [historyStats, setHistoryStats] = useState<{ signals: { wins: number; losses: number; settled: number; winRate: number }; tracked: { wins: number; losses: number; settled: number; winRate: number } } | null>(null)
  const [historyFilter, setHistoryFilter] = useState('All')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [snapshotRecords, setSnapshotRecords] = useState<WinSnapshotMetadata[]>([])
  const [snapshotViewer, setSnapshotViewer] = useState<{ record: WinSnapshotMetadata; image: string } | null>(null)
  const [autoSnapshotTask, setAutoSnapshotTask] = useState<SnapshotTask | null>(null)
  const [manualSnapshotRequest, setManualSnapshotRequest] = useState<{ nonce: number } | null>(null)
  const [signalsPage, setSignalsPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)
  const pageSize = 10
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null)
  const [backtestBusy, setBacktestBusy] = useState(false)
  const [backtestSession, setBacktestSession] = useState<'All'|'Asia'|'London'|'New York'>('All')
  const [backtestExcludeNews, setBacktestExcludeNews] = useState(true)
  const [backtestSpread, setBacktestSpread] = useState('0.34')
  const [backtestFeed, setBacktestFeed] = useState<'Mock'|'MT5'>('Mock')
  const [backtestEndDate, setBacktestEndDate] = useState(() => utcDateInput(new Date()))
  const [backtestStartDate, setBacktestStartDate] = useState('2019-01-01')
  const [historyCacheBusy, setHistoryCacheBusy] = useState(false)
  const [historyCacheProgress, setHistoryCacheProgress] = useState('')
  const [backtestDataReport, setBacktestDataReport] = useState<{ source: string; symbol: string; spread: number; spreadLimit: number; quoteAge: number; counts: Record<string, number>; range: string; availableRange?: string; gaps: Record<string, number>; sessions: Record<string, number>; spreadSamples?: number; cachedBars?: number } | null>(null)
  const [lanStatus, setLanStatus] = useState<{ enabled: boolean; urls?: string[]; error?: string }>({ enabled: false })
  const [mt5AutoConnect, setMt5AutoConnect] = useState(false)
  const mt5PollBusy = useRef(false)
  const publishedSignalIds = useRef<Set<string> | null>(null)
  const snapshotKnownIds = useRef<Set<string>>(new Set())
  const snapshotQueue = useRef<HistoryRecord[]>([])
  const autoSnapshotTaskRef = useRef<SnapshotTask | null>(null)
  const snapshotScanBusy = useRef(false)
  const signalAudioContext = useRef<AudioContext | null>(null)
  const playSignalSound = () => {
    try {
      const context = signalAudioContext.current ?? new AudioContext()
      signalAudioContext.current = context
      const play = () => {
        if (context.state !== 'running') return
        const start = context.currentTime + 0.02
        ;[880, 1175].forEach((frequency, index) => {
          const oscillator = context.createOscillator(), gain = context.createGain(), at = start + index * 0.18
          oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, at)
          gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.16, at + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14)
          oscillator.connect(gain); gain.connect(context.destination); oscillator.start(at); oscillator.stop(at + 0.15)
        })
      }
      if (context.state === 'suspended') void context.resume().then(play).catch(() => {})
      else play()
    } catch { /* Audio is optional; the desktop notification remains available. */ }
  }
  useEffect(() => {
    const unlockAudio = () => {
      try {
        const context = signalAudioContext.current ?? new AudioContext()
        signalAudioContext.current = context
        if (context.state === 'suspended') void context.resume().catch(() => {})
      } catch { /* Web Audio may be unavailable on this system. */ }
    }
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    return () => { window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio) }
  }, [])
  const analyzeCurrent = async (useMt5 = mt5Status.connected) => {
    const getCandles = (frame: Timeframe, count: number) => useMt5
      ? window.aurum!.mt5Candles(mt5Symbol, frame, count).then(result => result.candles)
      : source.getCandles(frame, count)
    const [M5, M15, H1, H4, quote] = await Promise.all([
      getCandles('M5', 600), getCandles('M15', 600), getCandles('H1', 300), getCandles('H4', 300),
      useMt5 ? window.aurum!.mt5Quote(mt5Symbol) : source.getQuote(),
    ])
    window.aurum?.updateMarket({ symbol: mt5Symbol, bid: quote.bid, ask: quote.ask, time: (quote as { time?: number }).time ?? Date.now()/1000 })
    return window.aurum?.analyze({ M5, M15, H1, H4, spread: quote.ask - quote.bid })
  }
  const quote = useMemo(() => liveQuote ?? ({ bid: candles.at(-1)?.close ?? 2648.32, ask: (candles.at(-1)?.close ?? 2648.32) + .34 }), [liveQuote, candles])
  const engineSignal = engineSignals.find(item => item.id === activeSignalId) ?? engineSignals.at(-1)
  const overallBiasScore = timeframeInsights.H4.bias === 'BUY' ? 3 : timeframeInsights.H4.bias === 'SELL' ? -3 : 0; const weightedBias = overallBiasScore + (timeframeInsights.H1.bias === 'BUY' ? 2 : timeframeInsights.H1.bias === 'SELL' ? -2 : 0) + (timeframeInsights.M15.bias === 'BUY' ? 1 : timeframeInsights.M15.bias === 'SELL' ? -1 : 0); const overallBias = weightedBias >= 2 ? 'BUY' : weightedBias <= -2 ? 'SELL' : 'NEUTRAL'
  const tradeTaken = engineSignal?.taken ?? taken
  const activeSignalKey = engineSignal?.id ?? 'sample'
  const baseLevels = useMemo(() => { const fallback = getMockSignal(candles); return engineSignal ? { entry: Number.isFinite(engineSignal.entry) ? engineSignal.entry : fallback.entry, stop: Number.isFinite(engineSignal.stop) ? engineSignal.stop : fallback.stop, target: Number.isFinite(engineSignal.target) ? engineSignal.target : fallback.target } : fallback }, [engineSignal, candles])
  const signal = levelOverride?.signalId === activeSignalKey ? { entry: levelOverride.entry, stop: levelOverride.stop, target: levelOverride.target } : baseLevels
  const signalRMultiple = Math.abs(signal.target - signal.entry) / Math.max(0.0001, Math.abs(signal.entry - signal.stop))
  const entryAssessment = useMemo(() => {
    if (!engineSignal) return { canEnter: false, message: 'No active signal' }
    if (!mt5Status.connected || !liveQuote) return { canEnter: false, message: 'Connect MT5 for a live entry check' }
    if (Date.now()/1000 - liveQuote.time > 15) return { canEnter: false, message: 'Live quote is stale · waiting for MT5 update' }
    if (!engineSignal.eligible || !mt5Status.tradeAllowed) return { canEnter: false, message: !engineSignal.eligible ? `Entry blocked · ${engineSignal.blockReason ?? 'signal risk check'}` : 'MT5 account is read only' }
    const price = engineSignal.direction === 'LONG' ? liveQuote.ask : liveQuote.bid
    if (engineSignal.direction === 'LONG' ? price <= signal.stop || price >= signal.target : price >= signal.stop || price <= signal.target) return { canEnter: false, message: 'Entry closed · stop or target has already been crossed' }
    const rr = engineSignal.direction === 'LONG' ? (signal.target-price)/(price-signal.stop) : (price-signal.target)/(signal.stop-price)
    const floor = engineSignal.setup === 'C' ? account?.settings.setupCMinRR ?? 2 : 1
    return { canEnter: rr >= floor, price, rr, floor, message: rr >= floor ? `ENTRY STILL VALID · ${engineSignal.direction === 'LONG' ? 'BUY' : 'SELL'} at ${price.toFixed(2)} · remaining 1:${rr.toFixed(2)}` : `NO ENTRY · remaining 1:${rr.toFixed(2)} is below the ${floor}R minimum` }
  }, [engineSignal, liveQuote, mt5Status.connected, mt5Status.tradeAllowed, signal, account?.settings.setupCMinRR])
  const atr = useMemo(() => calculateAtr(candles), [candles])
  const displayCandles = useMemo(() => {
    const unique = new Map<number, Candle>()
    for (const bar of [...chartOlderCandles, ...candles] as Candle[]) unique.set(bar.time, bar)
    return [...unique.values()].sort((a, b) => a.time - b.time)
  }, [chartOlderCandles, candles])
  useEffect(() => { setChartOlderCandles([]); setChartHasOlder(true) }, [timeframe, mt5Symbol, mt5Status.connected])
  const loadHistory = async () => { setHistoryLoading(true); try { const result = await window.aurum?.getHistory(1000); if (result) { setHistoryRecords(result.records); setHistoryStats(result.stats) } } catch (error) { setEngineStatus(`history error: ${String(error)}`) } finally { setHistoryLoading(false) } }
  const scanWinningSnapshots = useCallback(async () => {
    if (snapshotScanBusy.current || autoSnapshotTaskRef.current) return
    snapshotScanBusy.current = true
    try {
      const saved = await window.aurum?.listWinningSnapshots() ?? []
      snapshotKnownIds.current = new Set(saved.map(item => item.signalId))
      setSnapshotRecords(saved)
      const history = await window.aurum?.getHistory(1000)
      const wins = history?.records.filter(record => record.outcome === 'win' || (record.status === 'closed' && (record.resultR ?? 0) > 0)) ?? []
      const cutoff = Date.now()/1000 - 4 * 86_400
      for (const record of wins) {
        const winTime = record.outcomeTime ?? (record.closedAt ? Date.parse(record.closedAt)/1000 : record.timestamp)
        if (winTime >= cutoff && !snapshotKnownIds.current.has(record.id) && !snapshotQueue.current.some(item => item.id === record.id)) snapshotQueue.current.push(record)
      }
      const record = snapshotQueue.current.shift()
      if (!record) return
      const response = mt5Status.connected ? await window.aurum?.mt5Candles(mt5Symbol, 'M5', 1000) : null
      const sourceCandles = response?.candles ?? await source.getCandles('M5', 1000)
      const winTime = record.outcomeTime ?? (record.closedAt ? Date.parse(record.closedAt)/1000 : record.timestamp)
      const candles = sourceCandles.filter(bar => bar.time <= winTime)
      const task = { record, candles: candles.length > 40 ? candles : sourceCandles, nonce: Date.now() + Math.floor(Math.random()*1000) }
      autoSnapshotTaskRef.current = task
      setAutoSnapshotTask(task)
    } catch (error) { console.warn('Winning chart snapshot scan failed', error) }
    finally { snapshotScanBusy.current = false }
  }, [mt5Status.connected, mt5Symbol])
  const finishAutoSnapshot = useCallback(async (dataUrl: string) => {
    const task = autoSnapshotTaskRef.current
    if (!task) return
    const record = task.record
    const winTime = record.outcomeTime ?? (record.closedAt ? Date.parse(record.closedAt)/1000 : record.timestamp)
    try {
      const saved = await window.aurum?.saveWinningSnapshot({ signalId: record.id, setupName: record.setupName, direction: record.direction, timestamp: record.timestamp, outcome: record.outcome === 'win' ? 'SIGNAL TARGET HIT' : 'TRACKED TRADE PROFIT', outcomeTime: Number.isFinite(winTime) ? winTime : null, outcomePrice: record.outcomePrice ?? record.exitPrice, outcomeR: record.outcomeR ?? record.resultR, entry: record.entry, stop: record.stop, target: record.target, taken: record.taken, resultR: record.resultR }, dataUrl)
      if (saved) { snapshotKnownIds.current.add(saved.signalId); setSnapshotRecords(items => [saved, ...items.filter(item => item.signalId !== saved.signalId)]) }
    } catch (error) { console.warn('Could not save winning chart snapshot', error) }
    autoSnapshotTaskRef.current = null
    setAutoSnapshotTask(null)
    void scanWinningSnapshots()
  }, [scanWinningSnapshots])
  const captureManualSnapshot = useCallback((dataUrl: string) => {
    const link = document.createElement('a')
    link.href = dataUrl; link.download = `Aurum-chart-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    link.click(); setManualSnapshotRequest(null); setEngineStatus('Chart snapshot downloaded')
  }, [])
  const reviewSnapshot = async (record: WinSnapshotMetadata) => {
    try { const image = await window.aurum?.readWinningSnapshot(record.id); if (image) setSnapshotViewer({ record, image }) }
    catch (error) { setEngineStatus(`snapshot error: ${error instanceof Error ? error.message : String(error)}`) }
  }
  useEffect(() => { void scanWinningSnapshots(); const timer = window.setInterval(() => void scanWinningSnapshots(), 60_000); return () => window.clearInterval(timer) }, [scanWinningSnapshots])
  const openSignalInChart = async (item: EngineSignal) => {
    setActiveSignalId(item.id)
    setTab('Chart')
    const selectedTimeframe = timeframe, selectedSymbol = mt5Symbol
    setChartFocusRequest({ timestamp: item.timestamp, nonce: Date.now() })
    if (!mt5Status.connected || !candles.length || item.timestamp >= candles[0].time) return
    setChartOlderLoading(true)
    try {
      let older = chartOlderCandles.slice()
      let known = new Set([...older, ...candles].map(bar => bar.time))
      let startPos = candles.length + older.length
      for (let page = 0; page < 100 && item.timestamp < (older[0]?.time ?? candles[0].time); page++) {
        if (timeframeRef.current !== selectedTimeframe || mt5SymbolRef.current !== selectedSymbol) break
        const result = await window.aurum?.mt5Candles(selectedSymbol, selectedTimeframe, 1000, startPos)
        if (!result?.candles.length) break
        const unseen = result.candles.filter(bar => !known.has(bar.time))
        for (const bar of unseen) known.add(bar.time)
        older = [...unseen, ...older].sort((a, b) => a.time - b.time)
        setChartOlderCandles(older)
        startPos += result.candles.length
        if (result.candles.length < 1000 || !unseen.length) break
      }
    } catch (error) { setEngineStatus(`signal chart history error: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setChartOlderLoading(false) }
  }
  const loadOlderCandles = async () => {
    if (!mt5Status.connected || chartOlderLoading || !chartHasOlder) return
    const selectedTimeframe = timeframe, selectedSymbol = mt5Symbol
    const startPos = candles.length + chartOlderCandles.length
    setChartOlderLoading(true)
    try {
      const result = await window.aurum?.mt5Candles(selectedSymbol, selectedTimeframe, 1000, startPos)
      if (result && timeframeRef.current === selectedTimeframe && mt5SymbolRef.current === selectedSymbol) {
        const known = new Set([...chartOlderCandles, ...candles].map(bar => bar.time))
        const earlier = result.candles.filter(bar => !known.has(bar.time))
        setChartOlderCandles(current => [...earlier, ...current].sort((a, b) => a.time - b.time))
        setChartHasOlder(result.candles.length === 1000)
      }
    } catch (error) { setEngineStatus(`older chart history error: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setChartOlderLoading(false) }
  }
  const cacheHistoryFrom2019 = async () => {
    if (!mt5Status.connected || historyCacheBusy) return
    const symbol = mt5Symbol, server = mt5Status.server, endDate = utcDateInput(new Date())
    const results: string[] = []
    setHistoryCacheBusy(true); setHistoryCacheProgress('Preparing broker history…')
    try {
      for (const [index, frame] of frames.entries()) {
        setHistoryCacheProgress(`Caching ${frame} · ${index + 1} of ${frames.length}…`)
        const result = await window.aurum?.cacheMt5History({ symbol, timeframe: frame, startDate: '2019-01-01', endDate, server })
        if (!result) throw new Error(`No ${frame} history response`)
        results.push(`${frame}: ${result.bars.toLocaleString()} bars · ${result.newBars.toLocaleString()} new · ${result.availableStart ?? 'none'} to ${result.availableEnd ?? 'none'}`)
      }
      setHistoryCacheProgress(`${symbol} history cached · ${results.join(' · ')}`)
    } catch (error) {
      setHistoryCacheProgress(`History cache stopped · ${error instanceof Error ? error.message : String(error)}`)
    } finally { setHistoryCacheBusy(false) }
  }
  const runHistoricalBacktest = async () => {
    setBacktestBusy(true); setBacktestResult(null); setBacktestDataReport(null)
    try {
      if (backtestFeed === 'MT5') {
        if (!mt5Status.connected) throw new Error('Connect MT5 before selecting broker history.')
        if (!backtestStartDate || !backtestEndDate || backtestStartDate > backtestEndDate) throw new Error('Choose a valid UTC start and end date.')
        const result = await window.aurum?.runBacktest({ historical: { symbol: mt5Symbol, server: mt5Status.server, startDate: backtestStartDate, endDate: backtestEndDate }, spread: Number(backtestSpread), session: backtestSession, excludeNews: backtestExcludeNews })
        if (result) {
          setBacktestResult(result)
          if (result.dataReport) setBacktestDataReport({ ...result.dataReport, spread: Number(backtestSpread), spreadLimit: account?.settings.spreadLimit ?? 0.4, quoteAge: 0 })
        }
        return
      }
      const [M5, M15, H1, H4] = await Promise.all([source.getCandles('M5', 1200), source.getCandles('M15', 400), source.getCandles('H1', 100), source.getCandles('H4', 100)])
      const spread = Number(backtestSpread), symbol = 'XAUUSD · mock', quoteTime = M5.at(-1)?.time ?? 0
      const byFrame = { M5, M15, H1, H4 }, seconds = { M5: 300, M15: 900, H1: 3600, H4: 14400 }
      const counts = Object.fromEntries(Object.entries(byFrame).map(([frame, bars]) => [frame, bars.length]))
      const gaps = Object.fromEntries(Object.entries(byFrame).map(([frame, bars]) => [frame, bars.slice(1).filter((bar, i) => bar.time - bars[i].time > seconds[frame as keyof typeof seconds] * 1.5).length]))
      const sessions = { Asia: 0, London: 0, newYork: 0, offHours: 0 }
      for (const bar of M5) { const hour = new Date(bar.time * 1000).getUTCHours(); sessions[hour < 7 ? 'Asia' : hour < 13 ? 'London' : hour < 20 ? 'newYork' : 'offHours']++ }
      const allTimes = [...M5, ...M15, ...H1, ...H4].map(bar => bar.time)
      const range = allTimes.length ? `${new Date(Math.min(...allTimes)*1000).toISOString().slice(0,16).replace('T',' ')} – ${new Date(Math.max(...allTimes)*1000).toISOString().slice(0,16).replace('T',' ')} UTC` : 'No bars received'
      setBacktestDataReport({ source: backtestFeed, symbol, spread, spreadLimit: account?.settings.spreadLimit ?? 0.4, quoteAge: quoteTime ? Math.round(Date.now()/1000-quoteTime) : 0, counts, gaps, range, sessions })
      const result = await window.aurum?.runBacktest({ candlesByTimeframe: byFrame, spread, session: backtestSession, excludeNews: backtestExcludeNews })
      if (result) setBacktestResult(result)
    } catch (error) { setBacktestResult({ error: error instanceof Error ? error.message : String(error) } as BacktestResult); setEngineStatus(`backtest error: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setBacktestBusy(false) }
  }
  useEffect(() => {
    if (tab === 'History') void loadHistory()
  }, [tab])
  useEffect(() => {
    const latest = engineSignals.at(-1)
    if (!latest) { publishedSignalIds.current ??= new Set(); return }
    const previous = publishedSignalIds.current
    const newlyDetected = previous ? engineSignals.filter(item => !previous.has(item.id) && item.eligible) : []
    if (newlyDetected.length) newlyDetected.forEach(() => playSignalSound())
    const shouldNotify = newlyDetected.some(item => item.id === latest.id)
    window.aurum?.updateSignal(latest, shouldNotify)
    publishedSignalIds.current = new Set(engineSignals.map(item => item.id))
  }, [engineSignals])
  useEffect(() => {
    let cancelled = false
    const update = async () => {
      try {
        const values = await Promise.all(frames.map(async frame => {
          const bars = mt5Status.connected ? (await window.aurum!.mt5Candles(mt5Symbol, frame, 120)).candles : await source.getCandles(frame, 120)
          return [frame, assessTimeframe(bars, frame)] as const
        }))
        if (!cancelled) setTimeframeInsights(Object.fromEntries(values) as Record<Timeframe,TimeframeInsight>)
      } catch { /* Keep prior bias until feed recovers. */ }
    }
    void update(); const timer = setInterval(update, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [mt5Status.connected, mt5Symbol])
  useEffect(() => {
    let cancelled = false
    const loadCandles = mt5Status.connected ? window.aurum?.mt5Candles(mt5Symbol, timeframe, 220).then(result => result.candles) : source.getCandles(timeframe, 220)
    loadCandles?.then(bars => { if (!cancelled) setCandles(bars) }).catch(error => { if (!cancelled) setEngineStatus(`feed error: ${error instanceof Error ? error.message : String(error)}`) })
    analyzeCurrent().then(result => {
      if (!cancelled && result) { setEngineSignals(result.signals); setEngineStatus(result.status); setAccount(result) }
    }).catch(error => { if (!cancelled) setEngineStatus(`error: ${error instanceof Error ? error.message : String(error)}`) })
    return () => { cancelled = true }
  }, [timeframe, mt5Status.connected, mt5Symbol])
  useEffect(() => {
    let cancelled = false
    const analyze = async () => {
      if (mt5PollBusy.current) return
      try {
        const result = await analyzeCurrent()
        if (!cancelled && result) { setEngineSignals(result.signals); setEngineStatus(result.status); setAccount(result) }
      } catch (error) { if (!cancelled) setEngineStatus(`signal refresh error: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const timer = setInterval(analyze, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [mt5Status.connected, mt5Symbol])
  useEffect(() => {
    window.aurum?.getState().then(state => { setAccount(state); void window.aurum?.setLanView(state.settings.lanViewEnabled).then(setLanStatus) }).catch(() => {})
    return window.aurum?.onEngineEvent(event => {
      if (event.type === 'status') setEngineStatus(event.status)
      if ((event as any).type === 'lan-status') setLanStatus(event as any)
      if ((event as any).type === 'menu') {
        const command = (event as any).command
        if (command === 'settings') { window.aurum?.getState().then(state => { setAccount(state); setSettingsDraft(state.settings); setSettingsOpen(true) }) }
        if (command === 'theme') setTheme(value => value === 'dark' ? 'light' : 'dark')
        if (command === 'refresh') analyzeCurrent().then(result => { if (result) { setEngineSignals(result.signals); setAccount(result) } })
        if (command === 'mark-latest' && engineSignals.at(-1)) void markTradeTaken()
        if (command === 'about') setAboutOpen(true)
      }
    })
  }, [engineSignals, taken])
  useEffect(() => { setLevelOverride(null) }, [activeSignalKey])
  const updateSignalLevels = (levels: { entry: number; stop: number; target: number }) => setLevelOverride({ signalId: activeSignalKey, ...levels })
  const drawingPayload = useMemo(() => {
    const sourceDrawings = engineSignal?.drawings ?? setupBDrawings(candles)
    const analysisDrawings = showDrawings ? sourceDrawings.filter(d => d.kind !== 'riskReward') : []
    if (!showRiskReward || !engineSignal) return analysisDrawings
    const rrDrawing = sourceDrawings.find(d => d.kind === 'riskReward')
    return [...analysisDrawings, rrDrawing?.kind === 'riskReward'
      ? { ...rrDrawing, entry: signal.entry, stop: signal.stop, target: signal.target, rMultiple: signalRMultiple }
      : { kind: 'riskReward' as const, id: `rr-${engineSignal.id}`, label: 'RISK / REWARD', time: engineSignal.timestamp, entry: signal.entry, stop: signal.stop, target: signal.target, direction: engineSignal.direction, rMultiple: signalRMultiple }]
  }, [showDrawings, showRiskReward, candles, engineSignal, signal, signalRMultiple])
  const snapshotSignal = autoSnapshotTask?.record
  const snapshotWinTime = snapshotSignal ? snapshotSignal.outcomeTime ?? (snapshotSignal.closedAt ? Date.parse(snapshotSignal.closedAt)/1000 : snapshotSignal.timestamp) : 0
  const snapshotLevels = snapshotSignal ? { entry: snapshotSignal.entry, stop: snapshotSignal.stop, target: snapshotSignal.target } : { entry: 1, stop: 0.99, target: 1.02 }
  const snapshotDrawings = useMemo<Drawing[]>(() => {
    if (!snapshotSignal) return []
    return [
      ...snapshotSignal.drawings.filter(drawing => drawing.kind !== 'riskReward'),
      { kind: 'riskReward', id: `rr-${snapshotSignal.id}`, label: 'RISK / REWARD', time: snapshotSignal.timestamp, entry: snapshotSignal.entry, stop: snapshotSignal.stop, target: snapshotSignal.target, direction: snapshotSignal.direction, rMultiple: snapshotSignal.rMultiple },
    ]
  }, [snapshotSignal])
  const setupsToday = engineSignals.filter(item => Math.floor(item.timestamp / 86_400) === Math.floor(Date.now() / 86_400_000)).length
  const markTradeTaken = async (manualOverride = false) => {
    if (!engineSignal) { setTaken(!taken); return }
    if (manualOverride && !window.confirm(`Override this app block and track the position?\n\n${engineSignal.blockReason ?? engineSignal.alignmentBlockReason ?? 'Risk or timeframe control'}\n\nThis records a manual override locally; it does not place an MT5 order.`)) return
    try {
      const actualEntry = trackingEntry.trim() ? Number(trackingEntry) : undefined
      const result = await window.aurum?.markTaken(engineSignal.id, actualEntry, manualOverride)
      if (result?.updated) { setEngineSignals(items => items.map(item => item.id === engineSignal.id ? { ...item, taken: true, manualOverride } : item)); if (result.account) setAccount(result.account); setTrackingEntry('') }
      else if (result?.error) setEngineStatus(result.error)
    } catch (error) { setEngineStatus(`error: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const closeTrackedTrade = async (tradeId: number) => {
    const exit = Number(exitPrices[tradeId])
    if (!Number.isFinite(exit) || exit <= 0) return
    try {
      const result = await window.aurum?.closeTrade(tradeId, exit)
      if (result?.error) setEngineStatus(result.error)
      else if (result?.account) { setAccount(result.account); setEngineStatus(`position closed · ${result.realizedPnl?.toFixed(2) ?? '0.00'} USD`) }
      setExitPrices(values => ({ ...values, [tradeId]: '' }))
    } catch (error) { setEngineStatus(String(error)) }
  }
  const updateTrackedStop = async (tradeId: number, currentStop: number) => {
    const stop = trackedStopDrafts[tradeId]?.trim() ? Number(trackedStopDrafts[tradeId]) : currentStop
    if (!Number.isFinite(stop) || stop <= 0) { setEngineStatus('Enter a valid stop loss'); return }
    setUpdatingStops(values => ({ ...values, [`tracked-${tradeId}`]: true }))
    try {
      const result = await window.aurum?.updateTrackedStop(tradeId, stop)
      if (result?.error) setEngineStatus(result.error)
      else if (result?.account) { setAccount(result.account); setTrackedStopDrafts(values => ({ ...values, [tradeId]: '' })); setEngineStatus('Local tracked stop loss updated') }
    } catch (error) { setEngineStatus(String(error)) }
    finally { setUpdatingStops(values => ({ ...values, [`tracked-${tradeId}`]: false })) }
  }
  const forgetTrackedTrade = async (tradeId: number) => {
    if (!window.confirm('Remove this local tracking record and release its open-position slot? This does not close or change an MT5 position.')) return
    try {
      const result = await window.aurum?.forgetTrackedTrade(tradeId)
      if (result?.error) setEngineStatus(result.error)
      else if (result?.account) { setAccount(result.account); if (result.signalId) setEngineSignals(items => items.map(item => item.id === result.signalId ? { ...item, taken: false } : item)); setEngineStatus('Local tracker removed') }
    } catch (error) { setEngineStatus(String(error)) }
  }
  const updateMt5Stop = async (position: Mt5Position) => {
    const stop = mt5StopDrafts[position.ticket]?.trim() ? Number(mt5StopDrafts[position.ticket]) : position.stop
    if (!Number.isFinite(stop) || stop <= 0) { setEngineStatus('Enter a valid broker stop loss'); return }
    setUpdatingStops(values => ({ ...values, [`mt5-${position.ticket}`]: true }))
    try {
      const result = await window.aurum?.mt5UpdatePositionStop(position.ticket, stop)
      if (result?.accepted) {
        setMt5Positions(items => items.map(item => item.ticket === position.ticket ? { ...item, stop: result.stop ?? stop } : item))
        setMt5StopDrafts(values => ({ ...values, [position.ticket]: '' }))
        setEngineStatus(`MT5 stop loss updated · ${formatFinite(result.stop ?? stop)}`)
      } else if (result?.message) setEngineStatus(result.message)
    } catch (error) { setEngineStatus(error instanceof Error ? error.message : String(error)) }
    finally { setUpdatingStops(values => ({ ...values, [`mt5-${position.ticket}`]: false })) }
  }
  const refreshMt5 = async () => {
    if (mt5PollBusy.current) return
    mt5PollBusy.current = true
    const requestedTimeframe = timeframeRef.current
    const requestedSymbol = mt5SymbolRef.current
    try {
      const status = await window.aurum?.mt5Connect()
      if (!status) return
      setMt5Status(status)
      if (!status.connected) { setMt5Positions([]); setLiveQuote(null); return }
      setMt5AutoConnect(false)
      const [result, history, chartData, marketQuote] = await Promise.all([
        window.aurum?.mt5Positions(mt5Symbol), window.aurum?.mt5History(mt5Symbol),
        window.aurum?.mt5Candles(requestedSymbol, requestedTimeframe, 220), window.aurum?.mt5Quote(mt5Symbol),
      ])
      if (result) setMt5Positions(result.positions)
      if (history) setMt5Exits(history.exits)
      // A poll can outlive a timeframe switch. Ignore its chart payload if it
      // belongs to the previously selected timeframe.
      if (chartData && timeframeRef.current === requestedTimeframe && mt5SymbolRef.current === requestedSymbol) setCandles(chartData.candles)
      if (marketQuote) setLiveQuote({ bid: marketQuote.bid, ask: marketQuote.ask, time: marketQuote.time ?? Date.now()/1000 })
      if (marketQuote) window.aurum?.updateMarket({ symbol: mt5Symbol, bid: marketQuote.bid, ask: marketQuote.ask, time: marketQuote.time })
      if (!mt5Status.connected) {
        const analysis = await analyzeCurrent(true)
        if (analysis) { setEngineSignals(analysis.signals); setAccount(analysis) }
      }
    } finally { mt5PollBusy.current = false }
  }
  const beginMt5Connect = async () => {
    setMt5AutoConnect(true)
    setMt5Status({ connected: false, error: 'Checking the existing MT5 terminal and account…' })
    try {
      const terminal = await window.aurum?.mt5StartTerminal()
      if (terminal?.error) { setMt5AutoConnect(false); setMt5Status({ connected: false, error: terminal.error }); return }
      const status = await window.aurum?.mt5Connect()
      setMt5AutoConnect(false)
      if (status?.connected) { setMt5Status(status); await refreshMt5() }
      else setMt5Status({ connected: false, error: `MT5 is open. Sign in or select the logged-in account there, then press CONNECT MT5 again. ${status?.error ?? ''}`.trim() })
    } catch (error) {
      setMt5AutoConnect(false)
      setMt5Status({ connected: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const submitMt5Order = async (quickEntry = false) => {
    const direction = quickEntry ? engineSignal!.direction : orderDirection
    const stop = quickEntry ? signal.stop : Number(orderStop), target = quickEntry ? signal.target : Number(orderTarget)
    const volume = quickEntry && entryAssessment.canEnter && entryAssessment.price ? Math.floor((((mt5Status.equity ?? account?.equity ?? account?.settings.startCapital ?? 0) * (account?.settings.riskPercent ?? 1)/100) / (Math.abs(entryAssessment.price-signal.stop) * (account?.settings.contractSizeOz ?? 100))) * 100)/100 : Number(orderVolume)
    if (!mt5Status.connected) { setEngineStatus('Connect to MT5 first'); return }
    if (!(volume > 0 && stop > 0 && target > 0)) { setEngineStatus('Enter volume, stop loss, and take profit'); return }
    const side = direction === 'LONG' ? 'BUY' : 'SELL'
    const minimumRR = quickEntry ? entryAssessment.floor : undefined
    const approved = window.confirm(`Send ${side} market order to MT5 ${mt5Status.accountMode === 'REAL' ? 'REAL' : mt5Status.accountMode ?? ''} account?\n\nServer: ${mt5Status.server ?? 'connected terminal'}\nSymbol: ${mt5Symbol}\nVolume: ${volume} lots\nStop loss: ${stop}\nTake profit: ${target}${quickEntry ? `\nLive remaining R:R: 1:${entryAssessment.rr?.toFixed(2)} (minimum 1:${minimumRR})` : ''}\n\nThe price may move before execution. MT5 will manage the attached SL/TP if Aurum closes.`)
    if (!approved) return
    setMt5Busy(true)
    try {
      const result = await window.aurum?.mt5PlaceOrder({ symbol: mt5Symbol, direction, volume, stop, target, minimumRR })
      if (result?.accepted) { setEngineStatus(`MT5 ${side} opened · ${result.price?.toFixed(2) ?? ''}`); await refreshMt5() }
      else setEngineStatus(result?.message ?? 'MT5 did not accept the order')
    } catch (error) { setEngineStatus(error instanceof Error ? error.message : String(error)) }
    finally { setMt5Busy(false) }
  }
  const closeMt5Position = async (position: Mt5Position) => {
    if (!window.confirm(`Close the full MT5 position?\n\n${position.direction === 'LONG' ? 'BUY' : 'SELL'} ${position.symbol}\n${position.volume} lots\nTicket ${position.ticket}`)) return
    setMt5Busy(true)
    try {
      const result = await window.aurum?.mt5ClosePosition(position.ticket)
      if (result?.accepted) { setEngineStatus(`MT5 position closed · ${result.price?.toFixed(2) ?? ''}`); await refreshMt5() }
      else setEngineStatus(result?.message ?? 'MT5 did not close the position')
    } catch (error) { setEngineStatus(error instanceof Error ? error.message : String(error)) }
    finally { setMt5Busy(false) }
  }
  const useSignalLevels = () => {
    setOrderDirection(engineSignal?.direction ?? 'LONG')
    setOrderStop((engineSignal?.stop ?? signal.stop).toFixed(2))
    setOrderTarget((engineSignal?.target ?? signal.target).toFixed(2))
  }
  useEffect(() => {
    setOrderDirection(engineSignal?.direction ?? 'LONG')
    setOrderStop(formatFinite(signal.stop))
    setOrderTarget(formatFinite(signal.target))
  }, [activeSignalKey, engineSignal?.direction, signal.stop, signal.target])
  useEffect(() => {
    if (!chartAction) return
    const timer = window.setTimeout(() => setChartAction(null), 100)
    return () => window.clearTimeout(timer)
  }, [chartAction])
  useEffect(() => {
    if (!mt5Status.connected) return
    const timer = setInterval(() => { void refreshMt5().catch(error => setMt5Status({ connected: false, error: String(error) })) }, 5000)
    return () => clearInterval(timer)
  }, [mt5Symbol, mt5Status.connected, mt5AutoConnect])
  const runMenuCommand = (command: string) => {
    setOpenMenu(null)
    if (command === 'settings') { if (account) { setSettingsDraft(account.settings); setSettingsOpen(true) } }
    if (command === 'theme') setTheme(value => value === 'dark' ? 'light' : 'dark')
    if (command === 'always-on-top') window.aurum?.toggleAlwaysOnTop()
    if (command === 'mini-window') window.aurum?.openMiniWindow()
    if (command === 'refresh') analyzeCurrent().then(result => { if (result) { setEngineSignals(result.signals); setAccount(result) } }).catch(error => setEngineStatus(String(error)))
    if (command === 'mark-latest' && engineSignal) void markTradeTaken()
    if (command === 'about') setAboutOpen(true)
    if (command === 'quit') window.aurum?.windowControls.quit()
  }
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('aurum-theme', theme) }, [theme])
  return <div className={`app-shell theme-${theme}`}>
    <div className="custom-titlebar"><div className="custom-app-title"><div className="brand-mark">A</div><strong>AURUM</strong><span>Gold Signal Desk</span></div><nav className="custom-menubar" aria-label="Application menu">{[['Aurum',[['About Aurum','about'],['Settings…','settings'],['Quit','quit']]],['File',[['Refresh market data','refresh'],['Settings…','settings']]],['View',[['Toggle light / dark theme','theme'],['Always on top','always-on-top'],['Open mini signal window','mini-window']]],['Signals',[['Refresh signal analysis','refresh'],['Setup and risk filters','settings']]],['Help',[['About Aurum','about']]]].map(([menu,items])=><div className="custom-menu" key={menu as string}><button className={openMenu===menu?'menu-open':''} onClick={()=>setOpenMenu(openMenu===menu?null:menu as string)}>{menu}</button>{openMenu===menu&&<div className="custom-menu-dropdown">{(items as string[][]).map(([label,command])=><button key={label} onClick={()=>runMenuCommand(command)}>{label}</button>)}</div>}</div>)}</nav><div className="window-controls"><button aria-label="Minimize" onClick={()=>window.aurum?.windowControls.minimize()}><Minus size={14}/></button><button aria-label="Maximize" onClick={()=>window.aurum?.windowControls.toggleMaximize()}><Square size={11}/></button><button className="window-close" aria-label="Close" onClick={()=>window.aurum?.windowControls.close()}><X size={15}/></button></div></div>
    <header className="topbar">
      <div className="instrument"><span className="gold-dot"/><div><b>XAUUSD</b><small>Gold vs US Dollar</small></div><ChevronDown size={14}/></div>
      <div className="nav-tabs">{['Chart', 'Signals', 'History', 'Snapshots', 'MT5 Trades', 'Backtest'].map(x => <button onClick={() => setTab(x)} className={tab === x ? 'selected' : ''} key={x}>{x}{x === 'Signals' && engineSignals.length ? ` · ${engineSignals.length}` : ''}</button>)}</div>
      <div className="topbar-right"><div className="connection"><span className="live-dot"/> {mt5Status.connected ? 'MT5 LIVE' : 'MOCK FEED'} <span className="separator">/</span> PYTHON {engineStatus.toUpperCase()}</div><button className={`mt5-connect ${mt5Status.connected ? 'connected' : ''}`} onClick={() => void beginMt5Connect()}>{mt5Status.connected ? 'MT5 CONNECTED' : mt5AutoConnect ? 'WAITING FOR MT5…' : 'CONNECT MT5'}</button><button className="icon-btn theme-toggle" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button></div>
    </header>
    <main className="workspace">
      <aside className="left-column">
        <div className="left-panel-heading"><span className="eyebrow">MARKET CONTEXT</span><b>XAUUSD</b><span className={`overall-bias bias-${overallBias.toLowerCase()}`}>{overallBias} BIAS</span></div>
        <div className="market-strip">
        <div className="price-block"><span>XAUUSD <span className="tiny-live">{mt5Status.connected ? 'MT5 LIVE' : 'MOCK FEED'}</span></span><strong>{quote.bid.toFixed(2)}</strong></div>
        <div className="market-stat"><small>BID / ASK</small><b>{quote.bid.toFixed(2)} <i>/</i> {quote.ask.toFixed(2)}</b><span>Spread <strong>${(quote.ask - quote.bid).toFixed(2)}</strong></span></div>
        <div className="timeframe-biases" aria-label="Completed candle trend context using EMA, slope, ATR distance, and RSI">{frames.map(frame => { const insight = timeframeInsights[frame]; return <div className="bias-chip" key={frame} title={insight.detail}><small>{frame} · EMA {frame === 'H1' || frame === 'H4' ? 50 : 20}</small><b className={`bias-${insight.bias.toLowerCase()}`}>{insight.state}</b><span className="bias-detail">RSI {insight.rsi === null ? '—' : insight.rsi.toFixed(0)}{insight.rsi !== null && insight.rsi >= 70 ? ' · OB' : insight.rsi !== null && insight.rsi <= 30 ? ' · OS' : ''}</span></div> })}</div>
        </div>
        <div className="discipline-card"><div><div className="discipline-icon"><ShieldCheck size={15}/></div><span><b>Risk guard active</b><small>{account?.consecutiveLosses && account.consecutiveLosses >= (account.settings.maxConsecutiveLosses) ? 'Loss lockout active' : 'Limits checked before logging signals'}</small></span></div><span className="guard-status">ACTIVE</span><div className="daily-progress"><span>SIGNALS TODAY</span><b>{setupsToday} <i>/ {account?.settings.maxSignalsPerDay ?? 3}</i></b></div><div className="progress-track"><i style={{width:`${Math.min(100,setupsToday / (account?.settings.maxSignalsPerDay ?? 3) * 100)}%`}}/></div></div>
        <section className="account-equity-panel"><div><span>{mt5Status.connected ? 'MT5 ACCOUNT EQUITY' : 'LOCAL SIMULATED EQUITY'}</span><b>{(mt5Status.equity ?? account?.equity)?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'} {mt5Status.connected ? mt5Status.currency ?? '' : 'USD'}</b></div><small>{mt5Status.connected ? `Balance ${(mt5Status.balance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${mt5Status.currency ?? ''}` : `Realized P&amp;L ${(account?.realizedPnl ?? 0).toFixed(2)} USD`}</small><small>{mt5Positions.length} broker positions · {account?.openTrades.length ?? 0} local tracked</small></section>
        {(mt5Positions.length > 0 || mt5Status.connected) && <section className="position-tracking-panel mt5-positions"><div className="signal-feed-heading"><span>MT5 OPEN POSITIONS · LIVE</span><b>{mt5Positions.length}</b></div>{mt5Positions.length ? mt5Positions.map(position => <div className="tracked-position" key={position.ticket}><div><b>{position.direction === 'LONG' ? 'BUY' : 'SELL'} · {position.symbol} · {position.volume}</b><small>Entry {position.entry.toFixed(2)} · SL {position.stop.toFixed(2)} · TP {position.target.toFixed(2)}</small><small>Now {position.price.toFixed(2)} · P&amp;L {position.profit.toFixed(2)}</small></div><div className="live-position-actions"><input type="number" step="0.01" aria-label={`New MT5 stop loss for ${position.ticket}`} value={mt5StopDrafts[position.ticket] || position.stop.toFixed(2)} onChange={event => setMt5StopDrafts(values => ({ ...values, [position.ticket]: event.target.value }))}/><button disabled={updatingStops[`mt5-${position.ticket}`]} onClick={() => void updateMt5Stop(position)}>{updatingStops[`mt5-${position.ticket}`] ? 'SAVING…' : 'UPDATE SL'}</button><button disabled={mt5Busy} onClick={() => void closeMt5Position(position)}>Close</button></div></div>) : <p className="signal-feed-empty">No open MT5 positions for {mt5Symbol}.</p>}{mt5Exits.length > 0 && <><div className="signal-feed-heading mt5-history-heading"><span>RECENT BROKER EXITS · 30 DAYS</span><b>{mt5Exits.length}</b></div>{mt5Exits.slice(0,4).map(exit => <div className="mt5-exit-row" key={exit.ticket}><span>{exit.reason}<small>{exit.direction === 'LONG' ? 'BUY' : 'SELL'} · {new Date(exit.time*1000).toLocaleString()}</small></span><b className={exit.profit >= 0 ? 'positive' : 'negative'}>{exit.profit.toFixed(2)}</b></div>)}</>}</section>}
        {account && account.openTrades.length > 0 && <section className="position-tracking-panel local-tracked-positions"><div className="signal-feed-heading"><span>LOCAL TRACKER · NOT MT5</span><b>{account.openTrades.length}</b></div><small className="local-tracker-note">These manual records consume your local open-position limit, but are not broker positions.</small>{account.openTrades.map(trade => <div className="tracked-position" key={trade.id}><div><b>{trade.direction === 'LONG' ? 'BUY' : 'SELL'} · {trade.entry.toFixed(2)}</b><small>SL {trade.stop.toFixed(2)} · TP {trade.target.toFixed(2)}</small></div><div className="tracked-position-controls"><input type="number" step="0.01" aria-label={`Updated local stop loss for ${trade.id}`} value={trackedStopDrafts[trade.id] || trade.stop.toFixed(2)} onChange={event => setTrackedStopDrafts(values => ({ ...values, [trade.id]: event.target.value }))}/><button disabled={updatingStops[`tracked-${trade.id}`]} onClick={() => void updateTrackedStop(trade.id, trade.stop)}>{updatingStops[`tracked-${trade.id}`] ? 'SAVING…' : 'UPDATE SL'}</button><input type="number" step="0.01" aria-label="Position exit price" placeholder="Exit price" value={exitPrices[trade.id] ?? ''} onChange={event => setExitPrices(values => ({ ...values, [trade.id]: event.target.value }))}/><button onClick={() => void closeTrackedTrade(trade.id)}>Close</button><button className="forget-tracker" onClick={() => void forgetTrackedTrade(trade.id)}>Forget</button></div></div>)}</section>}
      </aside>
      <section className="main-column">

        <div className="toolbar">
          {tab === 'Chart' && <div className="chart-controls"><div className="timeframes">{frames.map(f => <button onClick={() => setTimeframe(f)} className={timeframe === f ? 'active' : ''} key={f}>{f}</button>)}</div><span className="control-divider"/><button onClick={() => setShowDrawings(!showDrawings)} className={`overlay-toggle ${showDrawings ? 'enabled' : ''}`}><Eye size={14}/><span>Analysis</span></button><button title="Show or hide signal risk/reward drawings" onClick={() => setShowRiskReward(value => { const next = !value; localStorage.setItem('aurum-show-risk-reward', String(next)); return next })} className={`overlay-toggle ${showRiskReward ? 'enabled' : ''}`}><Target size={14}/><span>R:R</span></button><span className="control-divider"/><div className="chart-utility-controls" aria-label="Chart controls"><button title="Zoom in" aria-label="Zoom in" onClick={() => setChartAction({ action: 'zoom-in', nonce: Date.now() })}><ZoomIn size={14}/></button><button title="Zoom out" aria-label="Zoom out" onClick={() => setChartAction({ action: 'zoom-out', nonce: Date.now() })}><ZoomOut size={14}/></button><button title="Fit candles" aria-label="Fit candles" onClick={() => setChartAction({ action: 'fit', nonce: Date.now() })}><RotateCcw size={13}/></button><button title="Save chart snapshot" aria-label="Save chart snapshot" onClick={() => setManualSnapshotRequest({ nonce: Date.now() })}><Camera size={14}/></button><button title="Toggle fullscreen" aria-label="Toggle chart fullscreen" onClick={() => { const pane = document.querySelector('.chart-wrap'); if (document.fullscreenElement) void document.exitFullscreen(); else if (pane?.requestFullscreen) void pane.requestFullscreen() }}><Maximize size={13}/></button></div></div>}
        </div>
        {tab === 'Backtest' && <div className="history-range-controls"><label>Start date (UTC)<input type="date" value={backtestStartDate} max={backtestEndDate || undefined} disabled={backtestFeed !== 'MT5' || backtestBusy} onChange={event => setBacktestStartDate(event.target.value)}/></label><label>End date (UTC)<input type="date" value={backtestEndDate} min={backtestStartDate || undefined} disabled={backtestFeed !== 'MT5' || backtestBusy} onChange={event => setBacktestEndDate(event.target.value)}/></label><button type="button" className="run-backtest cache-history-button" disabled={!mt5Status.connected || historyCacheBusy} onClick={() => void cacheHistoryFrom2019()}>{historyCacheBusy ? historyCacheProgress.split(" · ")[0] : "Cache history from 2019"}</button><small>Download covers 2019 onward across M5, M15, H1, and H4. For full M5 history, MT5 may need Max. bars in chart near 1,000,000; that setting increases terminal memory use. Backtests split chronologically 70/30.</small>{historyCacheProgress&&<small className="history-cache-status">{historyCacheProgress}</small>}</div>}
        {tab === 'Chart' ? <>
          <div className="chart-meta"><div className="legend"><span><i className="legend-ema20"/> EMA 20</span><span><i className="legend-ema50"/> EMA 50</span><span><i className="legend-vwap"/> Session VWAP</span><span><i className="legend-vol"/> Volume</span></div><div className="meta-actions"><span>ATR 14 · ${atr.toFixed(2)}</span></div></div>
          <div className="chart-history-control"><button type="button" onClick={() => void loadOlderCandles()} disabled={!mt5Status.connected || chartOlderLoading || !chartHasOlder}>{chartOlderLoading ? 'Loading older bars…' : chartHasOlder ? 'Load older bars' : 'No older bars available'}</button><span>{displayCandles.length} chart bars · drag left to inspect</span></div>
      <Chart key={`${mt5Status.connected ? 'mt5' : 'mock'}:${mt5Symbol}:${timeframe}`} candles={displayCandles} timeframe={timeframe} drawings={drawingPayload} tradeLevels={signal} showTradeLevels={!!engineSignal} direction={engineSignal?.direction ?? 'LONG'} onTradeLevelsChange={updateSignalLevels} theme={theme} chartAction={chartAction} focusRequest={chartFocusRequest} snapshotRequest={manualSnapshotRequest} onSnapshot={captureManualSnapshot}/>
          <div className="chart-footer"><span><CircleHelp size={12}/> Scroll to zoom · Drag to pan · Hover for OHLC</span><span>PRICE USD / OZ <i>·</i> {mt5Status.connected ? 'MT5 LIVE' : 'MOCK DATA'}</span></div>
        </> : tab === 'Signals' ? <section className="signals-page"><header><div><span className="eyebrow">SIGNAL FEED · {mt5Status.connected ? 'MT5 MARKET DATA' : 'MOCK MARKET DATA'}</span><h2>Recent signals</h2></div><span>{engineSignals.length} total</span></header>{engineSignals.length ? engineSignals.slice().reverse().slice((signalsPage-1)*pageSize,signalsPage*pageSize).map(item=><button type="button" key={item.id} className={`signals-row ${engineSignal?.id === item.id ? 'selected' : ''} ${item.eligible ? '' : 'blocked'}`} onClick={()=>void openSignalInChart(item)}><b className={`signal-feed-direction ${item.direction.toLowerCase()}`}>{item.direction === 'LONG' ? 'BUY' : 'SELL'}</b><span><strong>Setup {item.setup} · {item.setupName}</strong><small>{item.session} · {new Date(item.timestamp*1000).toLocaleString('en-GB',{timeZone:'Africa/Lagos'})}</small></span><span className="signals-row-price">{item.entry.toFixed(2)}<small>{item.eligible ? 'READY' : `BLOCKED · ${item.blockReason ?? 'Risk control'}`}</small></span></button>) : <p className="signals-empty">No signals recorded for the current candle window.</p>}{engineSignals.length>pageSize&&<nav className="pagination" aria-label="Signal pages"><button disabled={signalsPage===1} onClick={()=>setSignalsPage(page=>Math.max(1,page-1))}>Previous</button><span>Page {signalsPage} of {Math.ceil(engineSignals.length/pageSize)}</span><button disabled={signalsPage>=Math.ceil(engineSignals.length/pageSize)} onClick={()=>setSignalsPage(page=>Math.min(Math.ceil(engineSignals.length/pageSize),page+1))}>Next</button></nav>}</section> : tab === 'History' ? <section className="records-page"><header><div><span className="eyebrow">SIGNALS AND TRACKED OUTCOMES</span><h2>History</h2></div><button onClick={()=>void loadHistory()} disabled={historyLoading}>{historyLoading?'Loading…':'Refresh'}</button></header>{historyStats&&<div className="history-win-rates"><article><small>OVERALL SETUP WIN RATE</small><b>{historyStats.signals.winRate}%</b><span>{historyStats.signals.wins} wins / {historyStats.signals.losses} losses / {historyStats.signals.settled} resolved signals</span></article><article><small>TAKEN / TRACKED WIN RATE</small><b>{historyStats.tracked.winRate}%</b><span>{historyStats.tracked.wins} wins / {historyStats.tracked.losses} losses / {historyStats.tracked.settled} resolved tracked signals</span></article></div>}<div className="history-filters">{['All','Ready','Blocked','Open','Closed'].map(filter=><button key={filter} className={historyFilter===filter?'active':''} onClick={()=>{setHistoryFilter(filter);setHistoryPage(1)}}>{filter}</button>)}</div><div className="history-list">{historyRecords.filter(item=>historyFilter==='All'||item.status.toLowerCase()===historyFilter.toLowerCase()).slice((historyPage-1)*pageSize,historyPage*pageSize).map(item=><button className="history-row" key={item.id} onClick={()=>{setEngineSignals(records=>records.some(record=>record.id===item.id)?records:[...records,item]);void openSignalInChart(item)}}><b className={`signal-feed-direction ${item.direction.toLowerCase()}`}>{item.direction==='LONG'?'BUY':'SELL'}</b><span className="history-main"><strong>Setup {item.setup} · {item.setupName}</strong><small>{item.session} · {new Date(item.timestamp*1000).toLocaleString('en-GB',{timeZone:'Africa/Lagos'})}</small><small>Entry {item.entry.toFixed(2)} · SL {item.stop.toFixed(2)} · TP {item.target.toFixed(2)}</small></span><span className="history-outcome"><b className={`status-${item.status}`}>{item.status.toUpperCase()}</b><small>{item.outcome==='win'?'SIGNAL RESULT · TARGET HIT':item.outcome==='loss'?'SIGNAL RESULT · STOP HIT':'SIGNAL RESULT · PENDING'}{item.outcomeR!==null&&item.outcomeR!==undefined?` · ${item.outcomeR>=0?'+':''}${item.outcomeR.toFixed(2)}R`:''}</small><small>{item.status==='closed' ? `${(item.realizedPnl??0)>=0?'+':''}${(item.realizedPnl??0).toFixed(2)} · ${(item.resultR??0).toFixed(2)}R` : item.blockReason??(item.status==='open'?'TRACKED POSITION':'')}</small></span></button>)}{!historyRecords.length&&!historyLoading&&<p className="signals-empty">No signals have been recorded yet. Signals appear here after analysis runs.</p>}{historyRecords.filter(item=>historyFilter==='All'||item.status.toLowerCase()===historyFilter.toLowerCase()).length>pageSize&&<nav className="pagination" aria-label="History pages"><button disabled={historyPage===1} onClick={()=>setHistoryPage(page=>Math.max(1,page-1))}>Previous</button><span>Page {historyPage} of {Math.ceil(historyRecords.filter(item=>historyFilter==='All'||item.status.toLowerCase()===historyFilter.toLowerCase()).length/pageSize)}</span><button disabled={historyPage>=Math.ceil(historyRecords.filter(item=>historyFilter==='All'||item.status.toLowerCase()===historyFilter.toLowerCase()).length/pageSize)} onClick={()=>setHistoryPage(page=>Math.min(Math.ceil(historyRecords.filter(item=>historyFilter==='All'||item.status.toLowerCase()===historyFilter.toLowerCase()).length/pageSize),page+1))}>Next</button></nav>}</div></section> : tab === 'Snapshots' ? <section className="records-page snapshots-page"><header><div><span className="eyebrow">AUTO-SAVED WHEN A SIGNAL OR TRACKED TRADE WINS</span><h2>Winning chart snapshots</h2></div><button onClick={()=>void scanWinningSnapshots()}>Refresh</button></header><p className="snapshots-intro">Each image shows the signal chart through the candle that reached its target or the tracked trade close.</p>{snapshotRecords.length ? <div className="snapshot-grid">{snapshotRecords.map(item=><article key={item.id}><div className="snapshot-card-top"><b className={item.direction==='LONG'?'positive':'negative'}>{item.direction==='LONG'?'BUY':'SELL'}</b><span>{item.outcomeR===null?'WIN':(item.outcomeR>=0?'+':'')+item.outcomeR.toFixed(2)+'R'}</span></div><h3>{item.setupName}</h3><small>{new Date((item.outcomeTime??item.timestamp)*1000).toLocaleString('en-GB',{timeZone:'Africa/Lagos'})}</small><p>Entry {item.entry.toFixed(2)} · SL {item.stop.toFixed(2)} · TP {item.target.toFixed(2)}{item.taken?' · TAKEN / TRACKED':' · SIGNAL'}</p><button onClick={()=>void reviewSnapshot(item)}>REVIEW CHART</button></article>)}</div> : <p className="signals-empty">Winning snapshots will appear here after a signal reaches target or a tracked trade closes profitably.</p>}</section> : tab === 'MT5 Trades' ? <Mt5Orders connected={mt5Status.connected}/> : <section className="records-page backtest-page"><header><div><span className="eyebrow">{backtestFeed==="MT5"?"MT5 BROKER HISTORY":"HISTORICAL MOCK CANDLES"} · SIMULATION ONLY</span><h2>Backtest setups</h2></div></header><div className="backtest-controls"><label>Data<select value={backtestFeed} onChange={e=>setBacktestFeed(e.target.value as any)}><option value="Mock">Mock</option><option value="MT5" disabled={!mt5Status.connected}>MT5 history</option></select></label><label>Fallback spread ($)<input type="number" min="0" max="100" step="0.01" value={backtestSpread} onChange={e=>setBacktestSpread(e.target.value)}/></label><label>Session<select value={backtestSession} onChange={e=>setBacktestSession(e.target.value as typeof backtestSession)}><option>All</option><option>Asia</option><option>London</option><option>New York</option></select></label><label className="news-filter"><input type="checkbox" checked={backtestExcludeNews} onChange={e=>setBacktestExcludeNews(e.target.checked)}/>Exclude saved news blackouts</label><button className="run-backtest" disabled={backtestBusy} onClick={()=>void runHistoricalBacktest()}>{backtestBusy?'Running…':'Run backtest'}</button></div>{backtestDataReport&&<div className="broker-data-report"><b>{backtestDataReport.source==="MT5"?"MT5 HISTORY CHECK":"MOCK HISTORY CHECK"}</b><span>{backtestDataReport.symbol} · requested {backtestDataReport.range}</span>{backtestDataReport.availableRange&&<span>Bars received incl. warm-up: {backtestDataReport.availableRange}</span>}{backtestDataReport.cachedBars!==undefined&&<span>Previously cached bars reused: {backtestDataReport.cachedBars}</span>}<span>Fallback spread ${backtestDataReport.spread.toFixed(2)} · configured maximum ${backtestDataReport.spreadLimit.toFixed(2)} · {backtestDataReport.spread<=backtestDataReport.spreadLimit?"within limit":"over configured limit"}</span><span>Bars UTC: M5 {backtestDataReport.counts.M5} · M15 {backtestDataReport.counts.M15} · H1 {backtestDataReport.counts.H1} · gaps M5/M15/H1 {backtestDataReport.gaps.M5}/{backtestDataReport.gaps.M15}/{backtestDataReport.gaps.H1}</span><span>Observed M5 sessions UTC: Asia {backtestDataReport.sessions.Asia} · London {backtestDataReport.sessions.London} · New York {backtestDataReport.sessions.newYork} · off hours {backtestDataReport.sessions.offHours}</span><small>Gap counts include weekends and broker session closures. Session filter uses candle UTC timestamps.</small></div>}{backtestResult?.error&&<p className="backtest-error">{backtestResult.error}</p>}{backtestResult&&!backtestResult.error&&<><div className="backtest-metrics">{[['Trades',backtestResult.trades],['Win rate',`${backtestResult.winRate}%`],['Open',backtestResult.openTrades],['Average R',`${backtestResult.averageR}R`],['Expectancy',`${backtestResult.expectancyR}R`],['Net P&L',`$${backtestResult.netPnl.toFixed(2)}`],['Max drawdown',`$${backtestResult.maxDrawdown.toFixed(2)}`]].map(([label,value])=><div key={label}><small>{label}</small><b>{value}</b></div>)}</div>{backtestResult.outOfSample&&<section className="backtest-oos"><b>Chronological check · 70% development / 30% holdout</b><small>Split at {backtestResult.outOfSample.splitDate}. Holdout is the later portion; avoid tuning rules against it.</small><div className="backtest-oos-grid">{([["Development",backtestResult.outOfSample.training],["Holdout",backtestResult.outOfSample.holdout]] as const).map(([label,period])=><div key={label}><b>{label}</b><span>{period.trades} trades · {period.settled} settled</span><span>{period.winRate}% win rate · {period.expectancyR}R expectancy</span><span>Net ${period.netPnl.toFixed(2)} · DD ${period.maxDrawdown.toFixed(2)}</span></div>)}</div></section>}<div className="setup-results"><div className="setup-result-row setup-result-heading"><b>Setup</b><b>Trades</b><b>Win rate</b><b>Avg R</b><b>Net P&amp;L</b></div>{backtestResult.bySetup.map(row=><div className="setup-result-row" key={row.setup}><b>Setup {row.setup}</b><span>{row.trades}</span><span>{row.winRate}%</span><span>{row.averageR}R</span><span>${row.netPnl.toFixed(2)}</span></div>)}{!backtestResult.bySetup.length&&<p className="signals-empty">No setup signals found in this candle window. Try all sessions or check enabled setups.</p>}</div><div className="backtest-assumptions"><b>Execution assumptions</b>{backtestResult.assumptions.map(item=><p key={item}>{item}</p>)}<small>Applied spread: avg ${backtestResult.spreadStats.average.toFixed(3)} · median ${backtestResult.spreadStats.median.toFixed(3)} · max ${backtestResult.spreadStats.maximum.toFixed(3)} /oz from {backtestResult.spreadStats.samples} samples ({backtestResult.spreadStats.historicalSamples} historical · {backtestResult.spreadStats.fallbackSamples} fallback).</small><small>Spread source: {backtestResult.spreadSource}</small><small>Excluded by filters: {backtestResult.skipped.session} session · {backtestResult.skipped.news} news · {backtestResult.skipped.no_forward_bars} no following candle · {backtestResult.skipped.spread} spread</small></div></>}{!backtestResult&&!backtestBusy&&<p className="backtest-intro">Mock candles are demonstrations only. Select MT5 history and a UTC date range to test the enabled setups on broker bars; that still requires out-of-sample validation before making profitability claims.</p>}</section>}
        <section className="analysis-explanation"><div className="signal-rationale"><b><ShieldCheck size={13}/> {engineSignal ? 'WHY THIS SIGNAL' : 'LIVE ANALYSIS'}</b><p>{engineSignal?.rationale ?? 'No setup currently meets the strategy filters. The engine is checking price structure and timeframe alignment.'}</p><div>{engineSignal ? <><span>SETUP {engineSignal.setup}</span><span>{engineSignal.eligible ? 'RISK CHECKED' : 'BLOCKED'}</span><span>{engineSignal.session.toUpperCase()}</span></> : <><span>ENGINE MONITORING</span><span>TIMEFRAME FILTERS</span><span>WAITING FOR TRIGGER</span></>}</div></div></section>
      </section>
      <aside className="side-column">
        <div className="signal-heading"><div><span className="eyebrow">SIGNAL MONITOR</span><h2>Setups <span className="count-badge">{engineSignals.length}</span></h2></div><button className="icon-btn" aria-label="Open risk settings" onClick={() => { if (account) { setSettingsDraft(account.settings); setSettingsOpen(true) } }}><Settings2 size={16}/></button></div>
        <div className="signal-card featured"><div className="signal-card-top"><span className="quality"><Sparkles size={12}/> {engineSignal ? `${Math.round(engineSignal.confidence * 100)}% CONFIDENCE` : 'NO ACTIVE SIGNAL'}</span><span className="signal-time"><span/> {engineSignal ? new Date(engineSignal.timestamp * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '—'}</span></div><div className="setup-title"><div className="setup-icon"><Zap size={16}/></div><div><h3>{engineSignal?.setupName ?? 'Waiting for a qualifying setup'}</h3><small>SETUP {engineSignal?.setup ?? '—'} <span>·</span> {engineSignal?.session?.toUpperCase() ?? 'WAITING'}</small></div></div><div className="signal-direction"><span className={`long-pill ${engineSignal?.direction === 'SHORT' ? 'sell-pill' : !engineSignal ? 'neutral-pill' : ''}`}>{engineSignal ? engineSignal.direction === 'LONG' ? 'BUY' : 'SELL' : '—'}</span><span className="confidence">{engineSignal ? `${Math.round(engineSignal.confidence * 100)}% confidence` : 'Awaiting setup'}</span></div><div className="signal-levels"><div><small>ENTRY</small><b>{engineSignal ? formatFinite(signal.entry) : '—'}</b></div><div><small>STOP LOSS</small><b className="negative">{engineSignal ? formatFinite(signal.stop) : '—'}</b></div><div><small>TARGET</small><b className="positive">{engineSignal ? formatFinite(signal.target) : '—'}</b></div></div><div className="risk-summary"><span><small>RISK AT {account?.settings.riskPercent ?? 1}%</small><b>{engineSignal ? `$${formatFinite(engineSignal.riskDollars)}` : '—'}</b></span><i/><span><small>SIZE · LOTS*</small><b>{engineSignal ? formatFinite(engineSignal.positionSizeLots, 3) : '—'}</b></span><i/><span><small>R:R RATIO</small><b className="positive">{engineSignal ? `1 : ${formatFinite(signalRMultiple, 1)}` : '—'}</b></span></div><div className={`signal-eligibility ${engineSignal?.eligible === false ? 'blocked' : ''}`}>{engineSignal?.confidenceOverride ? 'CONFIDENCE OVERRIDE · RISK CHECKS BYPASSED' : engineSignal?.manualOverride ? 'MANUAL OVERRIDE USED · TRACKED LOCALLY' : engineSignal?.eligible === false ? `BLOCKED · ${engineSignal.blockReason ?? 'Risk control'}` : engineSignal ? 'RISK CHECKS PASSED' : 'NO ACTIVE SIGNAL · WAITING FOR CONDITIONS'}</div>{engineSignal && <div className={`signal-eligibility ${entryAssessment.canEnter ? "" : "blocked"}`}>{entryAssessment.message}{entryAssessment.canEnter && <button className="take-trade" disabled={mt5Busy} onClick={() => void submitMt5Order(true)}>ENTER AT MARKET</button>}</div>}{engineSignal && account?.settings.positionTrackingEnabled && engineSignal.eligible && !tradeTaken && <div className="track-signal-controls"><input type="number" step="0.01" aria-label="Optional actual entry" placeholder={`Entry (default ${formatFinite(engineSignal.entry)})`} value={trackingEntry} onChange={event => setTrackingEntry(event.target.value)}/><button className="take-trade" onClick={() => void markTradeTaken()}><Target size={14}/>TRACK SIGNAL</button></div>}{engineSignal && account?.settings.positionTrackingEnabled && !engineSignal.eligible && !tradeTaken && <div className="track-signal-controls"><input type="number" step="0.01" aria-label="Optional actual entry" placeholder={`Entry (default ${formatFinite(engineSignal.entry)})`} value={trackingEntry} onChange={event => setTrackingEntry(event.target.value)}/><button className="override-track" onClick={() => void markTradeTaken(true)}>OVERRIDE &amp; TRACK</button></div>}{tradeTaken && <div className="signal-eligibility">POSITION TRACKED · manage exit below</div>}<div className="hotkey-hint">{engineSignal ? 'SIGNAL LEVELS · Drag entry, stop, or target to adjust' : 'No active signal · No trade levels are set'}{account?.settings.positionTrackingEnabled ? ' · Optional tracking enabled' : ''}</div></div>
        <section className="mt5-ticket"><div className="signal-feed-heading"><span>MT5 ORDER TICKET</span><b>{mt5Status.connected ? `${mt5Status.accountMode ?? 'CONNECTED'} · ${mt5Status.tradeAllowed ? 'READY' : 'READ ONLY'}` : mt5AutoConnect ? 'WAITING FOR LOGIN' : 'OFFLINE'}</b></div>{mt5Status.server && <div className="mt5-server">{mt5Status.server} · {mt5Status.accountMode} account</div>}{mt5Status.error && <p className={`mt5-error ${mt5AutoConnect ? 'mt5-waiting' : ''}`}>{mt5Status.error}</p>}<label>Broker symbol<input value={mt5Symbol} onChange={event => setMt5Symbol(event.target.value.trim())} placeholder="XAUUSDm"/></label><div className="mt5-form-row"><label>Side<select value={orderDirection} onChange={event => setOrderDirection(event.target.value as 'LONG'|'SHORT')}><option value="LONG">BUY</option><option value="SHORT">SELL</option></select></label><label>Volume (lots)<input type="number" min="0.01" step="0.01" value={orderVolume} onChange={event => setOrderVolume(event.target.value)}/></label></div><div className="mt5-form-row"><label>Stop loss<input type="number" step="0.01" value={orderStop} onChange={event => setOrderStop(event.target.value)} placeholder="Required"/></label><label>Take profit<input type="number" step="0.01" value={orderTarget} onChange={event => setOrderTarget(event.target.value)} placeholder="Required"/></label></div><div className="mt5-ticket-actions"><button onClick={useSignalLevels}>Reset to signal levels</button><button className={`mt5-submit ${orderDirection === 'LONG' ? 'buy-order' : 'sell-order'}`} disabled={!mt5Status.connected || !mt5Status.tradeAllowed || mt5Busy} onClick={() => void submitMt5Order()}>{mt5Busy ? 'WORKING…' : orderDirection === 'LONG' ? 'BUY AT MARKET' : 'SELL AT MARKET'}</button></div><small className="mt5-note">SL/TP auto-fill from the active signal · MT5 confirms orders</small></section>
        <div className="source-footer"><span><Wifi size={13}/> Local only · No broker credentials</span><button><Download size={12}/> Export log</button></div>
      </aside>
    </main>
    <footer className="statusbar"><div className="status-runtime"><span className="status-led"/> ENGINE {engineStatus.toUpperCase()} <i/> {mt5Status.connected ? `MT5 · ${mt5Symbol}` : 'MOCK DATA'} <i/> ANALYSIS {showDrawings ? 'ON' : 'OFF'}</div><div className="session-clock"><b>{sessionClock(clockNow).active.length ? sessionClock(clockNow).active.join(' · ') : 'No major session open'}</b><small>{sessionClock(clockNow).overlaps.length ? `OVERLAP · ${sessionClock(clockNow).overlaps.map(pair => pair.join('–')).join(' · ')}` : 'NO SESSION OVERLAP'}</small></div><div className="clock-pair"><span>UTC <b>{clockNow.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false })}</b></span><span>{Intl.DateTimeFormat().resolvedOptions().timeZone} <b>{clockNow.toLocaleTimeString('en-GB', { hour12: false })}</b></span></div><div className="status-promise">SIGNAL FIRST · ORDERS REQUIRE YOUR CONFIRMATION <span className="status-shield"><ShieldCheck size={12}/></span></div></footer>
    {settingsOpen && settingsDraft && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-modal" style={settingsPosition ? {position:'fixed',margin:0,left:settingsPosition.left,top:settingsPosition.top,transform:'none'} : undefined} role="dialog" aria-modal="true" aria-labelledby="settings-title"><header onPointerDown={startSettingsDrag} onPointerMove={moveSettingsDrag} onPointerUp={endSettingsDrag} onPointerCancel={endSettingsDrag}><div><small>RISK CONTROLS</small><h2 id="settings-title">Account settings</h2></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></header><div className="settings-grid">{([['startCapital','Starting capital','number'],['riskPercent','Risk per trade (%)','number'],['spreadLimit','Maximum spread ($)','number'],['contractSizeOz','Broker contract size (oz/lot)','number'],['maxSignalsPerDay','Signals per UTC day','number'],['maxOpenPositions','Open positions maximum','number'],['maxConsecutiveLosses','Losses before lockout','number']] as const).map(([key,label,type])=><label key={key}>{label}<input type={type} min="0" step={key==='startCapital'?'100':key==='riskPercent'?'0.1':key==='spreadLimit'?'0.01':key==='contractSizeOz'?'1':'1'} value={settingsDraft[key]} onChange={e => setSettingsDraft({...settingsDraft,[key]:Number(e.target.value)})}/></label>)}</div><label className="setup-rr-setting">Setup C minimum R:R (1:x)<input type="number" min="2" max="10" step="0.25" value={settingsDraft.setupCMinRR ?? 2} onChange={e => setSettingsDraft({...settingsDraft,setupCMinRR:Number(e.target.value)})}/><small>Uses at least this R multiple; farther swing targets are kept when they offer more room.</small></label><section className="setup-toggles settings-setups" aria-label="Signal setup filters"><div className="setup-toggles-title">ACTIVE SETUPS</div>{([ ["A","Opening range breakout"], ["B","Liquidity sweep + MSS"], ["C","H1 trend pullback"] ] as const).map(([key,label])=><label key={key}><span><b>{key}</b>{label}</span><input type="checkbox" checked={settingsDraft.enabledSetups?.[key] ?? true} onChange={event => setSettingsDraft({...settingsDraft,enabledSetups:{...settingsDraft.enabledSetups,[key]:event.target.checked}})} aria-label={`Enable setup ${key}: ${label}`}/></label>)}</section><label className="tracking-setting"><input type="checkbox" checked={settingsDraft.positionTrackingEnabled} onChange={e => setSettingsDraft({...settingsDraft,positionTrackingEnabled:e.target.checked})}/><span><b>Enable optional position tracking</b><small>Shows TRACK on eligible signals and OVERRIDE & TRACK on blocked signals. This records locally; it does not place an MT5 order.</small></span></label><label className="tracking-setting"><input type="checkbox" checked={settingsDraft.lanViewEnabled} onChange={e => setSettingsDraft({...settingsDraft,lanViewEnabled:e.target.checked})}/><span><b>Enable read-only LAN view</b><small>Shares the latest signal and quote on port 55173. Turn off to stop the local network server.</small></span></label>{lanStatus.enabled&&<p className="lan-view-status">LAN view running: {lanStatus.urls?.join(" · ")}</p>}{lanStatus.error&&<p className="lan-view-status error">{lanStatus.error}</p>}<label className="news-field">News blackout events <small>One event per line: ISO date/time with UTC offset | event name | blackout minutes</small><textarea value={settingsDraft.newsEvents.map(event => `${event.time}|${event.label}|${event.blackoutMinutes ?? 15}`).join('\n')} onChange={e => setSettingsDraft({...settingsDraft,newsEvents:e.target.value.split('\n').filter(Boolean).map(line => { const [time,label,minutes] = line.split('|'); return {time,label,blackoutMinutes:Number(minutes)||15} })})} placeholder="2026-11-14T13:30:00Z|US CPI|15"/></label><div className="app-zoom-setting"><span>App text size <b>{Math.round(appZoom*100)}%</b></span><div><button type="button" aria-label="Decrease app text size" disabled={appZoom<=0.8} onClick={()=>adjustAppZoom(-0.05)}>A−</button><button type="button" aria-label="Increase app text size" disabled={appZoom>=1.25} onClick={()=>adjustAppZoom(0.05)}>A+</button></div><small>Changes app text and interface size.</small></div><button type="button" className="signal-sound-test" onClick={playSignalSound}>Test new-signal sound</button><p className="settings-note">Lot size is an estimate using your configured contract size. Confirm the exact contract specification with your broker before relying on it.</p><footer><button onClick={() => setSettingsOpen(false)}>Cancel</button><button className="save-settings" onClick={async () => { try { const state = await window.aurum?.saveSettings(settingsDraft); if (state) { setAccount(state); const lan = await window.aurum?.setLanView(settingsDraft.lanViewEnabled); if (lan) setLanStatus(lan) }; setSettingsOpen(false); const analysis = await analyzeCurrent(); if (analysis) { setEngineSignals(analysis.signals); setAccount(analysis) } } catch (error) { setEngineStatus(`error: ${error instanceof Error ? error.message : String(error)}`) } }}>Save settings</button></footer></section></div>}
    {autoSnapshotTask && snapshotSignal && <div aria-hidden="true" style={{position:'fixed',left:'-20000px',top:0,width:1200,height:720,display:'flex',flexDirection:'column',visibility:'hidden',pointerEvents:'none',zIndex:-1}}><Chart key={autoSnapshotTask.nonce} candles={autoSnapshotTask.candles} timeframe="M5" drawings={snapshotDrawings} tradeLevels={snapshotLevels} showTradeLevels direction={snapshotSignal.direction} theme={theme} focusRequest={{timestamp:snapshotSignal.timestamp,endTimestamp:snapshotWinTime,nonce:autoSnapshotTask.nonce}} snapshotRequest={{nonce:autoSnapshotTask.nonce}} onSnapshot={finishAutoSnapshot}/></div>}
    {snapshotViewer && <div className="modal-backdrop snapshot-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setSnapshotViewer(null)}}><section className="snapshot-viewer" role="dialog" aria-modal="true" aria-label="Winning trade chart snapshot"><header><div><small>{snapshotViewer.record.outcome} · {snapshotViewer.record.outcomeR===null?'WIN':(snapshotViewer.record.outcomeR>=0?'+':'')+snapshotViewer.record.outcomeR.toFixed(2)+'R'}</small><h2>{snapshotViewer.record.setupName}</h2></div><button onClick={()=>setSnapshotViewer(null)} aria-label="Close snapshot">×</button></header><img src={snapshotViewer.image} alt={snapshotViewer.record.setupName+' winning trade chart'}/><footer><a href={snapshotViewer.image} download={'Aurum-'+snapshotViewer.record.signalId+'.png'}>Download PNG</a><button onClick={()=>setSnapshotViewer(null)}>Close</button></footer></section></div>}    {aboutOpen && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setAboutOpen(false) }}><section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title"><header><div><small>ABOUT THE APP</small><h2 id="about-title">Aurum Gold Signal Desk</h2></div><button onClick={() => setAboutOpen(false)} aria-label="Close About">×</button></header><p>A local XAUUSD analysis workspace. Orders require your confirmation in the connected MT5 terminal.</p><div className="chart-attribution"><b>TradingView Lightweight Charts™</b><span>Copyright (c) 2025 TradingView, Inc.</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView.com</a></div><button className="save-settings" onClick={() => setAboutOpen(false)}>Close</button></section></div>}
  </div>
}
export default App


