import { useEffect, useState } from 'react'
import type { Mt5OrderHistory, Mt5OrderRecord } from '../global'

type Props = { connected: boolean }
const formatMoney = (value: number, currency: string) => `${value < 0 ? '-' : ''}${currency} ${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const formatTime = (value: number) => new Date(value * 1000).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })

function Mt5Orders({ connected }: Props) {
  const [history, setHistory] = useState<Mt5OrderHistory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await window.aurum?.mt5OrderHistory()
      if (result) { setHistory(result); setPage(1) }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  useEffect(() => { if (connected) void refresh() }, [connected])

  const rows = history?.records ?? []
  const shownRows = rows.slice((page - 1) * pageSize, page * pageSize)
  const stats = history?.stats
  const account = history?.account
  const resultLabel = (record: Mt5OrderRecord) => record.outcome === 'win' ? 'WIN' : record.outcome === 'loss' ? 'LOSS' : 'BREAKEVEN'

  return <section className="records-page mt5-orders-page">
    <header>
      <div><span className="eyebrow">BROKER FILLS · AURUM ORDER TICKET</span><h2>MT5 order records</h2></div>
      <button onClick={() => void refresh()} disabled={!connected || busy}>{busy ? 'Loading…' : 'Refresh'}</button>
    </header>
    {account && <div className="mt5-orders-account">Account {account.login} · {account.server} · {account.currency} · All MT5 history available to this terminal</div>}
    {!connected && <p className="mt5-orders-message">Connect MT5 to load completed orders sent from Aurum.</p>}
    {error && <p className="mt5-orders-error">Could not load MT5 order history: {error}</p>}
    {stats && <div className="mt5-order-metrics">
      <article><small>WIN RATE</small><b>{stats.winRate}%</b><span>{stats.wins} wins / {stats.losses} losses</span></article>
      <article><small>CLOSED POSITIONS</small><b>{stats.closed}</b><span>{stats.breakeven} break-even · {stats.open} open</span></article>
      <article><small>NET CLOSED P&amp;L</small><b className={stats.netProfit >= 0 ? 'positive' : 'negative'}>{formatMoney(stats.netProfit, account?.currency ?? '')}</b><span>Includes profit, commission, swap, and fees</span></article>
    </div>}
    {stats && <div className="mt5-orders-note">Win rate counts completed Aurum-linked positions with a non-zero net result. Partial exits are grouped into one position. Results use the history MT5 makes available for this account.</div>}
    {shownRows.length > 0 ? <div className="mt5-order-records">
      <div className="mt5-order-row mt5-order-heading"><b>Side / symbol</b><b>Volume</b><b>Entry → exit</b><b>Opened / closed</b><b>Result</b></div>
      {shownRows.map(record => <article className="mt5-order-row" key={record.positionId}>
        <span><b className={`signal-feed-direction ${record.direction.toLowerCase()}`}>{record.direction === 'LONG' ? 'BUY' : 'SELL'}</b><strong>{record.symbol}</strong><small>Position {record.positionId} · {record.reason}</small></span>
        <span>{record.volume.toFixed(2)} lots</span>
        <span>{record.entryPrice.toFixed(2)} → {record.exitPrice.toFixed(2)}</span>
        <span>{formatTime(record.openedAt)}<small>{formatTime(record.closedAt)}</small></span>
        <span className={`mt5-order-result ${record.outcome}`}>{resultLabel(record)}<small>{formatMoney(record.netProfit, account?.currency ?? '')}</small></span>
      </article>)}
      {rows.length > pageSize && <nav className="pagination" aria-label="MT5 order record pages"><button disabled={page === 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button><span>Page {page} of {Math.ceil(rows.length / pageSize)} · {history?.totalRecords} records</span><button disabled={page >= Math.ceil(rows.length / pageSize)} onClick={() => setPage(value => Math.min(Math.ceil(rows.length / pageSize), value + 1))}>Next</button></nav>}
    </div> : stats && !busy && <p className="mt5-orders-message">No completed orders sent by Aurum were found in the broker history for this account.</p>}
  </section>
}

export default Mt5Orders
