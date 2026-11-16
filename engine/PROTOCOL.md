# Aurum local engine protocol

The Electron main process starts `engine/main.py` with the bundled CPython runtime and communicates over the child's stdin/stdout using one JSON object per line. Stdout is reserved for protocol messages; diagnostics go to stderr. The MT5 connect flow can launch or restore the installed terminal, keep it available for sign-in, retry until the bridge connects, and minimize it after connection. It does not enter credentials. MT5 chart-feed requests read broker candles and the current bid/ask for M5, M15, H1, or H4. The app refreshes those values while connected and uses mock candles only when MT5 is disconnected. Other MT5 commands read open positions and the last 30 days of broker exits, send explicitly confirmed market orders with required SL and TP, and send explicitly confirmed full closes. Aurum does not run while closed; MT5 retains and manages attached server-side SL/TP, and Aurum refreshes positions and broker exit history when open.

## Requests

```json
{"id":"17","command":"ping"}
```

```json
{"id":"18","command":"analyze","candles":[{"time":1794639600,"open":2640.1,"high":2640.4,"low":2639.9,"close":2640.3,"volume":1200}]}
```

```json
{"id":"19","command":"mark_taken","signalId":"A-XAUUSD-1794639900","manualOverride":false}
```

```json
{"id":"20","command":"mt5_candles","symbol":"XAUUSDm","timeframe":"M5","count":220}
{"id":"21","command":"mt5_quote","symbol":"XAUUSDm"}
```

History and backtesting use the same JSON-lines channel:

```json
{"id":"22","command":"history","limit":500}
{"id":"23","command":"backtest","candlesByTimeframe":{"M5":[],"M15":[],"H1":[]},"spread":0.34,"session":"All","excludeNews":true}
```

`time` is a nonnegative Unix timestamp in seconds. Analysis accepts the original M5 `candles` array for compatibility, or `candlesByTimeframe` with `M5`, `M15`, and `H1` candle arrays. Live analysis and caller-supplied candle backtests are limited to 5000 bars per timeframe. MT5 range backtests load directly from broker/cache and accept up to 1,200,000 bars per timeframe (the date range remains limited to ten years). Timestamps must be unique, OHLC values finite and internally consistent, and volume nonnegative. An optional `spread` value is supplied in instrument price units. MT5 candle responses also include per-bar spread in price units where the broker provides it. Setup A and Setup B use M5 candles; Setup C uses M15 entries with H1 EMA50 bias. The Windows installer ships CPython and the MT5/NumPy modules under `resources/engine`.

## Responses

On startup (engine version 0.2.0):

```json
{"type":"status","status":"ready","engine":"python","version":"0.1.0"}
```

Ping:

```json
{"id":"17","type":"pong","status":"ready"}
```

Analysis:

```json
{"id":"18","type":"analysis","status":"ready","signals":[],"candlesAnalyzed":600}
```

Marking a manual trade as taken updates the signal row in SQLite:

```json
{"id":"19","type":"trade_marked","status":"ready","updated":true}
```

An analysis signal includes setup, direction, entry, stop, target, risk dollars, estimated lot size, R multiple, confidence, rationale, eligibility, an optional block reason, and a typed `drawings` array. Risk-blocked candidates are persisted and returned so they remain visible for review; they cannot be marked as taken. Estimated lot size uses the configured risk percentage and contract size in ounces per lot. Drawing coordinates use Unix seconds and instrument price. Supported objects are zones (`from`, `to`, `top`, `bottom`) with `zoneType` values for ranges, FVGs, order blocks, supply, and demand; levels (`time`, `price`); markers (`time`, `price`); and paths (`points` of time/price pairs). Extended zones can carry mitigation rules (`trigger` and `boundary`) so the renderer stops extending when price fills the zone.

## Setup A rules

For each UTC London (07:00) and New York (13:00) open, use the first three M5 bars as the 15-minute opening range. During the following two hours, record the first candle that closes beyond the range with a directional body and at least 1.25 times recent average tick volume. Stop distance is the greater of the opposite range edge and ATR(14); target is 1.5R. The setup is a signal only.

## Setup B rules

Use the UTC 00:00–07:00 M5 candles to define Asia high/low. After 07:00, require a wick beyond an Asia extreme and a close back inside. Wait for a close through a recent M5 swing, identify a three-candle fair-value gap after the structure shift, then require a later candle to revisit the gap and close in the reversal direction. The stop is beyond the sweep extreme with ATR(14) as a minimum distance; target is 2R. The signal includes the Asia range, swept level, sweep and MSS markers, and FVG zone.

## Setup C rules

Use H1 EMA50 for directional bias. On M15, require a pullback touching EMA20/session VWAP and a rejection close in the bias direction. Place the stop beyond the recent four-bar swing with an ATR buffer; target the prior 20-bar high/low when it offers at least 1R, otherwise use 1.5R. At most one Setup C signal is generated per UTC day.

Each setup can be independently enabled in settings. Disabled setups are neither generated nor returned in the active analysis response; existing records remain stored. Spread, open-position count, daily eligible-signal count, consecutive losses, and configured news blackouts determine eligibility. Optional position tracking defaults off and can be enabled in settings. Setup B payloads include the Asia range, swept level, sweep/MSS markers, FVG, optional order block, and the sweep-to-entry structure path. Setup C payloads include the H1 bias, pullback band, M15 rejection marker, and trend path.

## Local persistence

The MT5 bridge modules are vendored under `engine/vendor`, and the embeddable CPython runtime is under `engine/python-runtime`. The bridge is read-only except for explicit user-confirmed market entry and full-close actions; it never modifies an existing position's SL/TP.

Signals are inserted idempotently into `signals` in `aurum.sqlite3` under Electron's per-user application data directory. Re-analysis returns the stored signals in the requested candle time window, so changing chart timeframes does not duplicate signal history.

The history request returns stored signals joined to optional tracked trades. Backtesting is non-persistent and uses enabled setup rules, requires at least one of H1/H4 to align or lean toward the trade direction, treats M15 as context rather than a hard veto, and uses next-bar-open entries, historical per-candle MT5 spreads when present (otherwise the supplied spread), spread-aware bid/ask exits, UTC session selection, and saved UTC news blackout windows. The configured maximum spread blocks new entries above the limit. If stop and target are both reached in one candle the stop is counted first; positions still open at the end are marked to market and excluded from win rate. Synthetic mock backtest results are not evidence of profitability. `mark_taken` accepts `manualOverride:true` for an explicit user-confirmed local tracking override; it does not place or override an MT5 broker order and still validates entry/stop/target geometry.

Desktop delivery includes native signal notifications while Aurum is running, a tray menu, the Ctrl+Shift+T mark-signal shortcut, and an always-on-top mini signal window. A read-only HTTP view on port 55173 is disabled by default and can be enabled in account settings; it exposes only the latest signal and quote.
