import type { Candle } from '../data/types'

/** Versioned renderer payload. Coordinates use Unix seconds and instrument price. */
export type DrawingPoint = { time: number; price: number }
export type ZoneType = 'asiaRange' | 'openingRange' | 'fvg' | 'orderBlock' | 'supply' | 'demand'
export type Drawing =
  | { kind: 'zone'; id: string; label: string; from: number; to: number; top: number; bottom: number; color: string; opacity: number; zoneType?: ZoneType; extendRight?: boolean; mitigation?: { trigger: 'touch' | 'close'; boundary: 'top' | 'bottom' | 'mid' } }
  | { kind: 'level'; id: string; label: string; time: number; price: number; color: string; dashed?: boolean }
  | { kind: 'marker'; id: string; label: string; time: number; price: number; color: string; shape: 'arrowUp' | 'arrowDown' | 'dot' }
  | { kind: 'path'; id: string; label: string; points: DrawingPoint[]; color: string; dashed?: boolean; width?: number }

export function setupBDrawings(candles: Candle[]): Drawing[] {
  if (candles.length < 8) return []
  let sweepIndex = -1
  const lookback = Math.min(24, Math.max(5, Math.round(60 / ((candles[1].time - candles[0].time) / 60))))
  let sweptLevel = Number.NaN
  for (let i = lookback; i < candles.length - 1; i++) {
    const previous = candles.slice(i - lookback, i)
    const day = Math.floor(candles[i].time / 86_400) * 86_400
    const asiaBefore = candles.filter(c => c.time >= day && c.time < day + 7 * 3600 && c.time < candles[i].time)
    const threshold = asiaBefore.length ? Math.min(...asiaBefore.map(c => c.low)) : Math.min(...previous.map(c => c.low))
    if (candles[i].low < threshold && candles[i].close > threshold && candles[i + 1].close > candles[i + 1].open) { sweepIndex = i; sweptLevel = threshold }
  }
  if (sweepIndex < 0) return []
  const sweep = candles[sweepIndex]
  const displacement = candles[sweepIndex + 1]
  const sweepDay = Math.floor(sweep.time / 86_400) * 86_400
  const asia = candles.filter(c => c.time >= sweepDay && c.time < sweepDay + 7 * 3600 && c.time < sweep.time)
  const prior = candles.slice(Math.max(0, sweepIndex - lookback), sweepIndex)
  const asiaHigh = Math.max(...(asia.length ? asia : prior).map(c => c.high))
  const asiaLow = asia.length ? Math.min(...asia.map(c => c.low)) : Number.isFinite(sweptLevel) ? sweptLevel : Math.min(...prior.map(c => c.low))
  const last = candles.at(-1)!
  const zoneTop = displacement.low > sweep.high ? displacement.low : Math.max(displacement.open, displacement.close)
  const zoneBottom = displacement.low > sweep.high ? sweep.high : Math.min(displacement.open, displacement.close)
  return [
    { kind: 'zone', id: 'asia', label: 'ASIA RANGE', from: asia[0]?.time ?? prior[0].time, to: sweep.time, top: asiaHigh, bottom: asiaLow, color: '#839084', opacity: 0.08, zoneType: 'asiaRange' },
    { kind: 'level', id: 'swept', label: 'ASIA LOW · swept', time: sweep.time, price: asiaLow, color: '#dda45a', dashed: true },
    { kind: 'marker', id: 'sweep', label: 'LIQUIDITY SWEEP', time: sweep.time, price: sweep.low, color: '#e0a75a', shape: 'arrowUp' },
    { kind: 'zone', id: 'fvg', label: 'BULLISH FVG', from: displacement.time, to: last.time, top: zoneTop, bottom: zoneBottom, color: '#71b99a', opacity: 0.22, zoneType: 'fvg', extendRight: true, mitigation: { trigger: 'touch', boundary: 'bottom' } },
    { kind: 'marker', id: 'mss', label: 'MSS', time: displacement.time, price: displacement.high, color: '#8dd8b2', shape: 'arrowUp' },
    { kind: 'path', id: 'structure-leg', label: 'SWEEP → MSS', points: [{ time: sweep.time, price: sweep.low }, { time: displacement.time, price: displacement.high }], color: '#8dd8b2', width: 1.5 }
  ]
}

export function getMockSignal(candles: Candle[]) {
  const entry = candles.at(-1)?.close ?? 2648.6
  const stop = entry - 2.5
  return { entry, stop, target: entry + (entry - stop) * 1.5 }
}
