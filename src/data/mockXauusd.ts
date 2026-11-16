import type { Candle, DataSource, Timeframe } from './types'

const minutesPerBar: Record<Timeframe, number> = { M5: 5, M15: 15, H1: 60, H4: 240 }
const MINUTE = 60
const DAY = 24 * 60
const SIMULATION_HISTORY_DAYS = 45

function minuteCandle(index: number, open: number): Candle {
  const minuteOfDay = ((index % DAY) + DAY) % DAY
  const session = minuteOfDay >= 7 * 60 && minuteOfDay < 13 * 60 ? 'london'
    : minuteOfDay >= 13 * 60 && minuteOfDay < 20 * 60 ? 'new-york' : 'asia'
  const volatility = session === 'london' ? 0.72 : session === 'new-york' ? 0.58 : 0.31
  const drift = session === 'london' ? 0.0018 : session === 'new-york' ? -0.0007 : 0.00015
  const noise = Math.sin(index * 1.71) * 0.105 + Math.cos(index * 0.63) * 0.075 + Math.sin(index * 0.11) * 0.035
  const delta = (noise + drift) * volatility
  const close = open + delta
  let high = Math.max(open, close) + (0.025 + Math.abs(Math.sin(index * 2.2)) * 0.075) * volatility
  let low = Math.min(open, close) - (0.025 + Math.abs(Math.cos(index * 1.3)) * 0.07) * volatility
  // Repeat a synthetic London sell-side sweep and bullish displacement each day.
  if (minuteOfDay === 8 * 60 + 29) low = open - 0.9
  if (minuteOfDay === 8 * 60 + 30) { high = open + 0.18; return { time: index * MINUTE, open, high, low: Math.min(open, close) - 0.04, close: open + 0.62, volume: 1250 } }
  if (minuteOfDay === 7 * 60 + 19) return { time: index * MINUTE, open, high: open + 0.98, low, close: open + 0.86, volume: 3200 }
  if (minuteOfDay === 13 * 60 + 19) return { time: index * MINUTE, open, high, low: open - 0.98, close: open - 0.86, volume: 3200 }
  const volume = Math.round((session === 'london' ? 360 : session === 'new-york' ? 290 : 150) + Math.abs(delta) * 1700 + Math.abs(Math.sin(index * 0.37)) * 100)
  return { time: index * MINUTE, open, high, low, close, volume }
}

/** A single synthetic M1 tape is aggregated into all requested timeframes. */
export class MockXauusdSource implements DataSource {
  async getCandles(tf: Timeframe, count: number): Promise<Candle[]> {
    const nowMinute = Math.floor(Date.now() / 60_000)
    const endMinute = Math.floor(nowMinute / minutesPerBar[tf]) * minutesPerBar[tf]
    const startMinute = Math.floor(endMinute / DAY) * DAY - SIMULATION_HISTORY_DAYS * DAY
    const result: Candle[] = []
    let price = 2640
    for (let i = startMinute; i < endMinute; i++) {
      const bar = minuteCandle(i, price)
      price = bar.close
      const bucket = Math.floor(i / minutesPerBar[tf]) * minutesPerBar[tf]
      const time = bucket * MINUTE
      const current = result.at(-1)
      if (current && current.time === time) {
        current.high = Math.max(current.high, bar.high)
        current.low = Math.min(current.low, bar.low)
        current.close = bar.close
        current.volume += bar.volume
      } else {
        result.push({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })
      }
    }
    return result.slice(-count)
  }
  async getQuote() {
    const [last] = await this.getCandles('M5', 1)
    const bid = last?.close ?? 2640
    return { bid, ask: bid + 0.34 }
  }
}

export class Mt5Source implements DataSource {
  async getCandles(): Promise<Candle[]> { throw new Error('MT5 bridge is not connected yet') }
  async getQuote(): Promise<{ bid: number; ask: number }> { throw new Error('MT5 bridge is not connected yet') }
}
