import type { Candle } from './types'

export function calculateAtr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0
  const ranges = candles.slice(-period).map((candle, index, recent) => {
    const absoluteIndex = candles.length - recent.length + index
    const previousClose = candles[absoluteIndex - 1]?.close ?? candle.open
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
  })
  return ranges.reduce((sum, range) => sum + range, 0) / ranges.length
}

/** Session VWAP resets at UTC midnight and uses typical price weighted by tick volume. */
export function calculateSessionVwap(candles: Candle[]) {
  let sessionDay = -1
  let weightedPrice = 0
  let volume = 0
  return candles.map(candle => {
    const day = Math.floor(candle.time / 86_400)
    if (day !== sessionDay) { sessionDay = day; weightedPrice = 0; volume = 0 }
    const typicalPrice = (candle.high + candle.low + candle.close) / 3
    weightedPrice += typicalPrice * candle.volume
    volume += candle.volume
    return { time: candle.time, value: volume ? weightedPrice / volume : typicalPrice }
  })
}
