const { app, BrowserWindow, shell, ipcMain, Menu, dialog, Tray, nativeImage, Notification, globalShortcut } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')

process.on('uncaughtException', error => console.error('[fatal] uncaught main-process error:', error))
process.on('unhandledRejection', error => console.error('[fatal] unhandled main-process rejection:', error))

let engine = null
let engineState = 'starting'
let restartTimer = null
let restartDelay = 1000
let nextRequestId = 1
let shuttingDown = false
let stdoutBuffer = ''
let healthTimer = null
const pending = new Map()
if (process.platform === 'win32') app.setAppUserModelId('com.aurum.gold-signal-desk')
let tray = null
let mainWindow = null
let miniWindow = null
let latestSignal = null
let latestMarket = null
let alwaysOnTop = false
let lanServer = null
let lanStatus = { enabled: false }

function sendEngineEvent(payload) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('engine:event', payload)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
}

function toggleAlwaysOnTop(value = !alwaysOnTop) {
  alwaysOnTop = !!value
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating')
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setAlwaysOnTop(true, 'floating')
  sendEngineEvent({ type: 'always-on-top', enabled: alwaysOnTop })
  if (tray) updateTrayMenu()
  return alwaysOnTop
}

function updateTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Aurum', click: showMainWindow },
    { label: 'Show MetaTrader 5', click: () => requestEngine('mt5_show_terminal') },
    { label: 'Mini signal window', click: createMiniWindow },
    { type: 'separator' },
    { label: 'Always on top', type: 'checkbox', checked: alwaysOnTop, click: item => toggleAlwaysOnTop(item.checked) },
    { type: 'separator' },
    { label: 'Quit Aurum', click: () => app.quit() }
  ]))
}

function buildTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'aurum.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error(`Could not load tray icon: ${iconPath}`)
  return icon
}

function createTray() {
  if (tray) return tray
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Aurum Gold Signal Desk')
  updateTrayMenu()
  tray.on('double-click', showMainWindow)
  return tray
}

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) { miniWindow.show(); miniWindow.focus(); return miniWindow }
  miniWindow = new BrowserWindow({ width: 320, height: 204, minWidth: 290, minHeight: 190, maxWidth: 420, maxHeight: 260, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#111511', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  miniWindow.on('closed', () => { miniWindow = null })
  miniWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  miniWindow.loadFile(path.join(__dirname, 'mini.html')).then(() => {
    if (latestSignal && miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('engine:event', { type: 'mini-signal', signal: latestSignal })
  }).catch(error => console.warn('[mini] failed to load:', error.message))
  return miniWindow
}

function publishSignal(signal, notify = false) {
  if (!signal || !['LONG', 'SHORT'].includes(signal.direction)) return
  latestSignal = { id: String(signal.id || ''), direction: signal.direction === 'LONG' ? 'BUY' : 'SELL', setupName: String(signal.setupName || 'Signal'), confidence: Number(signal.confidence || 0), eligible: signal.eligible !== false, timestamp: Number(signal.timestamp || Date.now()/1000), entry: Number(signal.entry || 0), stop: Number(signal.stop || 0), target: Number(signal.target || 0), session: String(signal.session || '') }
  sendEngineEvent({ type: 'mini-signal', signal: latestSignal })
  if (notify && Notification.isSupported()) {
    const notification = new Notification({ title: `Aurum signal · ${latestSignal.direction}`, body: `${latestSignal.setupName} · Entry ${latestSignal.entry.toFixed(2)} · SL ${latestSignal.stop.toFixed(2)} · TP ${latestSignal.target.toFixed(2)}` })
    notification.on('click', showMainWindow); notification.show()
  }
}

function updateMarket(value) {
  if (!value || !Number.isFinite(value.bid) || !Number.isFinite(value.ask)) return
  latestMarket = { symbol: String(value.symbol || 'XAUUSD'), bid: Number(value.bid), ask: Number(value.ask), time: Number(value.time || Date.now()/1000) }
}

function setLanViewEnabled(enabled) {
  if (!enabled) return new Promise(resolve => {
    if (!lanServer) { lanStatus = { enabled: false }; sendEngineEvent({ type: 'lan-status', ...lanStatus }); resolve(lanStatus); return }
    const server = lanServer; lanServer = null
    server.close(() => { lanStatus = { enabled: false }; sendEngineEvent({ type: 'lan-status', ...lanStatus }); resolve(lanStatus) })
  })
  if (lanServer) return Promise.resolve(lanStatus)
  return new Promise(resolve => {
    const page = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aurum read-only</title>
<style>
body{margin:0;padding:20px;background:#111511;color:#e6e9e2;font:14px Segoe UI,Arial}main{max-width:520px;margin:auto}small{color:#98a292}section{margin-top:14px;padding:14px;background:#1b201a;border:1px solid #384034;border-radius:8px}.side{font-size:22px;font-weight:700;color:#d9bd7a}.levels{display:flex;justify-content:space-between;margin-top:12px;color:#b6c0b1}button{margin-top:14px;padding:10px 14px;border:1px solid #64704f;border-radius:6px;background:#273321;color:#e6e9e2;font-weight:600}#voiceStatus{margin-left:9px;font-size:12px;color:#98a292}
</style>
<main><h2>Aurum · Read-only signals</h2><small>Live view · refreshes every 3 seconds · no trade actions</small><br><button id="voiceButton" type="button">Enable voice alerts</button><span id="voiceStatus">Tap once to allow spoken alerts on this device</span><section id="signal">Waiting for signal…</section><section id="market">Waiting for quote…</section></main>
<script>
let lastSignalId=null;let voiceEnabled=localStorage.getItem('aurumVoiceAlerts')==='true';
const voiceButton=document.getElementById('voiceButton');const voiceStatus=document.getElementById('voiceStatus');
function setVoiceState(enabled){voiceEnabled=enabled;localStorage.setItem('aurumVoiceAlerts',String(enabled));voiceButton.textContent=enabled?'Voice alerts enabled · tap to disable':'Enable voice alerts';voiceStatus.textContent=enabled?'Spoken alerts are on for this device':'Tap once to allow spoken alerts on this device'}
voiceButton.addEventListener('click',()=>{if(voiceEnabled){setVoiceState(false);return}if(!('speechSynthesis'in window)){voiceStatus.textContent='Speech alerts are not supported in this browser';return}setVoiceState(true);const ready=new SpeechSynthesisUtterance('Voice alerts enabled');ready.lang='en-US';speechSynthesis.speak(ready)});
setVoiceState(voiceEnabled);
async function refresh(){try{const d=await(await fetch('/api')).json();const s=d.signal,m=d.market;document.getElementById('signal').textContent=s? s.direction+' · '+s.setupName+' · '+s.session+' | Entry '+s.entry.toFixed(2)+' · SL '+s.stop.toFixed(2)+' · TP '+s.target.toFixed(2)+(s.eligible?' · READY':' · BLOCKED'):'No signal yet';document.getElementById('market').textContent=m?m.symbol+' · Bid '+m.bid.toFixed(2)+' / Ask '+m.ask.toFixed(2)+' · spread '+(m.ask-m.bid).toFixed(2):'No quote yet';if(s&&lastSignalId!==null&&s.id!==lastSignalId&&s.eligible&&Date.now()/1000-s.timestamp<180&&voiceEnabled){const alert=new SpeechSynthesisUtterance('New '+s.direction.toLowerCase()+' signal for XAUUSD');alert.lang='en-US';speechSynthesis.speak(alert)}if(s)lastSignalId=s.id}catch(e){document.getElementById('market').textContent='Aurum is offline'}}refresh();setInterval(refresh,3000)
</script>`
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('Read-only view'); return }
      if (req.url === '/api') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'null' }); res.end(JSON.stringify({ signal: latestSignal, market: latestMarket })); return }
      if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self' 'unsafe-inline'" }); res.end(page); return }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found')
    })
    lanServer = server
    server.once('error', error => { lanServer = null; lanStatus = { enabled: false, error: `LAN view could not start: ${error.message}` }; sendEngineEvent({ type: 'lan-status', ...lanStatus }); resolve(lanStatus) })
    server.listen(55173, '0.0.0.0', () => {
      const urls = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:55173`)
      lanStatus = { enabled: true, urls }
      sendEngineEvent({ type: 'lan-status', ...lanStatus }); resolve(lanStatus)
    })
  })
}

function setEngineState(status, details = {}) {
  engineState = status
  sendEngineEvent({ type: 'status', status, ...details })
}

function engineDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine')
    : path.join(__dirname, '../engine')
}

function pythonCommand() {
  const bundledPython = path.join(engineDirectory(), 'python-runtime', 'python.exe')
  const candidates = [
    ...(app.isPackaged ? [] : [process.env.AURUM_PYTHON]),
    bundledPython,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Python', 'bin', 'python.exe'),
    'python'
  ].filter(Boolean)
  return candidates.find(candidate => candidate === 'python' || fs.existsSync(candidate)) || bundledPython
}

function rejectPending(reason) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer)
    request.reject(new Error(reason))
    pending.delete(id)
  }
}

function handleEngineLine(line) {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch (error) { console.warn('[engine] invalid JSON line:', line, error); return }
  if (message.type === 'status') {
    restartDelay = 1000
    setEngineState(message.status, { engine: message.engine, version: message.version })
    return
  }
  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id)
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.type === 'error') request.reject(new Error(message.error || 'Python engine request failed'))
    else request.resolve(message)
  }
}

function startEngine() {
  if (shuttingDown || engine || !app.isReady()) return
  const enginePath = path.join(engineDirectory(), 'main.py')
  if (!fs.existsSync(enginePath)) { setEngineState('missing'); return }
  const dbPath = path.join(app.getPath('userData'), 'aurum.sqlite3')
  const command = pythonCommand()
  stdoutBuffer = ''
  setEngineState('starting')
  try {
    engine = spawn(command, [enginePath, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    engine = null
    setEngineState('error', { message: String(error) })
    scheduleEngineRestart()
    return
  }
  engine.stdout.setEncoding('utf8')
  engine.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) handleEngineLine(line)
  })
  engine.stderr.setEncoding('utf8')
  engine.stderr.on('data', chunk => console.warn(`[engine] ${chunk.trimEnd()}`))
  engine.on('error', error => {
    console.error('[engine] spawn error:', error)
    setEngineState('error', { message: error.message })
  })
  engine.on('exit', (code, signal) => {
    engine = null
    rejectPending(`Python engine exited (${code ?? signal ?? 'unknown'})`)
    if (!shuttingDown) {
      setEngineState('offline', { exitCode: code })
      scheduleEngineRestart()
    }
  })
}

function scheduleEngineRestart() {
  if (restartTimer || shuttingDown) return
  const delay = restartDelay
  restartDelay = Math.min(restartDelay * 2, 15_000)
  restartTimer = setTimeout(() => { restartTimer = null; startEngine() }, delay)
}

function requestEngine(command, payload = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const send = () => {
      if (!engine || engineState !== 'ready') {
        if (Date.now() - startedAt >= 10_000) return reject(new Error(`Signal engine did not become ready (${engineState})`))
        setTimeout(send, 100)
        return
      }
      const child = engine
      const id = String(nextRequestId++)
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Signal engine response timed out')) }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, error => {
          if (!error) return
          clearTimeout(timer); pending.delete(id); reject(error)
        })
      } catch (error) {
        clearTimeout(timer); pending.delete(id); reject(error)
      }
    }
    send()
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1520, height: 960, minWidth: 1120, minHeight: 720,
    backgroundColor: '#101310', title: 'Aurum — Gold Signal Desk',
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  mainWindow = win
  win.setAlwaysOnTop(alwaysOnTop, 'floating')
  win.on('close', event => { if (tray && !shuttingDown) { event.preventDefault(); win.hide() } })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  console.log('[window] BrowserWindow created')
  win.webContents.on('did-fail-load', (_event, code, description, url) => console.error('[window] did-fail-load', code, description, url))
  win.webContents.on('render-process-gone', (_event, details) => console.error('[window] renderer exited', details))
  win.webContents.on('console-message', (_event, level, message, line, source) => console.error(`[renderer:${level}] ${message} (${source}:${line})`))
  if (process.env.AURUM_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  const devUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged && 'http://127.0.0.1:5191')
  if (devUrl) win.loadURL(devUrl).catch(error => {
    console.warn('[window] dev server unavailable; loading built app:', error.message)
    win.loadFile(path.join(__dirname, '../web-dist/index.html')).catch(fileError => console.error('[window] built app failed to load:', fileError))
  })
  else win.loadFile(path.join(__dirname, '../web-dist/index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  return win
}
function buildAppMenu() {
  const template = [
    { label: 'Aurum', submenu: [{ label: 'About Aurum Gold Signal Desk', click: () => sendEngineEvent({ type: 'menu', command: 'about' }) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Refresh market data', accelerator: 'CmdOrCtrl+R', click: () => sendEngineEvent({ type: 'menu', command: 'refresh' }) }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendEngineEvent({ type: 'menu', command: 'settings' }) }, { type: 'separator' }, { role: 'close' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { label: 'Always on top', type: 'checkbox', checked: alwaysOnTop, click: item => toggleAlwaysOnTop(item.checked) }, { label: 'Open mini signal window', click: createMiniWindow }, { type: 'separator' }, { label: 'Toggle light / dark theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendEngineEvent({ type: 'menu', command: 'theme' }) }, { role: 'reload' }, { role: 'toggleDevTools', visible: !app.isPackaged }] },
    { label: 'Trade', submenu: [{ label: 'Mark latest signal as taken', click: () => sendEngineEvent({ type: 'menu', command: 'mark-latest' }) }, { label: 'Open risk settings', click: () => sendEngineEvent({ type: 'menu', command: 'settings' }) }] },
    { label: 'Help', submenu: [{ label: 'Signal-only workflow', click: () => sendEngineEvent({ type: 'menu', command: 'about' }) }, { label: 'Protocol documentation', click: () => shell.openPath(path.join(__dirname, '../engine/PROTOCOL.md')) }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
ipcMain.handle('signal:update', (_event, signal, notify) => { publishSignal(signal, !!notify); return { updated: true } })
ipcMain.on('market:update', (_event, market) => updateMarket(market))
ipcMain.handle('lan:set-enabled', (_event, enabled) => setLanViewEnabled(!!enabled))
ipcMain.on('window:toggle-topmost', () => toggleAlwaysOnTop())
ipcMain.on('window:show-main', showMainWindow)
ipcMain.on('mini:open', createMiniWindow)
ipcMain.on('app:quit', () => app.quit())
ipcMain.handle('engine:analyze', async (_event, candles) => {
	if (!Array.isArray(candles) && (!candles || !Array.isArray(candles.M5))) throw new TypeError('Expected M5 candles or timeframe candle sets')
	return Array.isArray(candles)
		? requestEngine('analyze', { candles, spread: 0.34 })
		: requestEngine('analyze', { candlesByTimeframe: { M5: candles.M5, M15: candles.M15 || [], H1: candles.H1 || [], H4: candles.H4 || [] }, spread: Number.isFinite(candles.spread) ? candles.spread : 0.34 })
})
ipcMain.handle('engine:save-settings', (_event, settings) => requestEngine('save_settings', { settings }))
ipcMain.handle('engine:get-state', () => requestEngine('get_state'))
ipcMain.handle('engine:close-trade', (_event, tradeId, exitPrice) => requestEngine('close_trade', { tradeId, exitPrice }))
ipcMain.handle('engine:update-tracked-stop', (_event, tradeId, stop) => requestEngine('update_tracked_stop', { tradeId, stop }))
ipcMain.handle('engine:forget-tracked-trade', (_event, tradeId) => requestEngine('forget_tracked_trade', { tradeId }))
ipcMain.handle('engine:mark-taken', (_event, signalId, actualEntry, manualOverride) => requestEngine('mark_taken', { signalId: String(signalId), actualEntry, manualOverride: Boolean(manualOverride) }))
ipcMain.handle('engine:ping', () => requestEngine('ping'))
ipcMain.handle('engine:history', (_event, limit) => requestEngine('history', { limit }))
ipcMain.handle('engine:backtest', (_event, payload) => requestEngine('backtest', payload, 600_000))
ipcMain.handle('mt5:cache-history', (_event, request) => requestEngine('cache_mt5_history', request, 600_000))
ipcMain.handle('mt5:connect', () => requestEngine('mt5_connect', {}, 75_000))
ipcMain.handle('mt5:start-terminal', () => requestEngine('mt5_start_terminal'))
ipcMain.handle('mt5:show-terminal', () => requestEngine('mt5_show_terminal'))
ipcMain.handle('mt5:positions', (_event, symbol) => requestEngine('mt5_positions', { symbol }, 20_000))
ipcMain.handle('mt5:candles', (_event, symbol, timeframe, count, startPos) => requestEngine('mt5_candles', { symbol, timeframe, count, startPos }, 30_000))
ipcMain.handle('mt5:quote', (_event, symbol) => requestEngine('mt5_quote', { symbol }, 20_000))
ipcMain.handle('mt5:history', (_event, symbol) => requestEngine('mt5_history', { symbol }, 20_000))
ipcMain.handle('mt5:place-order', (_event, order) => requestEngine('mt5_place_order', order))
ipcMain.handle('mt5:close-position', (_event, ticket) => requestEngine('mt5_close_position', { ticket }))
ipcMain.handle('mt5:update-position-stop', (_event, ticket, stop) => requestEngine('mt5_update_position_stop', { ticket, stop }))

app.whenReady().then(() => {
  console.log('[app] ready')
  Menu.setApplicationMenu(Menu.buildFromTemplate([]))
  createTray()
  createWindow()
  if (!globalShortcut.register('CommandOrControl+Shift+T', () => sendEngineEvent({ type: 'menu', command: 'mark-latest' }))) console.warn('[hotkey] Ctrl+Shift+T is unavailable')
  startEngine()
  healthTimer = setInterval(() => {
    if (engineState !== 'ready') return
    requestEngine('ping').catch(error => {
      console.warn('[engine] health check failed:', error.message)
      if (engine) engine.kill()
    })
  }, 10_000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
}).catch(error => {
  console.error('[fatal] Aurum failed to start:', error)
  if (app.isReady()) dialog.showErrorBox('Aurum failed to start', String(error?.stack || error))
})
ipcMain.on('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:toggle-maximize', event => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize(); else win.maximize()
})
ipcMain.on('window:close', event => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === mainWindow && tray) win.hide()
  else win?.close()
})
app.on('window-all-closed', () => { if (!tray && process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  globalShortcut.unregisterAll()
  if (lanServer) { lanServer.close(); lanServer = null }
  if (tray) { tray.destroy(); tray = null }
  if (!shuttingDown) {
    // Give Python EOF so it can flush SQLite and close normally before Electron exits.
    const child = engine
    if (child) {
      event.preventDefault()
      shuttingDown = true
      if (restartTimer) clearTimeout(restartTimer)
      if (healthTimer) clearInterval(healthTimer)
      rejectPending('Application is shutting down')
      const forceExit = setTimeout(() => { try { child.kill() } catch {} }, 2000)
      forceExit.unref()
      child.once('exit', () => { clearTimeout(forceExit); engine = null; app.quit() })
      engine = null
      child.stdin.end()
      return
    }
  }
  shuttingDown = true
  if (restartTimer) clearTimeout(restartTimer)
  if (healthTimer) clearInterval(healthTimer)
  rejectPending('Application is shutting down')
  if (engine) { const child = engine; engine = null; child.kill() }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })


