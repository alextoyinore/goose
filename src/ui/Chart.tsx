import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Candle, Timeframe } from '../data/types'
import type { Drawing } from '../drawings/schema'
import { calculateSessionVwap } from '../data/indicators'

type TradeLevels = { entry: number; stop: number; target: number }
type HoverCandle = { x: number; y: number; time: number; open: number; high: number; low: number; close: number; volume: number }
export type ChartAction = { action: 'fit'|'zoom-in'|'zoom-out'; nonce: number } | null
type Props = { candles: Candle[]; timeframe: Timeframe; drawings: Drawing[]; tradeLevels: TradeLevels; showTradeLevels?: boolean; direction?: 'LONG' | 'SHORT'; onTradeLevelsChange?: (levels: TradeLevels) => void; theme: 'dark' | 'light'; chartAction?: ChartAction; focusRequest?: { timestamp: number; endTimestamp?: number; nonce: number } | null; snapshotRequest?: { nonce: number } | null; onSnapshot?: (dataUrl: string) => void }
const zoomStorageKey = (timeframe: Timeframe) => `aurum-chart-zoom-${timeframe}`
function storeZoom(api: IChartApi, timeframe: Timeframe) {
  const range = api.timeScale().getVisibleLogicalRange()
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
    sessionStorage.setItem(zoomStorageKey(timeframe), JSON.stringify({ width: range.to - range.from, at: Date.now() }))
  }
}
export default function Chart({ candles, timeframe, drawings, tradeLevels, showTradeLevels = true, direction = 'LONG', onTradeLevelsChange, theme, chartAction, focusRequest, snapshotRequest, onSnapshot }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candleSeries = useRef<any>(null)
  const volumeSeries = useRef<any>(null)
  const previousFeed = useRef<{ timeframe: Timeframe; firstTime: number; lastTime: number; count: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [overlayRevision, setOverlayRevision] = useState(0)
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null)
  const [hoverCandle, setHoverCandle] = useState<HoverCandle | null>(null)
  const candleData = useRef<Candle[]>(candles)
  const focusedRequest = useRef<number | null>(null)
  const completedSnapshot = useRef<number | null>(null)
  candleData.current = candles
  const draggingLevel = useRef<keyof TradeLevels | null>(null)
  useEffect(() => {
    if (!host.current) return
    const api = createChart(host.current, {
      width: host.current.clientWidth, height: host.current.clientHeight,
      layout: { background: { color: theme === 'dark' ? '#111511' : '#fbfcf9' }, textColor: theme === 'dark' ? '#8a948b' : '#657166', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: theme === 'dark' ? '#1d241f' : '#e8ece6' }, horzLines: { color: theme === 'dark' ? '#1d241f' : '#e8ece6' } },
      rightPriceScale: { borderColor: theme === 'dark' ? '#273029' : '#dce2da', scaleMargins: { top: 0.13, bottom: 0.14 } },
      timeScale: { borderColor: theme === 'dark' ? '#273029' : '#dce2da', timeVisible: true, secondsVisible: false, rightOffset: 8 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      crosshair: { vertLine: { color: theme === 'dark' ? '#78857b' : '#8b978d', labelBackgroundColor: theme === 'dark' ? '#36443a' : '#56665b' }, horzLine: { color: theme === 'dark' ? '#78857b' : '#8b978d', labelBackgroundColor: theme === 'dark' ? '#36443a' : '#56665b' } }
    })
    const candles = api.addSeries(CandlestickSeries, { upColor: '#5bb889', downColor: '#d5695e', borderUpColor: '#5bb889', borderDownColor: '#d5695e', wickUpColor: '#5bb889', wickDownColor: '#d5695e' })
    const ema20 = api.addSeries(LineSeries, { color: '#e2ba73', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const ema50 = api.addSeries(LineSeries, { color: '#9a8dda', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const vwap = api.addSeries(LineSeries, { color: '#70b8ae', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const volume = api.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false })
    api.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false, borderVisible: false })
    chart.current = api; candleSeries.current = candles
    volumeSeries.current = volume
    lineRefs.current = [ema20, ema50, vwap]
    let frame = 0
    const refreshOverlay = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; setOverlayRevision(value => value + 1) })
    }
    let userViewportUntil = 0
    const noteManualViewport = () => { userViewportUntil = Date.now() + 400 }
    const saveManualViewport = () => { if (Date.now() <= userViewportUntil) storeZoom(api, timeframe) }
    const onWheel = () => { noteManualViewport(); requestAnimationFrame(() => requestAnimationFrame(saveManualViewport)) }
    host.current.addEventListener('wheel', onWheel, { passive: true })
    host.current.addEventListener('pointerdown', noteManualViewport)
    api.timeScale().subscribeVisibleLogicalRangeChange(saveManualViewport)
    api.timeScale().subscribeVisibleLogicalRangeChange(refreshOverlay)
    api.timeScale().subscribeVisibleTimeRangeChange(refreshOverlay)
    const onCrosshairMove = (param: any) => {
      refreshOverlay()
      if (!param.point || !param.time) { setHoverCandle(null); return }
      const value = param.seriesData?.get(candleSeries.current)
      const source = candleData.current.find(c => c.time === Number(param.time))
      if (!value || !source) { setHoverCandle(null); return }
      setHoverCandle({ x: param.point.x, y: param.point.y, time: Number(param.time), open: value.open, high: value.high, low: value.low, close: value.close, volume: source.volume })
    }
    api.subscribeCrosshairMove(onCrosshairMove)
    const ro = new ResizeObserver(([entry]) => { const { width, height } = entry.contentRect; setSize({ width, height }); api.applyOptions({ width, height }) })
    ro.observe(host.current)
    return () => {
      ro.disconnect()
      host.current?.removeEventListener('wheel', onWheel)
      host.current?.removeEventListener('pointerdown', noteManualViewport)
      api.timeScale().unsubscribeVisibleLogicalRangeChange(saveManualViewport)
      api.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverlay)
      api.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverlay)
      api.unsubscribeCrosshairMove(onCrosshairMove)
      if (frame) cancelAnimationFrame(frame)
      api.remove(); chart.current = null
    }
  }, [timeframe])
  useEffect(() => {
    const series = candleSeries.current
    if (!series) return
    series.applyOptions({ autoscaleInfoProvider: (original: () => any) => {
      const info = original()
      if (!info || !showTradeLevels) return info
      return { ...info, priceRange: {
        minValue: Math.min(info.priceRange.minValue, tradeLevels.entry, tradeLevels.stop, tradeLevels.target),
        maxValue: Math.max(info.priceRange.maxValue, tradeLevels.entry, tradeLevels.stop, tradeLevels.target),
      } }
    } })
    chart.current?.priceScale('right').applyOptions({ autoScale: true })
  }, [tradeLevels.entry, tradeLevels.stop, tradeLevels.target, showTradeLevels])
  useEffect(() => {
    if (!chartAction) return
    const api = chart.current
    if (!api) return
    if (chartAction.action === 'fit') { api.timeScale().fitContent(); return }
    const range = api.timeScale().getVisibleLogicalRange()
    if (!range) return
    const width = range.to - range.from
    const nextWidth = width * (chartAction.action === 'zoom-in' ? 0.8 : 1.25)
    api.timeScale().setVisibleLogicalRange({ from: range.to - nextWidth, to: range.to })
    requestAnimationFrame(() => requestAnimationFrame(() => { if (chart.current) storeZoom(api, timeframe) }))
  }, [chartAction, timeframe])
  useEffect(() => {
    chart.current?.applyOptions({
      layout: { background: { color: theme === 'dark' ? '#111511' : '#fbfcf9' }, textColor: theme === 'dark' ? '#8a948b' : '#657166' },
      grid: { vertLines: { color: theme === 'dark' ? '#1d241f' : '#e8ece6' }, horzLines: { color: theme === 'dark' ? '#1d241f' : '#e8ece6' } },
      rightPriceScale: { borderColor: theme === 'dark' ? '#273029' : '#dce2da' }, timeScale: { borderColor: theme === 'dark' ? '#273029' : '#dce2da' }
    })
  }, [theme])
  useEffect(() => {
    if (!chart.current || !candles.length) return
    const series = candleSeries.current
    const previous = previousFeed.current
    const previousRange = chart.current.timeScale().getVisibleLogicalRange()
    const nextBar = candles.length > 1 && candles.at(-2)!.time === previous?.lastTime
    const sameBar = candles.at(-1)!.time === previous?.lastTime
    const sameHistoryStart = previous?.firstTime === candles[0].time
    const incremental = previous?.timeframe === timeframe && sameHistoryStart && (nextBar || sameBar)
    const bar = candles.at(-1)!
    const volumeBar = { time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? '#5bb88966' : '#d5695e66' }
    if (incremental) {
      series.update({ ...bar, time: bar.time as UTCTimestamp })
      volumeSeries.current?.update(volumeBar)
    } else {
      series.setData(candles.map(c => ({ ...c, time: c.time as UTCTimestamp })))
      volumeSeries.current?.setData(candles.map(c => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#5bb88966' : '#d5695e66' })))
      if (previous?.timeframe !== timeframe) chart.current.timeScale().fitContent()
      else if (previous && previous.firstTime !== candles[0].time && previousRange) {
        const prependedBars = Math.max(0, candles.length - previous.count)
        if (prependedBars) chart.current.timeScale().setVisibleLogicalRange({ from: previousRange.from + prependedBars, to: previousRange.to + prependedBars })
      }
    }
    previousFeed.current = { timeframe, firstTime: candles[0].time, lastTime: bar.time, count: candles.length }
    // Data and visible range are handled by the overlay series effect below.
  }, [candles, timeframe])
  useEffect(() => {
    if (!focusRequest || focusedRequest.current === focusRequest.nonce || !candles.length || !chart.current) return
    let low = 0, high = candles.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (candles[middle].time < focusRequest.timestamp) low = middle + 1
      else high = middle
    }
    const index = candles[low].time >= focusRequest.timestamp ? low : Math.max(0, low - 1)
    if (!focusRequest.endTimestamp && Math.abs(candles[index].time - focusRequest.timestamp) > 60 * 60 * 24) return
    if (focusRequest.endTimestamp) {
      const endIndex = candles.findIndex(candle => candle.time >= focusRequest.endTimestamp!)
      const end = endIndex >= 0 ? endIndex : candles.length - 1
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - 20), to: Math.min(candles.length - 1, Math.max(index + 20, end + 10)) })
      focusedRequest.current = focusRequest.nonce
      return
    }
    let width = 80
    try {
      const saved = JSON.parse(sessionStorage.getItem(zoomStorageKey(timeframe)) ?? 'null') as { width?: number; at?: number } | null
      if (saved?.width && saved.at && Date.now() - saved.at <= 5 * 60 * 1000) width = Math.min(500, Math.max(20, saved.width))
    } catch { /* Use the default chart window when saved zoom data is unavailable. */ }
    const from = Math.max(0, index - Math.round(width * 0.75))
    chart.current.timeScale().setVisibleLogicalRange({ from, to: Math.min(candles.length - 1, from + width) })
    focusedRequest.current = focusRequest.nonce
  }, [focusRequest, candles, timeframe])
  useEffect(() => {
    if (!snapshotRequest || completedSnapshot.current === snapshotRequest.nonce || !chart.current || !size.width || !size.height || !candles.length) return
    let cancelled = false
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const api = chart.current, svg = overlay.current
      if (cancelled || !api) return
      try {
        const base = api.takeScreenshot(true, false)
        const output = document.createElement('canvas')
        output.width = base.width; output.height = base.height
        const context = output.getContext('2d')
        if (!context) return
        context.drawImage(base, 0, 0)
        if (svg) {
          const image = new Image()
          const clone = svg.cloneNode(true) as SVGSVGElement
          const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
          style.textContent = '.drawing-label{font:9px Segoe UI,Arial,sans-serif;letter-spacing:.2px;paint-order:normal;stroke:none;filter:none;text-shadow:none}'
          clone.insertBefore(style, clone.firstChild)
          const source = new XMLSerializer().serializeToString(clone)
          const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
          const publish = () => { if (!cancelled) { completedSnapshot.current = snapshotRequest.nonce; onSnapshot?.(output.toDataURL('image/png')) }; URL.revokeObjectURL(url) }
          image.onload = () => { if (!cancelled) context.drawImage(image, 0, 0, output.width, output.height); publish() }
          image.onerror = publish
          image.src = url
        } else { completedSnapshot.current = snapshotRequest.nonce; onSnapshot?.(output.toDataURL('image/png')) }
      } catch (error) { console.error('Chart snapshot failed', error) }
    }))
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [snapshotRequest, onSnapshot, size.width, size.height, candles, drawings, tradeLevels])
  // Line-series references are attached once in a separate mount effect.
  const overlay = useRef<SVGSVGElement>(null)
  const lineRefs = useRef<any[]>([])
  useEffect(() => {
    const s = lineRefs.current
    if (!s.length || !candles.length) return
    for (const [idx, period] of [20, 50].entries()) {
      const alpha = 2 / (period + 1)
      let ema = candles[0].close
      s[idx].setData(candles.map((c, i) => { ema = i ? c.close * alpha + ema * (1 - alpha) : c.close; return { time: c.time as UTCTimestamp, value: ema } }))
    }
    s[2].setData(calculateSessionVwap(candles).map(point => ({ time: point.time as UTCTimestamp, value: point.value })))
  }, [candles, timeframe])
  const xFor = (time: number) => chart.current?.timeScale().timeToCoordinate(time as UTCTimestamp)
  const yFor = (price: number) => candleSeries.current?.priceToCoordinate(price)
  const sessionBands: { id: string; label: string; fromIndex: number; toIndex: number; top: number; bottom: number; color: string }[] = []
  const sessionById = new Map<string, typeof sessionBands[number]>()
  const sessionSpecs = [
    { id: 'asia', label: 'ASIA', start: 0, end: 7, color: '#a0a98d' },
    { id: 'london', label: 'LONDON', start: 7, end: 13, color: '#d9aa5e' },
    { id: 'new-york', label: 'NEW YORK', start: 13, end: 20, color: '#8a9388' },
  ]
  candles.forEach((bar, index) => {
    const hour = new Date(bar.time * 1000).getUTCHours()
    const session = sessionSpecs.find(item => hour >= item.start && hour < item.end)
    if (!session) return
    const day = Math.floor(bar.time / 86_400) * 86_400
    const id = `${session.id}-${day}`
    const existing = sessionById.get(id)
    if (existing) {
      existing.toIndex = index + 0.5
      existing.top = Math.max(existing.top, bar.high)
      existing.bottom = Math.min(existing.bottom, bar.low)
    } else {
      const band = { id, label: session.label, fromIndex: index - 0.5, toIndex: index + 0.5, top: bar.high, bottom: bar.low, color: session.color }
      sessionById.set(id, band); sessionBands.push(band)
    }
  })
  const safeDrawings = drawings
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const name = (event.target as SVGElement).closest('[data-trade-level]')?.getAttribute('data-trade-level') as keyof TradeLevels | null
    if (!name || !overlay.current) return
    draggingLevel.current = name
    overlay.current.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!draggingLevel.current || !overlay.current) return
    const rect = overlay.current.getBoundingClientRect()
    const price = candleSeries.current?.coordinateToPrice(event.clientY - rect.top)
    if (price == null || !Number.isFinite(Number(price))) return
    const minGap = Math.max(0.01, Math.abs(tradeLevels.entry) * 0.000001)
    const next = { ...tradeLevels, [draggingLevel.current]: Number(price) }
    if (direction === 'LONG') {
      next.stop = Math.min(next.stop, next.entry - minGap)
      next.target = Math.max(next.target, next.entry + minGap)
      next.entry = Math.min(next.target - minGap, Math.max(next.stop + minGap, next.entry))
    } else {
      next.target = Math.min(next.target, next.entry - minGap)
      next.stop = Math.max(next.stop, next.entry + minGap)
      next.entry = Math.min(next.stop - minGap, Math.max(next.target + minGap, next.entry))
    }
    onTradeLevelsChange?.(next)
  }
  return <div className="chart-wrap" ref={host}>
    <svg ref={overlay} className="drawing-overlay" data-revision={overlayRevision} width={size.width} height={size.height} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { draggingLevel.current = null }} onPointerCancel={() => { draggingLevel.current = null }}>
      {sessionBands.map(session => {
        const x1 = chart.current?.timeScale().logicalToCoordinate(session.fromIndex as any), x2 = chart.current?.timeScale().logicalToCoordinate(session.toIndex as any), y1 = yFor(session.top), y2 = yFor(session.bottom)
        if (x1 == null || x2 == null || y1 == null || y2 == null || x2 <= 0 || x1 >= size.width - 60) return null
        const left = Math.max(0, x1), right = Math.min(size.width - 60, x2)
        return <g key={session.id}><rect x={left} y={Math.min(y1,y2)} width={right - left} height={Math.max(1,Math.abs(y2-y1))} fill={session.color} fillOpacity=".035" stroke={session.color} strokeOpacity=".12"/><line x1={left} x2={left} y1={Math.min(y1,y2)} y2={Math.max(y1,y2)} stroke={session.color} strokeOpacity=".24" strokeDasharray="3 5"/><text x={left + 5} y={Math.min(y1,y2) - 4} className="drawing-label" fill={session.color}>{session.label}</text></g>
      })}
      {safeDrawings.map(d => {
        if (d.kind === 'riskReward') {
          const levels = showTradeLevels ? tradeLevels : d
          const x = xFor(d.time), rightEdge = candles.length ? xFor(candles.at(-1)!.time) : null, entryY = yFor(levels.entry), stopY = yFor(levels.stop), targetY = yFor(levels.target)
          if (x == null || rightEdge == null || entryY == null || stopY == null || targetY == null || rightEdge <= x) return null
          const right = Math.min(size.width - 60, rightEdge), width = right - x
          const rr = Math.abs(levels.target - levels.entry) / Math.max(0.0001, Math.abs(levels.entry - levels.stop))
          const selected = selectedDrawingId === d.id
          const entryColor = theme === 'light' ? '#344236' : '#f2eee5'
          const labelFontSize = Math.min(12, Math.max(8, width / 18))
          const labelX = x + width / 2
          const labelY = Math.min(entryY, targetY) + Math.abs(targetY - entryY) / 2 + labelFontSize / 3
          const ratioColor = theme === 'light' ? '#315c42' : '#e4f4e8'
          const stopColor = theme === 'light' ? '#ad5148' : '#ef897e'
          const targetColor = theme === 'light' ? '#287448' : '#72c99c'
          return <g key={d.id} data-drawing-id={d.id}>
            <rect x={x} y={Math.min(entryY,targetY)} width={width} height={Math.max(1,Math.abs(targetY-entryY))} fill="#57b485" fillOpacity=".22" stroke="none"/>
            <rect x={x} y={Math.min(entryY,stopY)} width={width} height={Math.max(1,Math.abs(stopY-entryY))} fill="#d9685e" fillOpacity=".22" stroke="none"/>
            {([['entry',entryY,entryColor,'ENTRY'],['stop',stopY,stopColor,'STOP'],['target',targetY,targetColor,'TARGET']] as const).map(([name,y,color,label])=><g key={name} data-trade-level={name}><line x1={x} x2={right} y1={y} y2={y} stroke={color} strokeWidth="1.25" opacity=".72"/><text x={x+7} y={y-5} className="drawing-label" fill={color}>{label} · {levels[name].toFixed(2)}</text><rect x={x-5} y={y-8} width="10" height="16" fill="transparent" style={{pointerEvents:'all',cursor:'ns-resize'}}/></g>)}
            <text x={labelX} y={labelY} textAnchor="middle" fill={ratioColor} fontSize={labelFontSize} fontWeight="700">R:R 1:{rr.toFixed(2)}{selected ? ' · SELECTED' : ''}</text>
          </g>
        }
        if (d.kind === 'zone') {
          let endTime = d.to
          if (d.extendRight && d.mitigation) {
            const threshold = d.mitigation.boundary === 'top' ? d.top : d.mitigation.boundary === 'bottom' ? d.bottom : (d.top + d.bottom) / 2
            const startIndex = candles.findIndex(c => c.time >= d.from)
            const mitigated = candles.find((c, index) => index > startIndex && (d.mitigation?.trigger === 'close' ? (d.mitigation.boundary === 'top' ? c.close >= threshold : c.close <= threshold) : c.low <= threshold && c.high >= threshold))
            if (mitigated) endTime = mitigated.time
          }
          const x1 = xFor(d.from), x2 = d.extendRight && endTime === d.to ? size.width - 60 : xFor(endTime), y1 = yFor(d.top), y2 = yFor(d.bottom)
          if (x1 == null || x2 == null || y1 == null || y2 == null) return null
          const selected = selectedDrawingId === d.id
          return <g key={d.id} data-drawing-id={d.id} onClick={() => setSelectedDrawingId(d.id)} style={{ pointerEvents: 'none' }}><rect x={x1} y={Math.min(y1, y2)} width={Math.max(0, x2 - x1)} height={Math.abs(y2 - y1)} fill={d.color} fillOpacity={d.opacity} stroke={d.color} strokeOpacity={selected ? '.95' : '.55'} strokeWidth={selected ? 2 : 1}/><text x={x1 + 6} y={Math.min(y1, y2) - 5} className="drawing-label" fill={d.color}>{d.label}{d.zoneType ? ` · ${d.zoneType.toUpperCase()}` : ''}{selected ? ' · SELECTED' : ''}</text></g>
        }
        if (d.kind === 'path') {
          const points = d.points.map(point => { const x = xFor(point.time), y = yFor(point.price); return x == null || y == null ? null : `${x},${y}` }).filter((point): point is string => point !== null)
          if (points.length < 2) return null
          const [endX, endY] = points.at(-1)!.split(',').map(Number)
          return <g key={d.id} data-drawing-id={d.id} onClick={() => setSelectedDrawingId(d.id)} style={{ pointerEvents: 'none' }}><polyline points={points.join(' ')} fill="none" stroke={d.color} strokeWidth={selectedDrawingId === d.id ? 3 : d.width ?? 1.25} strokeDasharray={d.dashed ? '5 4' : undefined}/><text x={endX + 7} y={endY - 8} className="drawing-label" fill={d.color}>{d.label}{selectedDrawingId === d.id ? ' · SELECTED' : ''}</text></g>
        }
        if (d.kind === 'level') {
          const y = yFor(d.price); if (y == null) return null
          return <g key={d.id} data-drawing-id={d.id} onClick={() => setSelectedDrawingId(d.id)} style={{ pointerEvents: 'none' }}><line x1="0" x2={size.width - 60} y1={y} y2={y} stroke={d.color} strokeDasharray={d.dashed ? '5 4' : undefined} strokeWidth={selectedDrawingId === d.id ? 2.5 : 1}/><text x={size.width - 66} y={y - 5} textAnchor="end" className="drawing-label" fill={d.color}>{d.label}{selectedDrawingId === d.id ? ' · SELECTED' : ''}</text></g>
        }
        const x = xFor(d.time), y = yFor(d.price); if (x == null || y == null) return null
        return <g key={d.id} data-drawing-id={d.id} onClick={() => setSelectedDrawingId(d.id)} style={{ pointerEvents: 'none' }}><circle cx={x} cy={y} r={selectedDrawingId === d.id ? 6 : 4} fill={d.color} stroke="#101310" strokeWidth="2"/><text x={x + 8} y={y - 8} className="drawing-label" fill={d.color}>{d.label}{selectedDrawingId === d.id ? ' · SELECTED' : ''}</text></g>
      })}
      {candles.length > 8 && (() => {
        const end = candles.at(-1)!; const px = yFor(end.close); if (px == null) return null
        return <g><line x1="0" x2={size.width - 60} y1={px} y2={px} stroke="#78c79e" strokeDasharray="3 4" opacity=".55"/><rect x={size.width - 58} y={px - 9} width="58" height="18" fill="#357858"/><text x={size.width - 29} y={px + 4} textAnchor="middle" fill="#effff5" fontSize="10">{end.close.toFixed(2)}</text></g>
      })()}
      {/* Ghost entry and RR preview */}
    </svg>
    {hoverCandle && <div className="candle-hud" style={{ left: hoverCandle.x > size.width - 190 ? hoverCandle.x - 184 : hoverCandle.x + 14, top: hoverCandle.y > size.height - 112 ? hoverCandle.y - 104 : hoverCandle.y + 12 }}>
      <div className="candle-hud-heading"><b>{timeframe} CANDLE</b><span>{new Date(hoverCandle.time * 1000).toLocaleString()}</span></div>
      <div className="candle-hud-grid"><span>O <b>{hoverCandle.open.toFixed(2)}</b></span><span>H <b>{hoverCandle.high.toFixed(2)}</b></span><span>L <b>{hoverCandle.low.toFixed(2)}</b></span><span>C <b>{hoverCandle.close.toFixed(2)}</b></span><span>VOL <b>{hoverCandle.volume.toLocaleString()}</b></span></div>
    </div>}
    <div className="chart-watermark"><span>◉</span> {timeframe} · XAUUSD</div>
  </div>
}
