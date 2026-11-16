"""Local JSON-lines signal engine and opt-in MetaTrader 5 bridge."""
from __future__ import annotations

import json
import sqlite3
import sys
import traceback
import argparse
import math
import os
import subprocess
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import fmean, median
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

DAY_SECONDS = 86_400
TIMEFRAME_SECONDS = 300  # Setup A is evaluated on M5 candles.
DEFAULT_SETTINGS = {"startCapital": 12500.0, "riskPercent": 1.0, "spreadLimit": 0.4, "contractSizeOz": 100.0, "maxSignalsPerDay": 3, "maxOpenPositions": 1, "maxConsecutiveLosses": 2, "positionTrackingEnabled": False, "lanViewEnabled": False, "newsEvents": [], "enabledSetups": {"A": True, "B": True, "C": True}}
ENGINE_VERSION = "0.2.0"


def mt5_module():
    if mt5 is None:
        raise RuntimeError("MetaTrader5 Python package is missing. Install engine/requirements-mt5.txt using the same Python that runs Aurum.")
    return mt5


def mt5_terminal_path():
    terminal_path = os.environ.get("AURUM_MT5_TERMINAL")
    if not terminal_path and os.name == "nt":
        candidates = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "MetaTrader 5" / "terminal64.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "MetaTrader 5" / "terminal64.exe",
        ]
        terminal_path = next((str(candidate) for candidate in candidates if candidate.is_file()), None)
    return terminal_path


def mt5_windows_action(action: str) -> bool:
    if os.name != "nt":
        return False
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    enum_callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    enum_windows = user32.EnumWindows
    enum_windows.argtypes = [enum_callback_type, wintypes.LPARAM]
    enum_windows.restype = wintypes.BOOL
    get_pid = user32.GetWindowThreadProcessId
    get_pid.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    get_pid.restype = wintypes.DWORD
    show_window = user32.ShowWindow
    show_window.argtypes = [wintypes.HWND, ctypes.c_int]
    is_window_visible = user32.IsWindowVisible
    is_window_visible.argtypes = [wintypes.HWND]
    is_window_visible.restype = wintypes.BOOL
    set_foreground = user32.SetForegroundWindow
    set_foreground.argtypes = [wintypes.HWND]
    set_foreground.restype = wintypes.BOOL
    query_image = kernel32.QueryFullProcessImageNameW
    query_image.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    query_image.restype = wintypes.BOOL
    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    terminal_path = mt5_terminal_path()
    target = os.path.normcase(os.path.abspath(terminal_path)) if terminal_path else None
    found = False

    def visit(hwnd, _param):
        nonlocal found
        if not is_window_visible(hwnd) and action != "restore":
            return True
        pid = wintypes.DWORD()
        get_pid(hwnd, ctypes.byref(pid))
        handle = open_process(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return True
        try:
            image = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(image))
            if not query_image(handle, 0, image, ctypes.byref(size)):
                return True
            actual = os.path.normcase(os.path.abspath(image.value))
            if (target and actual == target) or os.path.basename(actual).lower() == "terminal64.exe":
                show_window(hwnd, 9 if action == "restore" else 0 if action == "hide" else 6)  # SW_RESTORE / SW_HIDE / SW_MINIMIZE
                if action == "restore":
                    set_foreground(hwnd)
                found = True
                return False
        finally:
            close_handle(handle)
        return True

    callback = enum_callback_type(visit)
    enum_windows(callback, 0)
    return found


def mt5_process_running() -> bool:
    if os.name != "nt":
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
        ]

    snapshot = kernel32.CreateToolhelp32Snapshot
    snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    snapshot.restype = wintypes.HANDLE
    first, following = kernel32.Process32FirstW, kernel32.Process32NextW
    first.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    following.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    first.restype = following.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    handle = snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if handle == wintypes.HANDLE(-1).value:
        return False
    entry = ProcessEntry()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        more = first(handle, ctypes.byref(entry))
        while more:
            if entry.szExeFile.lower() == "terminal64.exe":
                return True
            more = following(handle, ctypes.byref(entry))
    finally:
        close_handle(handle)
    return False


def mt5_start_terminal():
    terminal_path = mt5_terminal_path()
    if not terminal_path or not Path(terminal_path).is_file():
        return {"started": False, "error": "MT5 terminal64.exe was not found. Set AURUM_MT5_TERMINAL to its installed path."}
    running = mt5_process_running()
    if not running:
        flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        subprocess.Popen([terminal_path], cwd=str(Path(terminal_path).parent), close_fds=True, creationflags=flags)
    else:
        mt5_windows_action("restore")
    return {"started": not running, "alreadyRunning": running, "terminalPath": terminal_path}


def mt5_initialize(bridge):
    terminal_path = mt5_terminal_path()
    initialized = bridge.initialize(path=terminal_path, timeout=60_000) if terminal_path else bridge.initialize(timeout=60_000)
    if not initialized:
        return False, str(bridge.last_error())
    return True, None


def mt5_connect():
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        return {"connected": False, "error": error}
    terminal = bridge.terminal_info()
    account = bridge.account_info()
    if terminal is None or account is None:
        return {"connected": False, "error": str(bridge.last_error())}
    mt5_windows_action("hide")
    account_mode = {bridge.ACCOUNT_TRADE_MODE_DEMO: "DEMO", bridge.ACCOUNT_TRADE_MODE_CONTEST: "CONTEST", bridge.ACCOUNT_TRADE_MODE_REAL: "REAL"}.get(account.trade_mode, "UNKNOWN")
    return {"connected": True, "terminalPath": terminal.path, "terminalVersion": list(bridge.version()),
            "server": account.server, "currency": account.currency, "accountMode": account_mode,
            "tradeAllowed": bool(account.trade_allowed and terminal.trade_allowed),
            "balance": float(account.balance), "equity": float(account.equity), "margin": float(account.margin),
            "freeMargin": float(account.margin_free)}


def mt5_positions(symbol=None):
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        raise RuntimeError(f"MT5 connection unavailable: {error}")
    rows = bridge.positions_get(symbol=symbol) if symbol else bridge.positions_get()
    if rows is None:
        raise RuntimeError(f"Could not read MT5 positions: {bridge.last_error()}")
    return [{"ticket": int(p.ticket), "symbol": p.symbol, "direction": "LONG" if p.type == bridge.POSITION_TYPE_BUY else "SHORT",
             "volume": float(p.volume), "entry": float(p.price_open), "stop": float(p.sl), "target": float(p.tp),
             "price": float(p.price_current), "profit": float(p.profit), "openedAt": int(p.time), "comment": p.comment}
            for p in rows]


def mt5_candle_rows(rows, symbol_info):
    spread_point = float(symbol_info.point) if symbol_info and symbol_info.point else 0.0
    candles = []
    for row in rows:
        candle = {"time": int(row["time"]), "open": float(row["open"]), "high": float(row["high"]),
                  "low": float(row["low"]), "close": float(row["close"]), "volume": float(row["tick_volume"])}
        if "spread" in (getattr(getattr(row, "dtype", None), "names", None) or ()) and spread_point:
            candle["spread"] = max(0.0, float(row["spread"]) * spread_point)
        candles.append(candle)
    return sorted(candles, key=lambda candle: candle["time"])


def mt5_candles(symbol, timeframe, count=220, start_pos=0):
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        raise RuntimeError(f"MT5 connection unavailable: {error}")
    frames = {"M5": bridge.TIMEFRAME_M5, "M15": bridge.TIMEFRAME_M15,
              "H1": bridge.TIMEFRAME_H1, "H4": bridge.TIMEFRAME_H4}
    frame = str(timeframe).upper()
    if frame not in frames:
        raise ValueError("Unsupported chart timeframe")
    symbol = str(symbol or "").strip()
    if not symbol:
        raise ValueError("MT5 symbol is required")
    if not bridge.symbol_select(symbol, True):
        raise RuntimeError(f"MT5 could not select symbol {symbol}: {bridge.last_error()}")
    symbol_info = bridge.symbol_info(symbol)
    spread_point = float(symbol_info.point) if symbol_info and symbol_info.point else 0.0
    count = max(20, min(5000, int(count)))
    start_pos = max(0, min(2_000_000, int(start_pos)))
    rows = bridge.copy_rates_from_pos(symbol, frames[frame], start_pos, count)
    if rows is None:
        raise RuntimeError(f"Could not read {frame} chart data for {symbol}: {bridge.last_error()}")
    return {"symbol": symbol, "timeframe": frame, "candles": mt5_candle_rows(rows, symbol_info)}


def mt5_candles_range(symbol, timeframe, start_date, end_date, connection=None, server=None):
    frame = str(timeframe).upper()
    frames = {"M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4"}
    if frame not in frames:
        raise ValueError("Unsupported chart timeframe")
    symbol = str(symbol or "").strip()
    if not symbol:
        raise ValueError("MT5 symbol is required")
    try:
        start = datetime.strptime(str(start_date), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_day = datetime.strptime(str(end_date), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("History dates must use YYYY-MM-DD") from exc
    if end_day < start:
        raise ValueError("History end date must be on or after the start date")
    if (end_day - start).days > 3682:
        raise ValueError("A single history range cannot exceed ten years")
    end = end_day + timedelta(days=1) - timedelta(seconds=1)
    server_key = str(server or "unknown").strip().lower()
    cached = []
    if connection is not None:
        cached = [{"time": int(row[0]), "open": float(row[1]), "high": float(row[2]), "low": float(row[3]),
                   "close": float(row[4]), "volume": float(row[5]), "spread": float(row[6])}
                  for row in connection.execute("SELECT time,open,high,low,close,volume,spread FROM historical_candles WHERE broker=? AND symbol=? AND timeframe=? AND time BETWEEN ? AND ? ORDER BY time",
                                                (server_key, symbol, frame, int(start.timestamp()), int(end.timestamp())))]
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        if cached:
            return {"symbol": symbol, "timeframe": frame, "candles": cached, "cacheBars": len(cached)}
        raise RuntimeError(f"MT5 connection unavailable and no cached history exists: {error}")
    if not bridge.symbol_select(symbol, True):
        if cached:
            return {"symbol": symbol, "timeframe": frame, "candles": cached, "cacheBars": len(cached)}
        raise RuntimeError(f"MT5 could not select symbol {symbol}: {bridge.last_error()}")
    symbol_info = bridge.symbol_info(symbol)
    rows = bridge.copy_rates_range(symbol, getattr(bridge, frames[frame]), start, end)
    if rows is None:
        if cached:
            return {"symbol": symbol, "timeframe": frame, "candles": cached, "cacheBars": len(cached)}
        raise RuntimeError(f"Could not read {frame} history for {symbol}: {bridge.last_error()}")
    fresh = mt5_candle_rows(rows, symbol_info)
    if cached:
        merged = {bar["time"]: bar for bar in cached}
        merged.update({bar["time"]: bar for bar in fresh})
        candles = [merged[stamp] for stamp in sorted(merged)]
    else:
        candles = fresh
    if connection is not None and candles:
        account = bridge.account_info()
        server_key = str(server or (account.server if account else "unknown")).strip().lower()
        insert_sql = "INSERT OR REPLACE INTO historical_candles(broker,symbol,timeframe,time,open,high,low,close,volume,spread) VALUES(?,?,?,?,?,?,?,?,?,?)"
        for offset in range(0, len(candles), 10_000):
            batch = candles[offset:offset + 10_000]
            connection.executemany(insert_sql, [(server_key, symbol, frame, int(bar["time"]), float(bar["open"]), float(bar["high"]), float(bar["low"]),
                                                 float(bar["close"]), float(bar.get("volume", 0)), float(bar.get("spread", 0))) for bar in batch])
        connection.commit()
    return {"symbol": symbol, "timeframe": frame, "candles": candles, "cacheBars": len(cached)}


def cache_mt5_history(connection, symbol, timeframe, start_date, end_date, server=None):
    result = mt5_candles_range(symbol, timeframe, start_date, end_date, connection, server)
    bars = result["candles"]
    first = bars[0]["time"] if bars else None
    last = bars[-1]["time"] if bars else None
    return {"symbol": result["symbol"], "timeframe": result["timeframe"], "bars": len(bars),
            "cachedBars": result.get("cacheBars", 0), "newBars": max(0, len(bars) - result.get("cacheBars", 0)),
            "availableStart": datetime.fromtimestamp(first, timezone.utc).strftime("%Y-%m-%d") if first else None,
            "availableEnd": datetime.fromtimestamp(last, timezone.utc).strftime("%Y-%m-%d") if last else None}


def mt5_quote(symbol):
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        raise RuntimeError(f"MT5 connection unavailable: {error}")
    symbol = str(symbol or "").strip()
    if not symbol or not bridge.symbol_select(symbol, True):
        raise RuntimeError(f"MT5 could not select symbol {symbol}: {bridge.last_error()}")
    tick = bridge.symbol_info_tick(symbol)
    if tick is None or not tick.bid or not tick.ask:
        raise RuntimeError(f"No current bid/ask for {symbol}: {bridge.last_error()}")
    return {"symbol": symbol, "bid": float(tick.bid), "ask": float(tick.ask), "time": int(tick.time)}


def mt5_history(symbol=None):
    bridge = mt5_module()
    initialized, error = mt5_initialize(bridge)
    if not initialized:
        raise RuntimeError(f"MT5 connection unavailable: {error}")
    from datetime import timedelta
    end = datetime.now(timezone.utc)
    deals = bridge.history_deals_get(end - timedelta(days=30), end)
    if deals is None:
        raise RuntimeError(f"Could not read MT5 deal history: {bridge.last_error()}")
    exits = []
    for deal in deals:
        if symbol and deal.symbol != symbol:
            continue
        if deal.entry not in (bridge.DEAL_ENTRY_OUT, bridge.DEAL_ENTRY_OUT_BY, bridge.DEAL_ENTRY_INOUT):
            continue
        reason = "STOP LOSS" if deal.reason == bridge.DEAL_REASON_SL else "TAKE PROFIT" if deal.reason == bridge.DEAL_REASON_TP else "MANUAL / OTHER"
        exits.append({"ticket": int(deal.ticket), "positionId": int(deal.position_id), "symbol": deal.symbol,
                      "direction": "LONG" if deal.type == bridge.DEAL_TYPE_SELL else "SHORT", "volume": float(deal.volume),
                      "price": float(deal.price), "profit": float(deal.profit), "time": int(deal.time), "reason": reason})
    return sorted(exits, key=lambda item: item["time"], reverse=True)[:20]


def mt5_place_order(request):
    bridge = mt5_module()
    connection = mt5_connect()
    if not connection.get("connected"):
        raise RuntimeError(connection.get("error", "MT5 connection unavailable"))
    if not connection.get("tradeAllowed"):
        raise RuntimeError("MT5 terminal or account has algorithmic trading disabled")
    symbol = str(request.get("symbol", "")).strip()
    direction = str(request.get("direction", "")).upper()
    volume = float(request.get("volume", 0))
    stop, target = float(request.get("stop", 0)), float(request.get("target", 0))
    if not symbol or direction not in ("LONG", "SHORT") or not all(math.isfinite(x) for x in (volume, stop, target)):
        raise ValueError("Symbol, direction, volume, stop loss, and take profit are required")
    if volume <= 0 or stop <= 0 or target <= 0:
        raise ValueError("Volume, stop loss, and take profit must be positive")
    if not bridge.symbol_select(symbol, True):
        raise RuntimeError(f"MT5 could not select symbol {symbol}: {bridge.last_error()}")
    info, tick = bridge.symbol_info(symbol), bridge.symbol_info_tick(symbol)
    if info is None or tick is None or not tick.bid or not tick.ask:
        raise RuntimeError(f"No current bid/ask for {symbol}")
    if not info.trade_mode:
        raise RuntimeError(f"{symbol} is not available for trading")
    if info.trade_mode == bridge.SYMBOL_TRADE_MODE_CLOSEONLY:
        raise RuntimeError(f"{symbol} is close-only")
    if info.trade_mode == bridge.SYMBOL_TRADE_MODE_LONGONLY and direction != "LONG":
        raise RuntimeError(f"{symbol} currently allows long trades only")
    if info.trade_mode == bridge.SYMBOL_TRADE_MODE_SHORTONLY and direction != "SHORT":
        raise RuntimeError(f"{symbol} currently allows short trades only")
    price = float(tick.ask if direction == "LONG" else tick.bid)
    if direction == "LONG" and not (stop < price < target):
        raise ValueError("For a buy, stop loss must be below the live ask and take profit above it")
    if direction == "SHORT" and not (target < price < stop):
        raise ValueError("For a sell, take profit must be below the live bid and stop loss above it")
    if volume < info.volume_min or volume > info.volume_max:
        raise ValueError(f"Volume must be between {info.volume_min} and {info.volume_max} lots")
    steps = round(volume / info.volume_step)
    if abs(volume - steps * info.volume_step) > 1e-8:
        raise ValueError(f"Volume must use broker step {info.volume_step}")
    if abs(price - stop) < info.trade_stops_level * info.point or abs(target - price) < info.trade_stops_level * info.point:
        raise ValueError(f"SL/TP must be at least {info.trade_stops_level} points from market price")
    order_type = bridge.ORDER_TYPE_BUY if direction == "LONG" else bridge.ORDER_TYPE_SELL
    filling = bridge.ORDER_FILLING_FOK if int(info.filling_mode) & 1 else bridge.ORDER_FILLING_IOC
    payload = {"action": bridge.TRADE_ACTION_DEAL, "symbol": symbol, "volume": volume, "type": order_type, "price": price,
               "sl": round(stop, info.digits), "tp": round(target, info.digits), "deviation": 30, "magic": 261115,
               "comment": "Aurum manual", "type_time": bridge.ORDER_TIME_GTC, "type_filling": filling}
    check = bridge.order_check(payload)
    if check is None or check.retcode != 0:
        raise RuntimeError(f"MT5 order check rejected request: {getattr(check, 'comment', bridge.last_error())}")
    result = bridge.order_send(payload)
    if result is None:
        raise RuntimeError(f"MT5 order send failed: {bridge.last_error()}")
    if result.retcode not in (bridge.TRADE_RETCODE_DONE, bridge.TRADE_RETCODE_DONE_PARTIAL, bridge.TRADE_RETCODE_PLACED):
        return {"accepted": False, "retcode": int(result.retcode), "message": result.comment}
    return {"accepted": True, "ticket": int(result.order), "deal": int(result.deal), "symbol": symbol,
            "direction": direction, "volume": float(result.volume), "price": float(result.price), "stop": payload["sl"], "target": payload["tp"], "message": result.comment}


def mt5_close_position(ticket):
    bridge = mt5_module()
    connection = mt5_connect()
    if not connection.get("connected") or not connection.get("tradeAllowed"):
        raise RuntimeError(connection.get("error", "MT5 trading is not allowed by terminal/account settings"))
    positions = bridge.positions_get(ticket=int(ticket))
    if not positions:
        raise RuntimeError("MT5 position is no longer open")
    position = positions[0]
    tick = bridge.symbol_info_tick(position.symbol)
    if tick is None:
        raise RuntimeError(f"No current quote for {position.symbol}")
    is_long = position.type == bridge.POSITION_TYPE_BUY
    payload = {"action": bridge.TRADE_ACTION_DEAL, "symbol": position.symbol, "position": int(position.ticket),
               "volume": float(position.volume), "type": bridge.ORDER_TYPE_SELL if is_long else bridge.ORDER_TYPE_BUY,
               "price": float(tick.bid if is_long else tick.ask), "deviation": 30, "magic": 261115,
               "comment": "Aurum close", "type_time": bridge.ORDER_TIME_GTC,
               "type_filling": bridge.ORDER_FILLING_FOK if int(bridge.symbol_info(position.symbol).filling_mode) & 1 else bridge.ORDER_FILLING_IOC}
    check = bridge.order_check(payload)
    if check is None or check.retcode != 0:
        raise RuntimeError(f"MT5 close check rejected request: {getattr(check, 'comment', bridge.last_error())}")
    result = bridge.order_send(payload)
    if result is None or result.retcode not in (bridge.TRADE_RETCODE_DONE, bridge.TRADE_RETCODE_DONE_PARTIAL):
        return {"accepted": False, "ticket": int(position.ticket), "message": getattr(result, "comment", str(bridge.last_error()))}
    return {"accepted": True, "ticket": int(position.ticket), "deal": int(result.deal), "price": float(result.price), "message": result.comment}


def mt5_update_position_stop(request):
    bridge = mt5_module()
    connection = mt5_connect()
    if not connection.get("connected") or not connection.get("tradeAllowed"):
        raise RuntimeError(connection.get("error", "MT5 trading is not allowed by terminal/account settings"))
    ticket = int(request.get("ticket", 0))
    stop = float(request.get("stop", 0))
    if ticket <= 0 or not math.isfinite(stop) or stop <= 0:
        raise ValueError("A valid position ticket and positive stop loss are required")
    positions = bridge.positions_get(ticket=ticket)
    if not positions:
        raise RuntimeError("MT5 position is no longer open")
    position = positions[0]
    info, tick = bridge.symbol_info(position.symbol), bridge.symbol_info_tick(position.symbol)
    if info is None or tick is None:
        raise RuntimeError(f"Could not read current price or symbol rules for {position.symbol}")
    is_long = position.type == bridge.POSITION_TYPE_BUY
    market = float(tick.bid if is_long else tick.ask)
    min_distance = float(info.trade_stops_level) * float(info.point)
    if (is_long and stop >= market - min_distance) or (not is_long and stop <= market + min_distance):
        raise ValueError(f"Stop loss must be at least {info.trade_stops_level} points beyond the current market price")
    payload = {"action": bridge.TRADE_ACTION_SLTP, "symbol": position.symbol, "position": ticket,
               "sl": round(stop, info.digits), "tp": float(position.tp), "magic": 261115, "comment": "Aurum SL update"}
    check = bridge.order_check(payload)
    if check is None or check.retcode != 0:
        raise RuntimeError(f"MT5 stop update check rejected request: {getattr(check, 'comment', bridge.last_error())}")
    result = bridge.order_send(payload)
    if result is None or result.retcode != bridge.TRADE_RETCODE_DONE:
        raise RuntimeError(f"MT5 stop update failed: {getattr(result, 'comment', bridge.last_error())}")
    return {"accepted": True, "ticket": ticket, "stop": payload["sl"], "target": payload["tp"], "message": result.comment}


def validate_candles(value, timeframe: str, limit: int = 5000) -> list[dict]:
    if not isinstance(value, list):
        raise ValueError(f"{timeframe} candles must be an array")
    if len(value) > limit:
        raise ValueError(f"{timeframe} candle limit is {limit:,}")
    result = []
    previous_time = -1
    for candle in sorted(value, key=lambda item: item.get("time", -1) if isinstance(item, dict) else -1):
        if not isinstance(candle, dict):
            raise ValueError(f"{timeframe} candle must be an object")
        try:
            timestamp = int(candle["time"])
            opening, high, low, close = (float(candle[key]) for key in ("open", "high", "low", "close"))
            volume = float(candle.get("volume", 0))
            spread = float(candle["spread"]) if candle.get("spread") is not None else None
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"Malformed {timeframe} candle: {error}") from error
        values = (opening, high, low, close, volume) + ((spread,) if spread is not None else ())
        if timestamp < 0 or not all(math.isfinite(number) for number in values) or volume < 0 or (spread is not None and spread < 0):
            raise ValueError(f"{timeframe} candle has invalid numeric values")
        if timestamp <= previous_time:
            raise ValueError(f"{timeframe} candle timestamps must be unique")
        if high < max(opening, close, low) or low > min(opening, close, high):
            raise ValueError(f"{timeframe} candle high/low do not contain its open and close")
        bar = {"time": timestamp, "open": opening, "high": high, "low": low, "close": close, "volume": volume}
        if spread is not None: bar["spread"] = spread
        result.append(bar)
        previous_time = timestamp
    return result


def atr(candles: list[dict], end_index: int, period: int = 14) -> float:
    ranges = []
    start = max(0, end_index - period + 1)
    for index in range(start, end_index + 1):
        bar = candles[index]
        previous_close = candles[index - 1]["close"] if index else bar["open"]
        ranges.append(max(bar["high"] - bar["low"], abs(bar["high"] - previous_close), abs(bar["low"] - previous_close)))
    return fmean(ranges) if ranges else 0.0


def opening_range_signals(candles: list[dict]) -> list[dict]:
    """Find confirmed London/NY opening-range breaks with close and tick-volume confirmation."""
    candles = sorted(candles, key=lambda candle: candle["time"])
    signals = []
    bars_by_day = {}
    for index, candle in enumerate(candles):
        bars_by_day.setdefault(int(candle["time"] // DAY_SECONDS) * DAY_SECONDS, []).append((index, candle))
    days = sorted(bars_by_day)
    for session_name, session_hour in (("London", 7), ("New York", 13)):
        for day in days:
            start_time = day + session_hour * 3600
            session_bars = bars_by_day[day]
            range_bars = [(i, bar) for i, bar in session_bars if start_time <= bar["time"] < start_time + 15 * 60]
            if len(range_bars) != 3:
                continue
            range_high = max(bar["high"] for _, bar in range_bars)
            range_low = min(bar["low"] for _, bar in range_bars)
            search_bars = [(i, bar) for i, bar in session_bars if start_time + 15 * 60 <= bar["time"] < start_time + 2 * 3600]
            for index, bar in search_bars:
                baseline = [c["volume"] for c in candles[max(0, index - 20):index] if c["time"] >= start_time - 20 * TIMEFRAME_SECONDS]
                average_volume = fmean(baseline) if baseline else 0
                if average_volume <= 0 or bar["volume"] < average_volume * 1.25:
                    continue
                side = None
                if bar["close"] > range_high and bar["close"] > bar["open"]:
                    side = "LONG"
                elif bar["close"] < range_low and bar["close"] < bar["open"]:
                    side = "SHORT"
                if not side:
                    continue

                current_atr = atr(candles, index)
                entry = float(bar["close"])
                if side == "LONG":
                    stop = min(range_low, entry - current_atr)
                    risk_distance = entry - stop
                    target = entry + 1.5 * risk_distance
                    marker_price = float(bar["low"])
                    marker_shape = "arrowUp"
                else:
                    stop = max(range_high, entry + current_atr)
                    risk_distance = stop - entry
                    target = entry - 1.5 * risk_distance
                    marker_price = float(bar["high"])
                    marker_shape = "arrowDown"
                if risk_distance <= 0:
                    continue
                signal_id = f"A-XAUUSD-{int(bar['time'])}"
                signal_time = int(bar["time"])
                signal = {
                    "id": signal_id,
                    "timestamp": signal_time,
                    "isoTime": datetime.fromtimestamp(signal_time, timezone.utc).isoformat(),
                    "setup": "A",
                    "setupName": "Opening Range Breakout",
                    "session": session_name,
                    "direction": side,
                    "entry": round(entry, 2),
                    "stop": round(float(stop), 2),
                    "target": round(float(target), 2),
                    "riskDollars": 0.0,
                    "rMultiple": 1.5,
                    "atr": round(current_atr, 4),
                    "volumeRatio": round(bar["volume"] / average_volume, 2),
                    "confidence": min(0.95, round(0.65 + (bar["volume"] / average_volume - 1.25) * 0.15, 2)),
                    "rationale": f"{session_name} opening range broken with a strong close and {bar['volume'] / average_volume:.1f}× average tick volume.",
                    "drawings": [
                        {"kind": "zone", "id": f"or-{signal_id}", "label": f"{session_name.upper()} OPENING RANGE", "from": start_time, "to": start_time + 15 * 60, "top": range_high, "bottom": range_low, "color": "#d5ad63", "opacity": 0.14, "zoneType": "openingRange"},
                        {"kind": "level", "id": f"or-high-{signal_id}", "label": "RANGE HIGH", "time": start_time, "price": range_high, "color": "#d5ad63", "dashed": True},
                        {"kind": "level", "id": f"or-low-{signal_id}", "label": "RANGE LOW", "time": start_time, "price": range_low, "color": "#d5ad63", "dashed": True},
                        {"kind": "marker", "id": f"break-{signal_id}", "label": f"{session_name.upper()} BREAKOUT", "time": signal_time, "price": marker_price, "color": "#75c896", "shape": marker_shape},
                    ],
                }
                signals.append(signal)
    return sorted(signals, key=lambda signal: signal["timestamp"])


def ema_values(candles: list[dict], period: int) -> list[float]:
    if not candles:
        return []
    alpha = 2 / (period + 1)
    values = [float(candles[0]["close"])]
    for bar in candles[1:]:
        values.append(float(bar["close"]) * alpha + values[-1] * (1 - alpha))
    return values


def timeframe_direction(candles: list[dict], timestamp: int, duration: int, period: int) -> str | None:
    """Return the latest completed candle's direction versus its EMA at timestamp."""
    closed = [bar for bar in candles if int(bar["time"]) + duration <= timestamp]
    if len(closed) < period:
        return None
    close = float(closed[-1]["close"])
    ema = ema_values(closed, period)[-1]
    return "LONG" if close > ema else "SHORT" if close < ema else None


def timeframe_tendency(candles: list[dict], timestamp: int, duration: int, period: int) -> tuple[str, str]:
    """Describe directional state; a nearby rising/falling EMA counts as an emerging bias."""
    closed = [bar for bar in candles if int(bar["time"]) + duration <= timestamp]
    if len(closed) < period + 5:
        return "NEUTRAL", "WAIT"
    emas = ema_values(closed, period)
    close = float(closed[-1]["close"])
    ema = emas[-1]
    slope = ema - emas[-5]
    volatility = atr(closed, len(closed) - 1)
    distance = close - ema
    side = "BUY" if distance > 0 else "SELL" if distance < 0 else "NEUTRAL"
    if abs(distance) <= volatility * 0.12 and abs(slope) <= volatility * 0.08:
        return "NEUTRAL", "NEUTRAL"
    if side == "NEUTRAL" and abs(slope) > volatility * 0.08:
        side = "BUY" if slope > 0 else "SELL"
    if side == "NEUTRAL":
        return side, "NEUTRAL"
    slope_side = "BUY" if slope > 0 else "SELL" if slope < 0 else "NEUTRAL"
    if abs(distance) <= volatility * 0.35 and slope_side == side:
        return side, f"LEAN_{side}"
    if slope_side != side and abs(distance) <= volatility * 0.2:
        return side, "WAIT"
    if abs(distance) >= volatility * 0.8 and slope_side == side:
        return side, f"STRONG_{side}"
    return side, side


def apply_timeframe_alignment(signals: list[dict], m5: list[dict], m15: list[dict], h1: list[dict], h4: list[dict], as_of: int | None = None) -> list[dict]:
    """Prefer higher-timeframe direction; M15 is contextual, not a hard veto."""
    m5 = sorted(m5, key=lambda bar: bar["time"])
    m15 = sorted(m15, key=lambda bar: bar["time"])
    h1 = sorted(h1, key=lambda bar: bar["time"])
    h4 = sorted(h4, key=lambda bar: bar["time"])
    m5_ema20 = ema_values(m5, 20)
    aligned = []
    accepted_sessions = set()
    for signal in signals:
        direction = signal["direction"]
        if signal["setup"] == "C":
            # Setup C confirms on M15; wait up to 90 minutes for an M5 entry trigger.
            setup_confirmed_at = int(signal["timestamp"]) + 15 * 60
            trigger = None
            for index, bar in enumerate(m5):
                close_time = int(bar["time"]) + 5 * 60
                if int(bar["time"]) < setup_confirmed_at or index < 19:
                    continue
                if int(bar["time"]) > setup_confirmed_at + 90 * 60:
                    break
                triggered = bar["close"] > bar["open"] and bar["close"] > m5_ema20[index] if direction == "LONG" else bar["close"] < bar["open"] and bar["close"] < m5_ema20[index]
                if triggered:
                    trigger = (bar, close_time)
                    break
            if not trigger:
                continue
            bar, signal_time = trigger
            entry = float(bar["close"])
            stop = float(signal["stop"])
            if (direction == "LONG" and stop >= entry) or (direction == "SHORT" and stop <= entry):
                continue
            risk = abs(entry - stop)
            multiple = max(1.0, float(signal["rMultiple"]))
            signal["entry"] = round(entry, 2)
            signal["target"] = round(entry + risk * multiple if direction == "LONG" else entry - risk * multiple, 2)
            signal["timestamp"] = int(bar["time"])
            signal["isoTime"] = datetime.fromtimestamp(int(bar["time"]), timezone.utc).isoformat()
            signal["rMultiple"] = round(multiple, 2)
            signal["drawings"].append({"kind": "marker", "id": f"m5-trigger-{signal['id']}", "label": "M5 ENTRY TRIGGER", "time": int(bar["time"]), "price": entry, "color": "#75c896" if direction == "LONG" else "#d5695e", "shape": "arrowUp" if direction == "LONG" else "arrowDown"})
        else:
            signal_time = int(signal["timestamp"]) + 5 * 60

        if as_of is not None and signal_time > as_of:
            continue

        h1_direction, h1_state = timeframe_tendency(h1, signal_time, 60 * 60, 50)
        h4_direction, h4_state = timeframe_tendency(h4, signal_time, 4 * 60 * 60, 50)
        m15_direction, m15_state = timeframe_tendency(m15, signal_time, 15 * 60, 20)
        signal_bias = "BUY" if direction == "LONG" else "SELL"
        supports_direction = signal_bias in (h1_direction if h1_state != "WAIT" else "", h4_direction if h4_state != "WAIT" else "")
        session_key = signal.get("session", "") if signal["setup"] == "A" else ""
        daily_key = (signal["setup"], int(signal["timestamp"]) // DAY_SECONDS, session_key)
        if daily_key in accepted_sessions:
            continue
        signal["timeframeBiases"] = {"M15": m15_direction, "H1": h1_direction, "H4": h4_direction}
        signal["timeframeStates"] = {"M15": m15_state, "H1": h1_state, "H4": h4_state}
        signal["alignmentEligible"] = supports_direction
        signal["alignmentBlockReason"] = None if supports_direction else "No higher timeframe currently supports this direction"
        signal["m5TriggerDirection"] = "BUY" if direction == "LONG" else "SELL"
        signal["rationale"] += (" At least one higher timeframe aligns or is leaning in this direction; M15 is shown as context and does not veto the setup."
                                if supports_direction else " No higher timeframe currently supports this direction; this candidate is blocked unless you choose a manual override.")
        if not signal["id"].endswith("-MTF"):
            signal["id"] += "-MTF"
        accepted_sessions.add(daily_key)
        aligned.append(signal)
    return aligned


def liquidity_sweep_signals(candles: list[dict]) -> list[dict]:
    """Setup B: Asia/prior-day liquidity sweep, M5 structure shift, then FVG retrace."""
    candles = sorted(candles, key=lambda candle: candle["time"])
    signals = []
    bars_by_day = {}
    for index, bar in enumerate(candles):
        bars_by_day.setdefault(int(bar["time"] // DAY_SECONDS) * DAY_SECONDS, []).append((index, bar))
    days = sorted(bars_by_day)
    for day in days:
        session_bars = bars_by_day[day]
        asia = [bar for _, bar in session_bars if bar["time"] < day + 7 * 3600]
        if len(asia) < 12:
            continue
        asia_high = max(bar["high"] for bar in asia)
        asia_low = min(bar["low"] for bar in asia)
        day_bars = [(index, bar) for index, bar in session_bars if day + 7 * 3600 <= bar["time"] < day + 20 * 3600]
        for index, sweep in day_bars:
            bullish = sweep["low"] < asia_low and sweep["close"] > asia_low
            bearish = sweep["high"] > asia_high and sweep["close"] < asia_high
            if not (bullish or bearish):
                continue
            direction = "LONG" if bullish else "SHORT"
            # Require a close through a recent confirmed swing after the sweep.
            swing = None
            mss_index = None
            for j in range(max(index + 1, 2), min(index + 13, len(candles) - 2)):
                history = candles[max(0, j - 12):j]
                if bullish:
                    pivots = [history[k]["high"] for k in range(1, len(history) - 1) if history[k]["high"] > history[k - 1]["high"] and history[k]["high"] >= history[k + 1]["high"]]
                    candidate = max(pivots[-3:]) if pivots else None
                    if candidate is not None and candles[j]["close"] > candidate and candles[j]["close"] > candles[j]["open"]:
                        swing, mss_index = candidate, j
                        break
                else:
                    pivots = [history[k]["low"] for k in range(1, len(history) - 1) if history[k]["low"] < history[k - 1]["low"] and history[k]["low"] <= history[k + 1]["low"]]
                    candidate = min(pivots[-3:]) if pivots else None
                    if candidate is not None and candles[j]["close"] < candidate and candles[j]["close"] < candles[j]["open"]:
                        swing, mss_index = candidate, j
                        break
            if mss_index is None:
                continue
            # Find displacement imbalance after the MSS and wait for a later candle to revisit it.
            fvg = None
            for j in range(max(index + 2, mss_index), min(index + 10, len(candles))):
                left, right = candles[j - 2], candles[j]
                if bullish and right["low"] > left["high"]:
                    fvg = (float(right["low"]), float(left["high"]), j)
                    break
                if bearish and right["high"] < left["low"]:
                    fvg = (float(left["low"]), float(right["high"]), j)
                    break
            if not fvg:
                continue
            zone_top, zone_bottom, fvg_index = fvg
            retrace = None
            for j in range(fvg_index + 1, min(fvg_index + 13, len(candles))):
                bar = candles[j]
                touched = bar["low"] <= zone_top and bar["high"] >= zone_bottom
                confirmed = bar["close"] > bar["open"] if bullish else bar["close"] < bar["open"]
                if touched and confirmed:
                    retrace = (j, bar)
                    break
            if not retrace:
                continue
            signal_index, bar = retrace
            current_atr = atr(candles, signal_index)
            entry = float(bar["close"])
            stop = min(float(sweep["low"]), entry - current_atr) if bullish else max(float(sweep["high"]), entry + current_atr)
            risk_distance = abs(entry - stop)
            if risk_distance <= 0:
                continue
            target = entry + 2 * risk_distance if bullish else entry - 2 * risk_distance
            signal_time = int(bar["time"])
            signal_id = f"B-XAUUSD-{signal_time}"
            level = asia_low if bullish else asia_high
            order_block = next((candles[j] for j in range(mss_index - 1, index, -1)
                                if ((candles[j]["close"] < candles[j]["open"]) == bullish)), None)
            drawings = [
                {"kind": "zone", "id": f"asia-{signal_id}", "label": "ASIA RANGE", "from": asia[0]["time"], "to": day + 7 * 3600, "top": asia_high, "bottom": asia_low, "color": "#839084", "opacity": 0.08, "zoneType": "asiaRange"},
                {"kind": "level", "id": f"swept-{signal_id}", "label": f"ASIA {'LOW' if bullish else 'HIGH'} · SWEPT", "time": int(sweep["time"]), "price": level, "color": "#dda45a", "dashed": True},
                {"kind": "marker", "id": f"sweep-{signal_id}", "label": "LIQUIDITY SWEEP", "time": int(sweep["time"]), "price": float(sweep["low"] if bullish else sweep["high"]), "color": "#e0a75a", "shape": "arrowUp" if bullish else "arrowDown"},
                {"kind": "marker", "id": f"mss-{signal_id}", "label": "MSS", "time": int(candles[mss_index]["time"]), "price": float(swing), "color": "#8dd8b2", "shape": "arrowUp" if bullish else "arrowDown"},
                {"kind": "zone", "id": f"fvg-{signal_id}", "label": f"{'BULLISH' if bullish else 'BEARISH'} FVG", "from": int(candles[fvg_index]["time"]), "to": signal_time, "top": zone_top, "bottom": zone_bottom, "color": "#71b99a" if bullish else "#d77b71", "opacity": 0.22, "zoneType": "fvg", "extendRight": True, "mitigation": {"trigger": "touch", "boundary": "bottom" if bullish else "top"}},
                {"kind": "path", "id": f"structure-{signal_id}", "label": "SWEEP → MSS → ENTRY", "points": [{"time": int(sweep["time"]), "price": float(sweep["low"] if bullish else sweep["high"])}, {"time": int(candles[mss_index]["time"]), "price": float(swing)}, {"time": signal_time, "price": entry}], "color": "#8dd8b2" if bullish else "#d77b71", "width": 1.5},
            ]
            if order_block:
                drawings.append({"kind": "zone", "id": f"ob-{signal_id}", "label": f"{'BULLISH' if bullish else 'BEARISH'} ORDER BLOCK", "from": int(order_block["time"]), "to": signal_time, "top": float(order_block["high"]), "bottom": float(order_block["low"]), "color": "#75c896" if bullish else "#d5695e", "opacity": 0.12, "zoneType": "orderBlock", "extendRight": True, "mitigation": {"trigger": "touch", "boundary": "bottom" if bullish else "top"}})
            signals.append({
                "id": signal_id, "timestamp": signal_time,
                "isoTime": datetime.fromtimestamp(signal_time, timezone.utc).isoformat(),
                "setup": "B", "setupName": "Liquidity Sweep + MSS", "session": "London / New York",
                "direction": direction, "entry": round(entry, 2), "stop": round(stop, 2),
                "target": round(target, 2), "riskDollars": 0.0, "rMultiple": 2.0,
                "atr": round(current_atr, 4), "volumeRatio": 1.0, "confidence": 0.82,
                "rationale": f"Price swept the Asia {'low' if bullish else 'high'}, closed back inside, broke M5 structure, and retraced into a {'bullish' if bullish else 'bearish'} FVG.",
                "drawings": drawings,
            })
    return sorted(signals, key=lambda signal: signal["timestamp"])


def trend_pullback_signals(m15: list[dict], h1: list[dict]) -> list[dict]:
    """Setup C: H1 EMA50 bias with an M15 EMA20/session VWAP rejection."""
    m15 = sorted(m15, key=lambda candle: candle["time"])
    h1 = sorted(h1, key=lambda candle: candle["time"])
    if len(m15) < 22 or len(h1) < 50:
        return []
    ema20 = ema_values(m15, 20)
    ema50_h1 = ema_values(h1, 50)
    vwap_num = vwap_den = -1.0
    current_day = -1
    vwap_by_index = []
    for bar in m15:
        day = int(bar["time"] // DAY_SECONDS)
        if day != current_day:
            current_day, vwap_num, vwap_den = day, 0.0, 0.0
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3
        vwap_num += typical * bar["volume"]
        vwap_den += bar["volume"]
        vwap_by_index.append(vwap_num / vwap_den if vwap_den else typical)
    signals = []
    emitted_days = set()
    for i in range(20, len(m15)):
        bar = m15[i]
        day_key = int(bar["time"] // DAY_SECONDS)
        if day_key in emitted_days:
            continue
        m15_close_time = int(bar["time"]) + 15 * 60
        h1_index = next((j for j in range(len(h1) - 1, -1, -1) if int(h1[j]["time"]) + 60 * 60 <= m15_close_time), None)
        if h1_index is None or h1_index < 49:
            continue
        bias = "LONG" if h1[h1_index]["close"] > ema50_h1[h1_index] else "SHORT" if h1[h1_index]["close"] < ema50_h1[h1_index] else None
        if not bias:
            continue
        ema = ema20[i]
        vwap = vwap_by_index[i]
        body = abs(bar["close"] - bar["open"])
        lower_wick = min(bar["open"], bar["close"]) - bar["low"]
        upper_wick = bar["high"] - max(bar["open"], bar["close"])
        touched = bar["low"] <= max(ema, vwap) and bar["high"] >= min(ema, vwap)
        if bias == "LONG":
            confirmed = bar["close"] > bar["open"] and bar["close"] > ema and (lower_wick >= body * 0.5 or bar["low"] <= vwap)
            direction = "LONG"
            stop = min(min(c["low"] for c in m15[max(0, i - 4):i + 1]), bar["low"] - atr(m15, i) * 0.15)
            prior_target = max(c["high"] for c in m15[max(0, i - 20):i])
        else:
            confirmed = bar["close"] < bar["open"] and bar["close"] < ema and (upper_wick >= body * 0.5 or bar["high"] >= vwap)
            direction = "SHORT"
            stop = max(max(c["high"] for c in m15[max(0, i - 4):i + 1]), bar["high"] + atr(m15, i) * 0.15)
            prior_target = min(c["low"] for c in m15[max(0, i - 20):i])
        if not touched or not confirmed:
            continue
        entry = float(bar["close"])
        risk_distance = abs(entry - stop)
        if risk_distance <= 0:
            continue
        target = prior_target if (direction == "LONG" and prior_target > entry) or (direction == "SHORT" and prior_target < entry) else (entry + 1.5 * risk_distance if direction == "LONG" else entry - 1.5 * risk_distance)
        r_multiple = abs(target - entry) / risk_distance
        if r_multiple < 1.0:
            continue
        timestamp = int(bar["time"])
        signal_id = f"C-XAUUSD-{timestamp}"
        zone_top, zone_bottom = max(ema, vwap), min(ema, vwap)
        drawings = [
            {"kind": "level", "id": f"h1-ema50-{signal_id}", "label": "H1 EMA50 BIAS", "time": int(h1[h1_index]["time"]), "price": float(ema50_h1[h1_index]), "color": "#9a8dda", "dashed": True},
            {"kind": "level", "id": f"m15-ema20-{signal_id}", "label": "M15 EMA20", "time": timestamp, "price": float(ema), "color": "#e2ba73"},
            {"kind": "level", "id": f"vwap-{signal_id}", "label": "SESSION VWAP", "time": timestamp, "price": float(vwap), "color": "#70b8ae"},
            {"kind": "marker", "id": f"rejection-{signal_id}", "label": "PULLBACK REJECTION", "time": timestamp, "price": float(bar["low"] if direction == "LONG" else bar["high"]), "color": "#75c896" if direction == "LONG" else "#d5695e", "shape": "arrowUp" if direction == "LONG" else "arrowDown"},
            {"kind": "zone", "id": f"pullback-zone-{signal_id}", "label": "TREND PULLBACK ZONE", "from": int(m15[max(0, i - 2)]["time"]), "to": timestamp, "top": float(zone_top), "bottom": float(zone_bottom), "color": "#75c896" if direction == "LONG" else "#d5695e", "opacity": 0.12, "zoneType": "demand" if direction == "LONG" else "supply", "extendRight": True, "mitigation": {"trigger": "close", "boundary": "bottom" if direction == "LONG" else "top"}},
            {"kind": "path", "id": f"trend-path-{signal_id}", "label": "BIAS → REJECTION", "points": [{"time": int(h1[h1_index]["time"]), "price": float(ema50_h1[h1_index])}, {"time": timestamp, "price": float(ema)}, {"time": timestamp, "price": entry}], "color": "#9a8dda", "width": 1.25},
        ]
        signals.append({
            "id": signal_id, "timestamp": timestamp, "isoTime": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
            "setup": "C", "setupName": "H1 Trend Pullback", "session": "Trend continuation", "direction": direction,
            "entry": round(entry, 2), "stop": round(float(stop), 2), "target": round(float(target), 2),
            "riskDollars": 0.0, "rMultiple": round(r_multiple, 2), "atr": round(atr(m15, i), 4),
            "volumeRatio": 1.0, "confidence": 0.7,
            "rationale": f"H1 price is {('above' if direction == 'LONG' else 'below')} EMA50; M15 rejected EMA20/session VWAP in the trend direction.",
            "drawings": drawings,
        })
        emitted_days.add(day_key)
    return signals


def initialize_database(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("""CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        setup TEXT NOT NULL,
        session TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        target REAL NOT NULL,
        risk_dollars REAL NOT NULL,
        r_multiple REAL NOT NULL,
        payload_json TEXT NOT NULL,
        taken INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    connection.execute("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL)")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(signals)")}
    if "eligible" not in columns:
        connection.execute("ALTER TABLE signals ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1")
    if "block_reason" not in columns:
        connection.execute("ALTER TABLE signals ADD COLUMN block_reason TEXT")
    for column, definition in (("outcome", "TEXT"), ("outcome_time", "INTEGER"), ("outcome_price", "REAL"), ("outcome_r", "REAL"), ("outcome_checked_through", "INTEGER NOT NULL DEFAULT 0")):
        if column not in columns:
            connection.execute(f"ALTER TABLE signals ADD COLUMN {column} {definition}")
    connection.execute("INSERT OR IGNORE INTO settings(id,payload_json) VALUES(1,?)", (json.dumps(DEFAULT_SETTINGS),))
    connection.execute("""CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
        entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL, risk_dollars REAL NOT NULL,
        initial_risk_distance REAL NOT NULL DEFAULT 0,
        opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT, exit_price REAL,
        realized_pnl REAL, result_r REAL, status TEXT NOT NULL DEFAULT 'open')""")
    connection.execute("CREATE TABLE IF NOT EXISTS account_state (id INTEGER PRIMARY KEY CHECK(id=1), consecutive_losses INTEGER NOT NULL DEFAULT 0)")
    connection.execute("""CREATE TABLE IF NOT EXISTS historical_candles (
        broker TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0, spread REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (broker, symbol, timeframe, time))""")
    connection.execute("INSERT OR IGNORE INTO account_state(id) VALUES(1)")
    trade_columns = {row[1] for row in connection.execute("PRAGMA table_info(trades)")}
    if "initial_risk_distance" not in trade_columns:
        connection.execute("ALTER TABLE trades ADD COLUMN initial_risk_distance REAL NOT NULL DEFAULT 0")
    connection.execute("UPDATE trades SET initial_risk_distance=ABS(entry-stop) WHERE initial_risk_distance=0")
    connection.commit()
    return connection


def settings(connection):
    stored = json.loads(connection.execute("SELECT payload_json FROM settings WHERE id=1").fetchone()[0])
    merged = {**DEFAULT_SETTINGS, **stored}
    merged["enabledSetups"] = {**DEFAULT_SETTINGS["enabledSetups"], **stored.get("enabledSetups", {})}
    return merged


def account_snapshot(connection):
    config = settings(connection)
    realized = connection.execute("SELECT COALESCE(SUM(realized_pnl),0) FROM trades WHERE status='closed'").fetchone()[0]
    open_trades = connection.execute("SELECT id,signal_id,direction,entry,stop,target,risk_dollars,opened_at FROM trades WHERE status='open' ORDER BY id").fetchall()
    losses = connection.execute("SELECT consecutive_losses FROM account_state WHERE id=1").fetchone()[0]
    return {"settings": config, "equity": round(config["startCapital"] + realized, 2), "realizedPnl": round(realized, 2),
            "consecutiveLosses": losses, "openTrades": [dict(zip(("id","signalId","direction","entry","stop","target","riskDollars","openedAt"), row)) for row in open_trades]}


def guard_signal(connection, signal, spread):
    config = settings(connection)
    if float(signal.get("confidence", 0)) >= 0.85:
        return None
    if signal.get("alignmentEligible") is False:
        return signal.get("alignmentBlockReason") or "No higher timeframe supports this direction"
    now = datetime.fromtimestamp(signal["timestamp"], timezone.utc)
    if spread is not None and float(spread) > config["spreadLimit"]:
        return "Spread exceeds configured limit"
    if connection.execute("SELECT COUNT(*) FROM trades WHERE status='open'").fetchone()[0] >= config["maxOpenPositions"]:
        return "Open-position limit reached"
    losses = connection.execute("SELECT consecutive_losses FROM account_state WHERE id=1").fetchone()[0]
    if losses >= config["maxConsecutiveLosses"]:
        return "Daily loss lockout is active"
    day_start = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    used = connection.execute("SELECT COUNT(*) FROM signals WHERE eligible=1 AND timestamp>=? AND timestamp<?", (day_start, day_start + DAY_SECONDS)).fetchone()[0]
    if used >= config["maxSignalsPerDay"]:
        return "Daily signal limit reached"
    for event in config["newsEvents"]:
        try:
            event_time = datetime.fromisoformat(event["time"].replace("Z", "+00:00"))
            if abs((now - event_time).total_seconds()) <= int(event.get("blackoutMinutes", 15)) * 60:
                return f"News blackout: {event.get('label', 'scheduled event')}"
        except (KeyError, TypeError, ValueError):
            continue
    return None


def update_signal_outcomes(connection: sqlite3.Connection, candles: list[dict]):
    if not candles:
        return
    now = int(datetime.now(timezone.utc).timestamp())
    bars = sorted((candle for candle in candles if int(candle["time"]) + 300 <= now), key=lambda candle: int(candle["time"]))
    if not bars:
        return
    pending = connection.execute("SELECT id,timestamp,direction,entry,stop,target,r_multiple,outcome_checked_through FROM signals WHERE outcome IS NULL").fetchall()
    for signal_id, timestamp, direction, entry, stop, target, reward_r, checked_through in pending:
        checked = int(checked_through or 0)
        for bar in bars:
            bar_time = int(bar["time"])
            if bar_time <= max(int(timestamp), checked):
                continue
            stop_hit = float(bar["low"]) <= float(stop) if direction == "LONG" else float(bar["high"]) >= float(stop)
            target_hit = float(bar["high"]) >= float(target) if direction == "LONG" else float(bar["low"]) <= float(target)
            if stop_hit or target_hit:
                # If both levels occur within one M5 candle, conservatively count the stop first.
                outcome = "loss" if stop_hit else "win"
                exit_price = float(stop if stop_hit else target)
                outcome_r = -1.0 if stop_hit else float(reward_r)
                connection.execute("UPDATE signals SET outcome=?,outcome_time=?,outcome_price=?,outcome_r=?,outcome_checked_through=? WHERE id=?",
                                   (outcome, bar_time, exit_price, outcome_r, bar_time, signal_id))
                break
        else:
            connection.execute("UPDATE signals SET outcome_checked_through=MAX(outcome_checked_through,?) WHERE id=?",
                               (int(bars[-1]["time"]), signal_id))


def persist_and_read(connection: sqlite3.Connection, signals: list[dict], first_time: int, last_time: int, spread=None, candles=None) -> list[dict]:
    enabled = settings(connection).get("enabledSetups", {"A": True, "B": True, "C": True})
    config = settings(connection)
    release_rows = connection.execute("SELECT id,payload_json FROM signals WHERE eligible=0").fetchall()
    for signal_id, payload_json in release_rows:
        try:
            payload = json.loads(payload_json)
            if float(payload.get("confidence", 0)) >= 0.85:
                payload["eligible"] = True
                payload["blockReason"] = None
                payload["confidenceOverride"] = True
                connection.execute("UPDATE signals SET eligible=1,block_reason=NULL,payload_json=? WHERE id=?", (json.dumps(payload), signal_id))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    for signal in sorted(signals, key=lambda item: item["timestamp"]):
        if not enabled.get(signal["setup"], True):
            continue
        if not first_time <= int(signal["timestamp"]) <= last_time:
            continue
        # Keep every generated candidate for review, including candidates blocked by risk controls.
        existing = connection.execute("SELECT 1 FROM signals WHERE id=?", (signal["id"],)).fetchone()
        if existing:
            continue
        reason = guard_signal(connection, signal, spread)
        equity = account_snapshot(connection)["equity"]
        risk_dollars = round(equity * config["riskPercent"] / 100, 2)
        stop_distance = abs(float(signal["entry"]) - float(signal["stop"]))
        signal["riskDollars"] = risk_dollars
        signal["positionSizeLots"] = round(risk_dollars / (stop_distance * float(config["contractSizeOz"])), 4) if stop_distance else 0
        signal["eligible"] = reason is None
        signal["blockReason"] = reason
        connection.execute(
            "INSERT OR IGNORE INTO signals (id,timestamp,setup,session,direction,entry,stop,target,risk_dollars,r_multiple,payload_json,eligible,block_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (signal["id"], signal["timestamp"], signal["setup"], signal["session"], signal["direction"], signal["entry"], signal["stop"], signal["target"], risk_dollars, signal["rMultiple"], json.dumps(signal), int(signal["eligible"]), reason),
        )
    update_signal_outcomes(connection, candles or [])
    connection.commit()
    rows = connection.execute("SELECT payload_json,taken,eligible,block_reason,risk_dollars,entry,stop FROM signals WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp", (first_time, last_time)).fetchall()
    records = []
    for payload, taken, eligible, block_reason, risk_dollars, entry, stop in rows:
        signal = json.loads(payload)
        if not enabled.get(signal["setup"], True):
            continue
        signal["taken"] = bool(taken)
        signal.setdefault("eligible", bool(eligible))
        signal.setdefault("blockReason", block_reason)
        signal.setdefault("riskDollars", risk_dollars)
        signal.setdefault("positionSizeLots", round(risk_dollars / (abs(entry - stop) * float(config["contractSizeOz"])), 4) if abs(entry - stop) else 0)
        records.append(signal)
    return records


def mark_taken(connection: sqlite3.Connection, signal_id: str, actual_entry=None, manual_override=False):
    row = connection.execute("SELECT direction,entry,stop,target,eligible FROM signals WHERE id=?", (signal_id,)).fetchone()
    if not row:
        return {"updated": False, "error": "Signal not found"}
    config = settings(connection)
    if not config.get("positionTrackingEnabled", False):
        return {"updated": False, "error": "Optional position tracking is disabled in risk settings"}
    if not row[4] and not manual_override:
        return {"updated": False, "error": "This signal is blocked by a risk control"}
    if not manual_override and connection.execute("SELECT COUNT(*) FROM trades WHERE status='open'").fetchone()[0] >= config["maxOpenPositions"]:
        return {"updated": False, "error": "Open-position limit reached"}
    if not manual_override and connection.execute("SELECT consecutive_losses FROM account_state WHERE id=1").fetchone()[0] >= config["maxConsecutiveLosses"]:
        return {"updated": False, "error": "Loss lockout is active"}
    direction, entry, stop, target, _eligible = row
    entry = float(actual_entry) if actual_entry is not None else float(entry)
    if not (entry > 0 and stop > 0 and target > 0 and ((direction == "LONG" and stop < entry < target) or (direction == "SHORT" and target < entry < stop))):
        return {"updated": False, "error": "Entry must remain between the stop and target"}
    if connection.execute("SELECT 1 FROM trades WHERE signal_id=?", (signal_id,)).fetchone():
        return {"updated": False, "error": "This signal is already tracked"}
    risk = round(account_snapshot(connection)["equity"] * config["riskPercent"] / 100, 2)
    connection.execute("INSERT INTO trades(signal_id,direction,entry,stop,target,risk_dollars,initial_risk_distance) VALUES(?,?,?,?,?,?,?)", (signal_id,direction,entry,stop,target,risk,abs(entry-stop)))
    signal_row = connection.execute("SELECT payload_json FROM signals WHERE id=?", (signal_id,)).fetchone()
    payload = json.loads(signal_row[0]) if signal_row else {}
    payload["manualOverride"] = bool(manual_override)
    cursor = connection.execute("UPDATE signals SET taken=1,payload_json=? WHERE id=?", (json.dumps(payload), signal_id))
    connection.commit()
    return {"updated": cursor.rowcount > 0, "manualOverride": bool(manual_override), "account": account_snapshot(connection)}


def close_trade(connection, trade_id, exit_price):
    row = connection.execute("SELECT direction,entry,risk_dollars,initial_risk_distance FROM trades WHERE id=? AND status='open'", (int(trade_id),)).fetchone()
    if not row: return {"updated": False, "error": "Open trade not found"}
    direction, entry, risk, distance = row
    pnl = ((float(exit_price) - entry) if direction == "LONG" else (entry - float(exit_price))) * (risk / distance if distance else 0)
    result_r = pnl / risk if risk else 0
    connection.execute("UPDATE trades SET status='closed',closed_at=CURRENT_TIMESTAMP,exit_price=?,realized_pnl=?,result_r=? WHERE id=?", (float(exit_price),round(pnl,2),round(result_r,2),int(trade_id)))
    losses = connection.execute("SELECT consecutive_losses FROM account_state WHERE id=1").fetchone()[0]
    connection.execute("UPDATE account_state SET consecutive_losses=? WHERE id=1", (losses + 1 if pnl < 0 else 0,))
    connection.commit()
    return {"updated": True, "realizedPnl": round(pnl,2), "resultR": round(result_r,2), "account": account_snapshot(connection)}


def update_tracked_stop(connection, trade_id, stop):
    row = connection.execute("SELECT direction,entry,target FROM trades WHERE id=? AND status='open'", (int(trade_id),)).fetchone()
    if not row:
        return {"updated": False, "error": "Open tracked position not found"}
    direction, entry, target = row
    stop = float(stop)
    if not math.isfinite(stop) or stop <= 0 or (direction == "LONG" and stop >= entry) or (direction == "SHORT" and stop <= entry):
        return {"updated": False, "error": "Stop loss must remain positive and on the risk side of entry"}
    connection.execute("UPDATE trades SET stop=? WHERE id=?", (stop, int(trade_id)))
    connection.commit()
    return {"updated": True, "account": account_snapshot(connection)}


def forget_tracked_trade(connection, trade_id):
    row = connection.execute("SELECT signal_id FROM trades WHERE id=? AND status='open'", (int(trade_id),)).fetchone()
    if not row:
        return {"updated": False, "error": "Open tracked position not found"}
    connection.execute("DELETE FROM trades WHERE id=?", (int(trade_id),))
    connection.execute("UPDATE signals SET taken=0 WHERE id=?", (row[0],))
    connection.commit()
    return {"updated": True, "signalId": row[0], "account": account_snapshot(connection)}


def read_history(connection, limit=300):
    limit = max(1, min(1000, int(limit or 300)))
    rows = connection.execute("""SELECT s.id,s.timestamp,s.setup,s.session,s.direction,s.entry,s.stop,s.target,
        s.risk_dollars,s.r_multiple,s.payload_json,s.taken,s.eligible,s.block_reason,
        t.id,t.opened_at,t.closed_at,t.exit_price,t.realized_pnl,t.result_r,t.status,
        s.outcome,s.outcome_time,s.outcome_price,s.outcome_r
        FROM signals s LEFT JOIN trades t ON t.signal_id=s.id ORDER BY s.timestamp DESC LIMIT ?""", (limit,)).fetchall()
    records = []
    for row in rows:
        payload = json.loads(row[10])
        status = row[20] or ("blocked" if not row[12] else "tracked" if row[11] else "ready")
        records.append({**payload, "taken": bool(row[11]), "eligible": bool(row[12]), "blockReason": row[13],
                        "status": status, "tradeId": row[14], "openedAt": row[15], "closedAt": row[16],
                        "exitPrice": row[17], "realizedPnl": row[18], "resultR": row[19],
                        "outcome": row[21], "outcomeTime": row[22], "outcomePrice": row[23], "outcomeR": row[24]})
    counts = {key: sum(1 for item in records if item["status"] == key) for key in ("ready", "blocked", "open", "closed")}
    stats = {}
    for name, where in (("signals", ""), ("tracked", "WHERE taken=1")):
        wins, losses = connection.execute(
            f"SELECT SUM(outcome='win'),SUM(outcome='loss') FROM signals {where} AND outcome IN ('win','loss')" if where else
            "SELECT SUM(outcome='win'),SUM(outcome='loss') FROM signals WHERE outcome IN ('win','loss')"
        ).fetchone()
        wins, losses = int(wins or 0), int(losses or 0)
        settled = wins + losses
        stats[name] = {"wins": wins, "losses": losses, "settled": settled,
                       "winRate": round(100 * wins / settled, 1) if settled else 0}
    return {"records": records, "counts": counts, "total": len(records), "stats": stats}


def backtest(connection, request):
    historical = request.get("historical")
    data_report = None
    sample_start = sample_end = None
    if historical:
        symbol = str(historical.get("symbol") or "").strip()
        start_date = historical.get("startDate")
        end_date = historical.get("endDate")
        try:
            sample_start = datetime.strptime(str(start_date), "%Y-%m-%d").replace(tzinfo=timezone.utc)
            sample_end = datetime.strptime(str(end_date), "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1) - timedelta(seconds=1)
        except ValueError as exc:
            raise ValueError("History dates must use YYYY-MM-DD") from exc
        if sample_end < sample_start or (sample_end - sample_start).days >= 3653:
            raise ValueError("Choose a valid history range of no more than ten years")
        warmup_date = (sample_start - timedelta(days=30)).strftime("%Y-%m-%d")
        history_results = {frame: mt5_candles_range(symbol, frame, warmup_date, end_date, connection, historical.get("server")) for frame in ("M5", "M15", "H1", "H4")}
        frames = {frame: result["candles"] for frame, result in history_results.items()}
        supplied = frames
        m5_times = [int(bar["time"]) for bar in frames["M5"]]
        frame_seconds = {"M5": 300, "M15": 900, "H1": 3600, "H4": 14400}
        data_report = {
            "source": "MT5", "symbol": symbol,
            "range": f"{start_date} – {end_date} UTC" if m5_times else "No M5 bars received",
            "availableRange": (f"{datetime.fromtimestamp(min(m5_times), timezone.utc).strftime('%Y-%m-%d %H:%M')} – "
                               f"{datetime.fromtimestamp(max(m5_times), timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC") if m5_times else "No M5 bars received",
            "counts": {frame: len(bars) for frame, bars in frames.items()},
            "cachedBars": sum(result.get("cacheBars", 0) for result in history_results.values()),
            "gaps": {frame: sum(1 for i in range(1, len(bars)) if int(bars[i]["time"]) - int(bars[i-1]["time"]) > frame_seconds[frame] * 1.5) for frame, bars in frames.items()},
            "sessions": {"Asia": 0, "London": 0, "newYork": 0, "offHours": 0},
            "spreadSamples": sum(1 for bar in frames["M5"] if bar.get("spread") is not None and bar["spread"] > 0),
        }
        for bar in frames["M5"]:
            hour = datetime.fromtimestamp(int(bar["time"]), timezone.utc).hour
            key = "Asia" if hour < 7 else "London" if hour < 13 else "newYork" if hour < 20 else "offHours"
            data_report["sessions"][key] += 1
    else:
        supplied = request.get("candlesByTimeframe") or {}
    history_limit = 1_200_000 if historical else 5000
    m5 = validate_candles(supplied.get("M5", []), "M5", history_limit)
    m15 = validate_candles(supplied.get("M15", []), "M15", history_limit)
    h1 = validate_candles(supplied.get("H1", []), "H1", history_limit)
    h4 = validate_candles(supplied.get("H4", []), "H4", history_limit)
    if len(m5) < 30:
        if historical:
            raise ValueError("MT5 returned fewer than 30 M5 bars for this range. Check the symbol, dates, broker history, and MT5 Max. bars in chart setting.")
        raise ValueError("Backtesting requires at least 30 M5 candles")
    spread = float(request.get("spread", 0))
    if not math.isfinite(spread) or spread < 0 or spread > 100:
        raise ValueError("Spread must be between 0 and 100")
    config = settings(connection)
    session_filter = request.get("session", "All")
    if session_filter not in ("All", "Asia", "London", "New York"):
        raise ValueError("Unknown session filter")
    exclude_news = bool(request.get("excludeNews", True))
    split_time = (sample_start + (sample_end - sample_start) * 0.7).timestamp() if sample_start is not None and sample_end is not None else None
    enabled = config["enabledSetups"]
    candidates = []
    if enabled.get("A", True): candidates.extend(opening_range_signals(m5))
    if enabled.get("B", True): candidates.extend(liquidity_sweep_signals(m5))
    if enabled.get("C", True) and m15 and h1: candidates.extend(trend_pullback_signals(m15, h1))
    candidates = apply_timeframe_alignment(candidates, m5, m15, h1, h4, int(datetime.now(timezone.utc).timestamp()))
    candidates = [signal for signal in candidates if signal.get("alignmentEligible", True)]
    if sample_start is not None:
        candidates = [signal for signal in candidates if int(signal["timestamp"]) >= int(sample_start.timestamp())]
    candidates.sort(key=lambda item: item["timestamp"])
    bars_by_setup = {"A": m5, "B": m5, "C": m5}
    news_times = []
    if exclude_news:
        for event in config["newsEvents"]:
            try:
                parsed = datetime.fromisoformat(event["time"].replace("Z", "+00:00"))
                if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=timezone.utc)
                news_times.append((parsed.timestamp(), int(event.get("blackoutMinutes", 15)) * 60, event.get("label", "news")))
            except (KeyError, TypeError, ValueError):
                continue
    risk_dollars = float(config["startCapital"]) * float(config["riskPercent"]) / 100
    trades = []
    skipped = {"session": 0, "news": 0, "spread": 0, "no_forward_bars": 0}
    observed_spreads = []
    historical_spread_samples = fallback_spread_samples = 0
    for signal in candidates:
        stamp = int(signal["timestamp"])
        hour = datetime.fromtimestamp(stamp, timezone.utc).hour
        session = "Asia" if hour < 7 else "London" if hour < 13 else "New York" if hour < 20 else "Off hours"
        if session_filter != "All" and session != session_filter:
            skipped["session"] += 1; continue
        if any(abs(stamp - event_time) <= blackout for event_time, blackout, _label in news_times):
            skipped["news"] += 1; continue
        bars = bars_by_setup[signal["setup"]]
        entry_idx = next((i for i, bar in enumerate(bars) if int(bar["time"]) > stamp), None)
        if entry_idx is None:
            skipped["no_forward_bars"] += 1; continue
        direction = signal["direction"]
        entry_bar = bars[entry_idx]
        if split_time is not None and stamp < split_time and int(entry_bar["time"]) >= split_time:
            skipped["no_forward_bars"] += 1; continue
        evaluation_bars = bars[entry_idx:]
        if split_time is not None and stamp < split_time:
            evaluation_bars = [bar for bar in evaluation_bars if int(bar["time"]) < split_time]
        if not evaluation_bars:
            skipped["no_forward_bars"] += 1; continue
        raw_entry_spread = entry_bar.get("spread")
        if raw_entry_spread is not None and float(raw_entry_spread) > 0:
            entry_spread = float(raw_entry_spread); historical_spread_samples += 1
        else:
            entry_spread = spread; fallback_spread_samples += 1
        if entry_spread > float(config["spreadLimit"]):
            skipped["spread"] += 1; continue
        observed_spreads.append(entry_spread)
        # Enter at the next bar open with spread cost. BUY pays ask; SELL receives bid.
        entry = float(entry_bar["open"]) + (entry_spread if direction == "LONG" else 0)
        stop, target = float(signal["stop"]), float(signal["target"])
        risk_distance = abs(entry - stop)
        if risk_distance <= 0 or (direction == "LONG" and not stop < entry < target) or (direction == "SHORT" and not target < entry < stop):
            continue
        outcome, exit_price, exit_time = "open", float(evaluation_bars[-1]["close"]), int(evaluation_bars[-1]["time"])
        for bar in evaluation_bars:
            raw_bar_spread = bar.get("spread")
            if raw_bar_spread is not None and float(raw_bar_spread) > 0:
                bar_spread = float(raw_bar_spread); historical_spread_samples += 1
            else:
                bar_spread = spread; fallback_spread_samples += 1
            observed_spreads.append(bar_spread)
            # Convert candle ask levels to bid levels for buys; sells exit at ask.
            if direction == "LONG":
                hit_stop = float(bar["low"]) <= stop
                hit_target = float(bar["high"]) >= target
            else:
                hit_stop = float(bar["high"]) + bar_spread >= stop
                hit_target = float(bar["low"]) + bar_spread <= target
            if hit_stop or hit_target:
                # Conservative rule: when both levels fall in one candle, count the stop first.
                outcome = "loss" if hit_stop else "win"
                exit_price = stop if hit_stop else target
                exit_time = int(bar["time"])
                break
        if outcome == "open" and direction == "SHORT":
            exit_price += float(evaluation_bars[-1].get("spread") or spread)  # A short closes at ask at the sample boundary.
        pnl_distance = (exit_price - entry) if direction == "LONG" else (entry - exit_price)
        result_r = pnl_distance / risk_distance
        trades.append({"setup": signal["setup"], "timestamp": stamp, "outcome": outcome,
                       "resultR": result_r, "pnl": risk_dollars * result_r, "exitTime": exit_time})
    groups = []
    for setup in ("A", "B", "C"):
        group = [trade for trade in trades if trade["setup"] == setup]
        if not group: continue
        settled = [t for t in group if t["outcome"] != "open"]
        wins = sum(t["outcome"] == "win" for t in settled)
        groups.append({"setup": setup, "trades": len(group), "wins": wins,
                       "losses": sum(t["outcome"] == "loss" for t in settled), "openTrades": len(group) - len(settled), "winRate": round(100 * wins / len(settled), 1) if settled else 0,
                       "averageR": round(fmean(t["resultR"] for t in group), 2), "netPnl": round(sum(t["pnl"] for t in group), 2)})
    equity = peak = drawdown = 0.0
    for trade in trades:
        equity += trade["pnl"]; peak = max(peak, equity); drawdown = max(drawdown, peak - equity)
    total = len(trades)
    settled = [t for t in trades if t["outcome"] != "open"]
    wins = sum(t["outcome"] == "win" for t in settled)
    spread_stats = {"samples": len(observed_spreads), "historicalSamples": historical_spread_samples, "fallbackSamples": fallback_spread_samples,
                    "average": round(fmean(observed_spreads), 4) if observed_spreads else round(spread, 4),
                    "median": round(median(observed_spreads), 4) if observed_spreads else round(spread, 4),
                    "maximum": round(max(observed_spreads), 4) if observed_spreads else round(spread, 4)}
    out_of_sample = None
    if split_time is not None:
        def summarize_period(period_trades):
            period_settled = [trade for trade in period_trades if trade["outcome"] != "open"]
            period_equity = period_peak = period_drawdown = 0.0
            for trade in period_trades:
                period_equity += trade["pnl"]
                period_peak = max(period_peak, period_equity)
                period_drawdown = max(period_drawdown, period_peak - period_equity)
            return {"trades": len(period_trades), "settled": len(period_settled),
                    "winRate": round(100 * sum(t["outcome"] == "win" for t in period_settled) / len(period_settled), 1) if period_settled else 0,
                    "expectancyR": round(fmean(t["resultR"] for t in period_trades), 2) if period_trades else 0,
                    "netPnl": round(sum(t["pnl"] for t in period_trades), 2), "maxDrawdown": round(period_drawdown, 2)}
        training = [trade for trade in trades if trade["timestamp"] < split_time]
        holdout = [trade for trade in trades if trade["timestamp"] >= split_time]
        out_of_sample = {"splitDate": datetime.fromtimestamp(split_time, timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                         "training": summarize_period(training), "holdout": summarize_period(holdout)}
    return {"trades": total, "wins": wins, "losses": sum(t["outcome"] == "loss" for t in settled), "openTrades": total - len(settled),
            "winRate": round(100 * wins / len(settled), 1) if settled else 0,
            "averageR": round(fmean(t["resultR"] for t in trades), 2) if trades else 0,
            "expectancyR": round(fmean(t["resultR"] for t in trades), 2) if trades else 0,
            "netPnl": round(sum(t["pnl"] for t in trades), 2), "maxDrawdown": round(drawdown, 2),
            "bySetup": groups, "skipped": skipped, "spread": spread, "spreadStats": spread_stats,
            "spreadSource": "historical MT5 candle spread where available; configured fallback spread otherwise",
            "session": session_filter, "newsFiltered": exclude_news, "dataReport": data_report, "outOfSample": out_of_sample,
            "assumptions": ["Signals require at least one of H1/H4 to align or lean toward the direction; M15 is contextual, not a hard veto; Setup C waits up to 90 minutes for its M5 trigger.", "Signals execute at the next available candle open.", "MT5 candle spread is applied per bar when available; BUY entries pay ask and BUY exits use bid, while SELL entries receive bid and SELL exits use ask.", "The configured fallback spread is used when a historical bar has no spread; the maximum spread setting blocks entries above the limit.", "No separate commission or slippage model is applied; include broker-specific charges and slippage before interpreting results.", "If stop and target are both touched in one candle, the stop is counted first.", "Positions open at the sample end are marked to market and excluded from win rate.", "News and session filters use UTC candle timestamps.", "Historical ranges are split chronologically: first 70% development, last 30% holdout; avoid rule changes based on holdout results.", "Results are simulations and do not establish profitability."]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    connection = initialize_database(args.db)
    print(json.dumps({"type": "status", "status": "ready", "engine": "python", "version": ENGINE_VERSION}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            command = request.get("command")
            if command == "ping":
                response = {"id": request_id, "type": "pong", "status": "ready", "version": ENGINE_VERSION}
            elif command == "get_state":
                response = {"id": request_id, "type": "account_state", "status": "ready", **account_snapshot(connection)}
            elif command == "save_settings":
                merged = {**settings(connection), **request.get("settings", {})}
                merged["newsEvents"] = merged.get("newsEvents", [])
                merged["enabledSetups"] = {**settings(connection)["enabledSetups"], **merged.get("enabledSetups", {})}
                merged["enabledSetups"] = {key: bool(merged["enabledSetups"].get(key, True)) for key in ("A", "B", "C")}
                if not (100 <= float(merged["startCapital"]) <= 100000000 and 0.01 <= float(merged["riskPercent"]) <= 10 and 0 <= float(merged["spreadLimit"]) <= 100 and 1 <= float(merged.get("contractSizeOz", 100)) <= 10000):
                    raise ValueError("Settings are outside allowed ranges")
                merged["contractSizeOz"] = float(merged.get("contractSizeOz", 100))
                merged["positionTrackingEnabled"] = bool(merged.get("positionTrackingEnabled", False))
                merged["lanViewEnabled"] = bool(merged.get("lanViewEnabled", False))
                for key in ("maxSignalsPerDay", "maxOpenPositions", "maxConsecutiveLosses"):
                    merged[key] = max(1, min(20, int(merged[key])))
                connection.execute("UPDATE settings SET payload_json=? WHERE id=1", (json.dumps(merged),)); connection.commit()
                response = {"id": request_id, "type": "account_state", "status": "ready", **account_snapshot(connection)}
            elif command == "analyze":
                supplied = request.get("candlesByTimeframe")
                if supplied is None:
                    supplied = {"M5": request.get("candles", [])}
                if not isinstance(supplied, dict):
                    raise ValueError("candlesByTimeframe must be an object")
                m5 = validate_candles(supplied.get("M5", []), "M5")
                m15 = validate_candles(supplied.get("M15", []), "M15")
                h1 = validate_candles(supplied.get("H1", []), "H1")
                h4 = validate_candles(supplied.get("H4", []), "H4")
                enabled_setups = settings(connection)["enabledSetups"]
                signals = []
                if enabled_setups.get("A", True): signals.extend(opening_range_signals(m5))
                if enabled_setups.get("B", True): signals.extend(liquidity_sweep_signals(m5))
                if enabled_setups.get("C", True): signals.extend(trend_pullback_signals(m15, h1))
                now = int(datetime.now(timezone.utc).timestamp())
                signals = apply_timeframe_alignment(signals, m5, m15, h1, h4, now)
                signals.sort(key=lambda signal: signal["timestamp"])
                if m5:
                    records = persist_and_read(connection, signals, int(m5[0]["time"]), int(m5[-1]["time"]), request.get("spread"), m5)
                    allowed_ids = {signal["id"] for signal in signals}
                    records = [record for record in records if record["id"] in allowed_ids]
                else:
                    records = []
                response = {"id": request_id, "type": "analysis", "status": "ready", "signals": records, "candlesAnalyzed": len(m5), "setupsEvaluated": [key for key, on in enabled_setups.items() if on], "riskBlockedCount": sum(1 for item in records if not item.get("eligible", True)), **account_snapshot(connection)}
            elif command == "mark_taken":
                result = mark_taken(connection, str(request.get("signalId", "")), request.get("actualEntry"), bool(request.get("manualOverride", False)))
                response = {"id": request_id, "type": "trade_marked", "status": "ready", **result}
            elif command == "close_trade":
                result = close_trade(connection, request.get("tradeId"), request.get("exitPrice"))
                response = {"id": request_id, "type": "trade_closed", "status": "ready", **result}
            elif command == "update_tracked_stop":
                result = update_tracked_stop(connection, request.get("tradeId"), request.get("stop"))
                response = {"id": request_id, "type": "trade_updated", "status": "ready", **result}
            elif command == "forget_tracked_trade":
                result = forget_tracked_trade(connection, request.get("tradeId"))
                response = {"id": request_id, "type": "trade_forgotten", "status": "ready", **result}
            elif command == "history":
                response = {"id": request_id, "type": "history", "status": "ready", **read_history(connection, request.get("limit", 300))}
            elif command == "backtest":
                response = {"id": request_id, "type": "backtest", "status": "ready", **backtest(connection, request)}
            elif command == "mt5_connect":
                response = {"id": request_id, "type": "mt5_status", **mt5_connect()}
            elif command == "mt5_start_terminal":
                response = {"id": request_id, "type": "mt5_terminal", **mt5_start_terminal()}
            elif command == "mt5_show_terminal":
                response = {"id": request_id, "type": "mt5_terminal", "shown": mt5_windows_action("restore")}
            elif command == "mt5_positions":
                response = {"id": request_id, "type": "mt5_positions", "positions": mt5_positions(request.get("symbol"))}
            elif command == "mt5_candles":
                response = {"id": request_id, "type": "mt5_candles", **mt5_candles(request.get("symbol"), request.get("timeframe"), request.get("count", 220), request.get("startPos", 0))}
            elif command == "cache_mt5_history":
                response = {"id": request_id, "type": "cached_mt5_history", **cache_mt5_history(connection, request.get("symbol"), request.get("timeframe"), request.get("startDate"), request.get("endDate"), request.get("server"))}
            elif command == "mt5_quote":
                response = {"id": request_id, "type": "mt5_quote", **mt5_quote(request.get("symbol"))}
            elif command == "mt5_history":
                response = {"id": request_id, "type": "mt5_history", "exits": mt5_history(request.get("symbol"))}
            elif command == "mt5_place_order":
                response = {"id": request_id, "type": "mt5_order", **mt5_place_order(request)}
            elif command == "mt5_close_position":
                response = {"id": request_id, "type": "mt5_close", **mt5_close_position(request.get("ticket"))}
            elif command == "mt5_update_position_stop":
                response = {"id": request_id, "type": "mt5_stop_updated", **mt5_update_position_stop(request)}
            else:
                raise ValueError(f"Unknown command: {command}")
            print(json.dumps(response, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps({"id": request_id, "type": "error", "error": str(error), "trace": traceback.format_exc()}), flush=True)
    connection.close()


if __name__ == "__main__":
    main()

