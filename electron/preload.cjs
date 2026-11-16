const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aurum', {
  analyze: (candles) => ipcRenderer.invoke('engine:analyze', candles),
  saveSettings: (settings) => ipcRenderer.invoke('engine:save-settings', settings),
  getState: () => ipcRenderer.invoke('engine:get-state'),
  closeTrade: (tradeId, exitPrice) => ipcRenderer.invoke('engine:close-trade', tradeId, exitPrice),
  updateTrackedStop: (tradeId, stop) => ipcRenderer.invoke('engine:update-tracked-stop', tradeId, stop),
  forgetTrackedTrade: (tradeId) => ipcRenderer.invoke('engine:forget-tracked-trade', tradeId),
  mt5Connect: () => ipcRenderer.invoke('mt5:connect'),
  mt5StartTerminal: () => ipcRenderer.invoke('mt5:start-terminal'),
  mt5ShowTerminal: () => ipcRenderer.invoke('mt5:show-terminal'),
  mt5Positions: (symbol) => ipcRenderer.invoke('mt5:positions', symbol),
  mt5Candles: (symbol, timeframe, count, startPos) => ipcRenderer.invoke('mt5:candles', symbol, timeframe, count, startPos),
  cacheMt5History: (request) => ipcRenderer.invoke('mt5:cache-history', request),
  mt5Quote: (symbol) => ipcRenderer.invoke('mt5:quote', symbol),
  mt5History: (symbol) => ipcRenderer.invoke('mt5:history', symbol),
  mt5PlaceOrder: (order) => ipcRenderer.invoke('mt5:place-order', order),
  mt5ClosePosition: (ticket) => ipcRenderer.invoke('mt5:close-position', ticket),
  mt5UpdatePositionStop: (ticket, stop) => ipcRenderer.invoke('mt5:update-position-stop', ticket, stop),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    showMain: () => ipcRenderer.send('window:show-main'),
    quit: () => ipcRenderer.send('app:quit')
  },
  markTaken: (signalId, actualEntry, manualOverride) => ipcRenderer.invoke('engine:mark-taken', signalId, actualEntry, manualOverride),
  ping: () => ipcRenderer.invoke('engine:ping'),
  getHistory: (limit) => ipcRenderer.invoke('engine:history', limit),
  runBacktest: (payload) => ipcRenderer.invoke('engine:backtest', payload),
  updateSignal: (signal, notify) => ipcRenderer.invoke('signal:update', signal, notify),
  updateMarket: (market) => ipcRenderer.send('market:update', market),
  setLanView: (enabled) => ipcRenderer.invoke('lan:set-enabled', enabled),
  toggleAlwaysOnTop: () => ipcRenderer.send('window:toggle-topmost'),
  openMiniWindow: () => ipcRenderer.send('mini:open'),
  onEngineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  }
})


