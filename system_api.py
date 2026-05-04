"""두근 트레이딩 시스템 API (:9000).

봇 본체와 별개로 항상 켜져있는 작은 컨트롤 서버.
대시보드 메뉴에서 호출:
- 봇 시작/종료/재시작
- launchd 자동시작 토글
- 로그 tail
- 시스템 상태 (PID/포트/메모리)

엔드포인트:
- GET  /system/status        → 봇/API/launchd 상태
- POST /system/start         → start-all.sh
- POST /system/stop          → stop-all.sh
- POST /system/restart       → stop + start
- POST /system/restart/{name}→ 개별 재시작 (coinbot-main 등)
- POST /system/autoload/on   → launchctl load
- POST /system/autoload/off  → launchctl unload
- GET  /system/log/{name}    → 최근 로그 N줄
- GET  /system/health        → API 자체 헬스
"""
from __future__ import annotations
import os
import socket
import subprocess
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

ROOT = Path.home() / "trading-dashboard"
PID_DIR = ROOT / "pids"
LOG_DIR = ROOT / "logs"
START_SH = ROOT / "start-all.sh"
STOP_SH = ROOT / "stop-all.sh"
PLIST = Path.home() / "Library/LaunchAgents/com.doogeun.trading.plist"
PLIST_LABEL = "com.doogeun.trading"

PROCESSES = ["coinbot-main", "coinbot-api", "stockbot-main", "stockbot-api"]

BOT_APIS = {
    "coin": "http://127.0.0.1:9001",
    "stock": "http://127.0.0.1:9002",
}

app = FastAPI(title="두근 트레이딩 시스템 API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 헬퍼 ───────────────────────────────────────────────────────
def _read_pid(name: str) -> int | None:
    p = PID_DIR / f"{name}.pid"
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except ValueError:
        return None


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return False


def _proc_info(name: str) -> dict:
    pid = _read_pid(name)
    alive = pid is not None and _is_alive(pid)
    info = {"name": name, "pid": pid, "alive": alive}
    if alive and pid:
        try:
            ps = subprocess.run(
                ["ps", "-p", str(pid), "-o", "rss=,etime="],
                capture_output=True, text=True, timeout=2,
            )
            parts = ps.stdout.strip().split()
            if len(parts) >= 2:
                info["rss_kb"] = int(parts[0])
                info["etime"] = parts[1]
        except Exception:
            pass
    return info


def _autoload_enabled() -> bool:
    """launchctl list 에서 plist 둘 중 하나라도 등록됐으면 활성"""
    try:
        r = subprocess.run(
            ["launchctl", "list"], capture_output=True, text=True, timeout=3,
        )
        return ("com.doogeun.trading" in r.stdout
                or "com.doogeun.trading.system" in r.stdout)
    except Exception:
        return False


def _run_script(path: Path, timeout: int = 30) -> dict:
    if not path.exists():
        raise HTTPException(404, f"스크립트 없음: {path}")
    try:
        r = subprocess.run(
            ["/bin/bash", str(path)],
            capture_output=True, text=True, timeout=timeout,
        )
        return {
            "ok": r.returncode == 0,
            "rc": r.returncode,
            "stdout": r.stdout[-2000:],
            "stderr": r.stderr[-500:],
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"타임아웃: {path}")


# ── 라우트 ─────────────────────────────────────────────────────
@app.get("/system/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "system_api",
        "port": 9000,
        "lan_ip": _lan_ip(),
        "hostname": socket.gethostname(),
    }


def _lan_ip() -> str:
    """LAN 안의 본인 IP 자동 감지 (인터넷 연결 가정)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.3)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


@app.get("/system/status")
def status() -> dict:
    procs = [_proc_info(n) for n in PROCESSES]
    return {
        "processes": procs,
        "all_up": all(p["alive"] for p in procs),
        "any_up": any(p["alive"] for p in procs),
        "autoload": _autoload_enabled(),
        "plist_exists": PLIST.exists(),
    }


# ── 청산 예약 (사용자 → 봇 다음 사이클에 강제 청산) ────────
import sqlite3 as _sqlite3
COIN_DB = os.path.expanduser("~/coinbot/data/bot.db")
STOCK_DB = os.path.expanduser("~/Desktop/주식 자동봇/data/demo.db")

def _ensure_pending_col(db_path):
    """positions 테이블에 pending_sell 컬럼 추가 (없으면)."""
    try:
        with _sqlite3.connect(db_path) as conn:
            cols = [r[1] for r in conn.execute("PRAGMA table_info(positions)").fetchall()]
            if "pending_sell" not in cols:
                conn.execute("ALTER TABLE positions ADD COLUMN pending_sell INTEGER DEFAULT 0")
                conn.commit()
    except Exception as e:
        print(f"[ensure_pending_col] {db_path}: {e}")

# 시작 시 양봇 DB 마이그레이션
_ensure_pending_col(COIN_DB)
_ensure_pending_col(STOCK_DB)


@app.post("/api/positions/close")
async def schedule_close(req: dict) -> dict:
    """청산 예약 — bot=coin/stock, symbol=KRW-BTC/010950."""
    bot = req.get("bot", "")
    symbol = req.get("symbol", "")
    if not bot or not symbol:
        return {"ok": False, "error": "bot, symbol 필수"}
    db_path = COIN_DB if bot == "coin" else STOCK_DB
    col_name = "coin" if bot == "coin" else "stock"
    try:
        with _sqlite3.connect(db_path) as conn:
            r = conn.execute(
                f"UPDATE positions SET pending_sell=1 WHERE {col_name}=?",
                (symbol,)
            )
            conn.commit()
            updated = r.rowcount
        return {"ok": True, "scheduled": updated, "symbol": symbol, "bot": bot,
                "note": "다음 사이클 (60초 내) 강제 청산"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ─── 페르소나 비중 설정 (가이드 §2) ───────────────────
from fastapi import HTTPException
from datetime import datetime as _dt2, timedelta as _td2
from zoneinfo import ZoneInfo as _ZI
import sqlite3 as _sql
import json as _j
KST = _ZI("Asia/Seoul")

def _persona_db(market):
    return COIN_DB if market == "coin" else STOCK_DB

def _next_market_open(market):
    now = _dt2.now(KST)
    if market == "coin":
        nxt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        if now >= nxt: nxt += _td2(days=1)
        return nxt
    if market == "kr":
        nxt = now.replace(hour=9, minute=30, second=0, microsecond=0)
        if now >= nxt: nxt += _td2(days=1)
        while nxt.weekday() >= 5: nxt += _td2(days=1)
        return nxt
    nxt = now.replace(hour=22, minute=30, second=0, microsecond=0)
    if now >= nxt: nxt += _td2(days=1)
    return nxt

@app.get("/api/personas/stats")
async def persona_stats(market: str = "coin", days: int = 30):
    db_path = _persona_db(market)
    try:
        conn = _sql.connect(db_path)
        cur = conn.cursor()
        # 코인봇은 created_at, 주식봇은 ts 사용 — 양쪽 호환
        ts_col = "created_at" if market == "coin" else "ts"
        side_filter = "side IN ('sell','SELL')" if market == "coin" else "side='SELL'"
        cur.execute(f"""
            SELECT persona, COUNT(*) total,
                   SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) wins,
                   AVG(CASE WHEN pnl>0 THEN pnl_pct END) avg_win,
                   AVG(CASE WHEN pnl<0 THEN ABS(pnl_pct) END) avg_loss,
                   AVG(pnl_pct) avg_pp, SUM(pnl) total_pnl
            FROM trades WHERE {side_filter}
              AND {ts_col} >= datetime('now', ?)
            GROUP BY persona
        """, (f'-{days} days',))
        results = {}
        total_pnl = 0
        for r in cur.fetchall():
            persona, total, wins, avg_win, avg_loss, avg_pp, pnl = r
            wins = wins or 0; avg_win = avg_win or 0; avg_loss = avg_loss or 0
            results[persona] = {
                "total": total, "wins": wins,
                "winrate": round(wins/total*100, 1) if total else 0,
                "rr": round(avg_win/avg_loss, 2) if avg_loss else 0,
                "avg_pnl_pct": round(avg_pp or 0, 3),
                "total_pnl": pnl or 0,
            }
            total_pnl += pnl or 0
        conn.close()
        return {**results, "current_pnl_30d": round(total_pnl, 0)}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/personas/current-weight")
async def persona_current_weight(market: str = "coin"):
    db_path = _persona_db(market)
    try:
        conn = _sql.connect(db_path)
        cur = conn.cursor()
        cur.execute("""SELECT new_weights_json FROM persona_weight_history
            WHERE market=? ORDER BY applied_at DESC LIMIT 1""", (market,))
        row = cur.fetchone(); conn.close()
        if row: return {"weights": _j.loads(row[0])}
        return {"weights": {"coolma":35,"swing":30,"day":25,"hold":10}}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/personas/weight-history")
async def persona_weight_history(market: str = "coin", limit: int = 5):
    db_path = _persona_db(market)
    try:
        conn = _sql.connect(db_path)
        cur = conn.cursor()
        cur.execute("""SELECT COUNT(*) FROM persona_weight_history
            WHERE market=? AND DATE(applied_at)=DATE('now','localtime')""", (market,))
        ct = cur.fetchone()[0]
        cur.execute("""SELECT old_weights_json,new_weights_json,applied_at,applied_by,reason
            FROM persona_weight_history WHERE market=? ORDER BY applied_at DESC LIMIT ?""",
            (market, limit))
        items = []
        for old_w, new_w, at, by, reason in cur.fetchall():
            ow = _j.loads(old_w) if old_w else {}
            nw = _j.loads(new_w)
            changes = [f"{p} {ow.get(p,0)}% → {v}%" for p,v in nw.items() if ow.get(p,0)!=v]
            try:
                applied_dt = _dt2.fromisoformat(at.replace('Z','+00:00')) if 'T' in at or 'Z' in at else _dt2.fromisoformat(at)
                if applied_dt.tzinfo is None: applied_dt = applied_dt.replace(tzinfo=KST)
                diff = _dt2.now(KST) - applied_dt.astimezone(KST)
                tg = f"{diff.days}일 전" if diff.days>0 else f"{diff.seconds//3600}시간 전" if diff.seconds//3600>0 else f"{diff.seconds//60}분 전"
            except: tg = "최근"
            items.append({"summary":changes[0] if changes else "비중 변경",
                          "detail":f"{by or 'manual'} / {reason or '적용 완료'}",
                          "time_ago":tg,"applied":True})
        conn.close()
        return {"items": items, "changes_today": ct}
    except Exception as e:
        return {"items":[],"changes_today":0,"error":str(e)}

@app.post("/api/personas/weight")
async def persona_update_weight(payload: dict):
    market = payload.get("market")
    weights = payload.get("weights", {})
    if market not in ("coin","kr","us"):
        raise HTTPException(400, "Invalid market")
    if sum(weights.values()) != 100:
        raise HTTPException(400, f"합계 100% 필요 (현재 {sum(weights.values())}%)")
    for p, v in weights.items():
        if not (5 <= v <= 60):
            raise HTTPException(400, f"{p}: 5~60% 범위 (현재 {v}%)")
    db_path = _persona_db(market)
    conn = _sql.connect(db_path); cur = conn.cursor()
    cur.execute("""SELECT COUNT(*) FROM persona_weight_history
        WHERE market=? AND DATE(applied_at)=DATE('now','localtime')""", (market,))
    if cur.fetchone()[0] >= 3:
        conn.close()
        raise HTTPException(429, "하루 3회 한도 초과")
    apply_at = _next_market_open(market)
    cur.execute("""INSERT INTO persona_weight_pending(market,weights_json,apply_at,created_by)
        VALUES(?,?,?,'manual')""", (market, _j.dumps(weights), apply_at.isoformat()))
    conn.commit(); conn.close()
    return {"status":"scheduled", "apply_at":apply_at.isoformat(),
            "apply_at_kr":apply_at.strftime("%m/%d %H:%M"),
            "message":"다음 시장 진입부터 적용"}


@app.post("/api/positions/cancel")
async def cancel_close(req: dict) -> dict:
    """청산 예약 취소."""
    bot = req.get("bot", "")
    symbol = req.get("symbol", "")
    db_path = COIN_DB if bot == "coin" else STOCK_DB
    col_name = "coin" if bot == "coin" else "stock"
    try:
        with _sqlite3.connect(db_path) as conn:
            r = conn.execute(
                f"UPDATE positions SET pending_sell=0 WHERE {col_name}=?",
                (symbol,)
            )
            conn.commit()
            updated = r.rowcount
        return {"ok": True, "canceled": updated}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/positions/scheduled")
def list_scheduled() -> dict:
    """청산 예약 목록 (양봇)."""
    out = {"coin": [], "stock": []}
    for bot, db_path, col in [("coin", COIN_DB, "coin"), ("stock", STOCK_DB, "stock")]:
        try:
            with _sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    f"SELECT {col} FROM positions WHERE pending_sell=1"
                ).fetchall()
                out[bot] = [r[0] for r in rows]
        except Exception:
            pass
    return out


@app.post("/system/start")
def start() -> dict:
    return _run_script(START_SH)


@app.post("/system/stop")
def stop() -> dict:
    return _run_script(STOP_SH, timeout=15)


@app.post("/system/restart")
def restart() -> dict:
    stop_r = _run_script(STOP_SH, timeout=15)
    start_r = _run_script(START_SH)
    return {
        "ok": stop_r["ok"] and start_r["ok"],
        "stop": stop_r,
        "start": start_r,
    }


@app.post("/system/restart/{name}")
def restart_one(name: str) -> dict:
    if name not in PROCESSES:
        raise HTTPException(400, f"알수없는 프로세스: {name}")

    pid = _read_pid(name)
    if pid and _is_alive(pid):
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        import time
        time.sleep(1)
        if _is_alive(pid):
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass

    pidfile = PID_DIR / f"{name}.pid"
    if pidfile.exists():
        pidfile.unlink()

    # start-all.sh 가 알아서 빠진 것만 다시 띄움
    return _run_script(START_SH)


@app.post("/system/autoload/on")
def autoload_on() -> dict:
    if not PLIST.exists():
        raise HTTPException(404, f"plist 없음: {PLIST}")
    try:
        r = subprocess.run(
            ["launchctl", "load", "-w", str(PLIST)],
            capture_output=True, text=True, timeout=5,
        )
        return {"ok": True, "enabled": _autoload_enabled(),
                "stdout": r.stdout, "stderr": r.stderr}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/system/autoload/off")
def autoload_off() -> dict:
    try:
        r = subprocess.run(
            ["launchctl", "unload", "-w", str(PLIST)],
            capture_output=True, text=True, timeout=5,
        )
        return {"ok": True, "enabled": _autoload_enabled(),
                "stdout": r.stdout, "stderr": r.stderr}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/system/log/{name}")
def get_log(name: str, tail: int = 100) -> dict:
    """name: coinbot-main / coinbot-api / stockbot-main / stockbot-api / launchd"""
    log_path = LOG_DIR / f"{name}.log"
    if not log_path.exists():
        return {"name": name, "lines": [], "msg": "로그 파일 없음"}
    try:
        r = subprocess.run(
            ["tail", "-n", str(min(tail, 500)), str(log_path)],
            capture_output=True, text=True, timeout=3,
        )
        return {"name": name, "lines": r.stdout.split("\n")[-tail:]}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── 봇 API 프록시 (모바일/외부 접근용) ────────────────────
@app.api_route("/api/{bot}/{path:path}", methods=["GET", "POST"])
async def bot_proxy(bot: str, path: str, request: Request) -> Response:
    """봇 API를 프록시. 봇 API는 127.0.0.1에 묶어두고 system_api만 LAN 노출.

    GET/POST  /api/coin/health       → :9001/health
    GET/POST  /api/coin/status       → :9001/status
    POST      /api/coin/mode/run     → :9001/mode/run  (등)
    """
    if bot not in BOT_APIS:
        raise HTTPException(404, f"unknown bot: {bot}")

    target = f"{BOT_APIS[bot]}/{path}"
    body = await request.body() if request.method == "POST" else None

    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.request(
                request.method, target,
                content=body,
                params=dict(request.query_params),
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(
                content=r.content,
                status_code=r.status_code,
                media_type=r.headers.get("content-type", "application/json"),
            )
        except httpx.ConnectError:
            raise HTTPException(503, f"{bot} bot offline (port {target})")


# ── 토큰 사용량 조회 (선택, MVP 단순) ─────────────────────
@app.get("/system/tokens")
def tokens() -> dict:
    """LLM 토큰 사용량 추정.
    각 봇의 status.json 안 'llm_calls_today' 또는 logs/llm_*.log 카운트.
    MVP: status에서 llm_log 합산, 봇별 분리.
    """
    import json
    out = {"coin": {"calls": 0, "denied": 0}, "stock": {"calls": 0, "denied": 0}}

    for bot, base in [("coin", "/Users/600mac/coinbot/docs/status.json"),
                      ("stock", "/Users/600mac/Desktop/주식 자동봇/docs/status.json")]:
        p = Path(base)
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            llm = data.get("llm_log") or data.get("llm_calls", [])
            if isinstance(llm, list):
                out[bot]["calls"] = len(llm)
                out[bot]["denied"] = sum(1 for x in llm if x.get("verdict") == "DENY")
            elif isinstance(llm, dict):
                out[bot]["calls"] = llm.get("count", 0)
                out[bot]["denied"] = llm.get("denied", 0)
        except Exception:
            pass

    out["total_calls"] = out["coin"]["calls"] + out["stock"]["calls"]
    out["total_denied"] = out["coin"]["denied"] + out["stock"]["denied"]
    # Sonnet 4.6 추정 (입력 500 + 출력 50 토큰/회, $0.0023/회)
    out["est_tokens"] = out["total_calls"] * 550
    out["est_cost_usd"] = round(out["total_calls"] * 0.0023, 4)
    # Max 5x 환산 (1일 ~900 메시지)
    out["max_5x_pct"] = round(out["total_calls"] / 9.0, 1)  # 900의 1% 단위
    return out


# ── 시장 지표 (비트/알트 + 주식/거시) ─────────────────────
@app.get("/system/market")
async def market() -> dict:
    """공개 API에서 시장 지표 수집.

    [코인]  BTC 단독 / 알트 평균 (ETH+XRP+SOL+DOGE+ADA) / 공포탐욕
    [거시]  KOSPI / NASDAQ / USD/KRW
    """
    out = {"btc": None, "btc_24h": None,
           "alt_avg_24h": None, "alt_tracked": 0,
           "kospi": None, "kospi_chg": None,
           "nasdaq": None, "nasdaq_chg": None,
           "usd_krw": None, "vix": None, "fear_greed": None}

    ALTS = ["KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE", "KRW-ADA"]

    async with httpx.AsyncClient(timeout=3.0) as client:
        # BTC + 알트 한 번에 (Upbit)
        try:
            markets_param = "KRW-BTC," + ",".join(ALTS)
            r = await client.get(f"https://api.upbit.com/v1/ticker?markets={markets_param}")
            if r.status_code == 200:
                alt_changes = []
                for d in r.json():
                    code = d.get("market", "")
                    if code == "KRW-BTC":
                        out["btc"] = d["trade_price"]
                        out["btc_24h"] = d["signed_change_rate"]
                    elif code in ALTS:
                        alt_changes.append(d["signed_change_rate"])
                if alt_changes:
                    out["alt_avg_24h"] = sum(alt_changes) / len(alt_changes)
                    out["alt_tracked"] = len(alt_changes)
        except Exception:
            pass

        # 공포탐욕지수
        try:
            r = await client.get("https://api.alternative.me/fng/")
            if r.status_code == 200:
                out["fear_greed"] = int(r.json()["data"][0]["value"])
        except Exception:
            pass

        # KOSPI / NASDAQ / 환율 - yfinance 대신 stooq (무료, CORS 없음)
        for sym, key, chg_key in [
            ("^kospi", "kospi", "kospi_chg"),
            ("^ndq", "nasdaq", "nasdaq_chg"),
        ]:
            try:
                r = await client.get(f"https://stooq.com/q/l/?s={sym}&f=sd2t2ohlcv&h&e=csv")
                if r.status_code == 200 and r.text:
                    lines = r.text.strip().split("\n")
                    if len(lines) >= 2:
                        cols = lines[1].split(",")
                        if len(cols) >= 7 and cols[6] not in ("N/D", ""):
                            close = float(cols[6])
                            opn = float(cols[3]) if cols[3] not in ("N/D","") else close
                            out[key] = close
                            out[chg_key] = (close - opn) / opn if opn else 0
            except Exception:
                pass

        # USD-KRW
        try:
            r = await client.get("https://stooq.com/q/l/?s=usdkrw&f=sd2t2ohlc&h&e=csv")
            if r.status_code == 200:
                lines = r.text.strip().split("\n")
                if len(lines) >= 2:
                    cols = lines[1].split(",")
                    if len(cols) >= 6 and cols[5] not in ("N/D", ""):
                        out["usd_krw"] = float(cols[5])
        except Exception:
            pass

    # yfinance 폴백 (stooq N/D 시 — 주말/장마감)
    if out.get("kospi") is None or out.get("nasdaq") is None or out.get("usd_krw") is None:
        try:
            import yfinance as yf
            for label, sym in [("kospi", "^KS11"), ("nasdaq", "^IXIC"),
                                ("usd_krw", "KRW=X"), ("vix", "^VIX")]:
                if out.get(label) is not None:
                    continue
                try:
                    h = yf.Ticker(sym).history(period="2d")
                    if len(h) >= 1:
                        cur = float(h["Close"].iloc[-1])
                        out[label] = round(cur, 2)
                        if len(h) >= 2 and label in ("kospi", "nasdaq"):
                            prev = float(h["Close"].iloc[-2])
                            out[f"{label}_chg"] = (cur - prev) / prev if prev else 0
                except Exception:
                    pass
        except ImportError:
            pass

    return out


# ── 인사이트 (양 봇 합산 분석) ─────────────────────────────
@app.get("/system/insights")
def insights() -> dict:
    """봇별/통합 승률/RR/MDD/페르소나 성과/시간대 활성도."""
    import json
    from collections import defaultdict

    out = {"by_bot": {}, "combined": {}, "hourly": [0]*24, "personas": {}}

    for bot, base in [("coin", "/Users/600mac/coinbot/docs/status.json"),
                      ("stock", "/Users/600mac/Desktop/주식 자동봇/docs/status.json")]:
        p = Path(base)
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue

        trades = data.get("recent_trades", [])
        sells = [t for t in trades if t.get("side") == "SELL" or t.get("pnl") is not None]

        wins = [t for t in sells if (t.get("pnl") or 0) > 0]
        losses = [t for t in sells if (t.get("pnl") or 0) < 0]
        n = len(sells)

        winrate = len(wins) / n if n else 0
        avg_win = sum(t.get("pnl",0) for t in wins) / len(wins) if wins else 0
        avg_loss = abs(sum(t.get("pnl",0) for t in losses) / len(losses)) if losses else 1
        rr = avg_win / avg_loss if avg_loss else 0

        # MDD (최근 거래 누적 P&L 기반)
        equity, peak, mdd = 0, 0, 0
        for t in sorted(trades, key=lambda x: x.get("ts","") or x.get("created_at","")):
            equity += (t.get("pnl") or 0)
            peak = max(peak, equity)
            dd = (peak - equity) / abs(peak) if peak else 0
            mdd = max(mdd, dd)

        out["by_bot"][bot] = {
            "trades": n,
            "wins": len(wins),
            "losses": len(losses),
            "winrate": winrate,
            "rr": rr,
            "avg_win": avg_win,
            "avg_loss": -avg_loss,
            "mdd": mdd,
            "today_pnl": data.get("today_pnl", 0),
            "total_pnl": data.get("total_pnl", 0),
        }

        # 시간대 히트맵 (시간별 거래수)
        for t in trades:
            ts = t.get("created_at") or t.get("ts") or ""
            if len(ts) >= 13:
                try:
                    h = int(ts[11:13])
                    out["hourly"][h] += 1
                except ValueError:
                    pass

        # 페르소나별 성과
        for t in sells:
            persona = t.get("persona") or "기타"
            if persona not in out["personas"]:
                out["personas"][persona] = {"trades":0, "wins":0, "pnl":0, "bot":bot}
            p_data = out["personas"][persona]
            p_data["trades"] += 1
            if (t.get("pnl") or 0) > 0:
                p_data["wins"] += 1
            p_data["pnl"] += t.get("pnl") or 0

    # 합산
    total_trades = sum(b["trades"] for b in out["by_bot"].values())
    total_wins = sum(b["wins"] for b in out["by_bot"].values())
    out["combined"] = {
        "trades": total_trades,
        "winrate": total_wins / total_trades if total_trades else 0,
        "today_pnl": sum(b["today_pnl"] for b in out["by_bot"].values()),
        "total_pnl": sum(b["total_pnl"] for b in out["by_bot"].values()),
        "max_mdd": max((b["mdd"] for b in out["by_bot"].values()), default=0),
    }

    return out


# ── 봇 프로세스 상태 (좀비/중복 감지) ─────────────────────
@app.get("/system/processes")
async def system_processes() -> dict:
    """양봇 프로세스 가동 상태 + 중복(좀비) 감지."""
    import subprocess
    # ps -e + 명령줄 정확 substring 매칭
    try:
        r = subprocess.run(["ps", "-e", "-o", "pid=,command="],
                           capture_output=True, text=True, timeout=3)
        all_procs = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line: continue
            parts = line.split(None, 1)
            if len(parts) >= 2:
                all_procs.append((parts[0], parts[1]))
    except Exception:
        all_procs = []

    def _find(needle, exclude=""):
        return [pid for pid, cmd in all_procs
                if "python" in cmd.lower() and needle in cmd
                and (not exclude or exclude not in cmd)]

    # ps 명령줄에 한글 경로(주식 자동봇) 안 나옴 → 단순 매칭 사용
    def _ends_with(suffix):
        return [pid for pid, cmd in all_procs
                if "python" in cmd.lower() and cmd.rstrip().endswith(suffix)]
    # system-api/stockbot-api는 포트 LISTEN으로 (uvicorn worker 다수 회피)
    def _port_listen(port):
        for lsof_path in ("/usr/sbin/lsof", "/usr/bin/lsof", "lsof"):
            try:
                r = subprocess.run([lsof_path, "-ti", f":{port}"],
                                   capture_output=True, text=True, timeout=2)
                pids = [p.strip() for p in r.stdout.splitlines() if p.strip()]
                if pids:
                    return pids[:1]
            except FileNotFoundError:
                continue
            except Exception:
                return []
        return []
    targets = [
        ("coinbot",         lambda: _find("-m core.bot"),        1),
        ("stockbot-main",   lambda: _ends_with("run.py"),        1),
        ("stockbot-api",    lambda: _port_listen(9002),          1),
        ("system-api",      lambda: _port_listen(9000),          1),
        ("firebase-bridge", lambda: _find("firebase_bridge.py"), 1),
    ]
    out = []
    overall_ok = True
    for name, getter, expected in targets:
        try:
            pids = getter() or []
        except Exception:
            pids = []
        running = len(pids)
        if running == expected:
            status = "ok"
        elif running == 0:
            status = "down"; overall_ok = False
        elif running > expected:
            status = "duplicate"; overall_ok = False
        else:
            status = "warn"; overall_ok = False
        # 각 PID의 시작 시각
        proc_info = []
        for pid in pids[:5]:
            try:
                p = subprocess.run(
                    ["ps", "-p", pid, "-o", "pid=,lstart="],
                    capture_output=True, text=True, timeout=1
                )
                line = p.stdout.strip()
                if line:
                    parts = line.split(None, 1)
                    proc_info.append({"pid": int(parts[0]), "started": parts[1] if len(parts)>1 else ""})
            except Exception:
                proc_info.append({"pid": int(pid), "started": ""})
        out.append({
            "name": name, "expected": expected, "running": running,
            "status": status, "processes": proc_info,
        })
    return {"ok": overall_ok, "processes": out}


@app.post("/system/processes/cleanup_zombies")
async def cleanup_zombies() -> dict:
    """중복(좀비) 봇 자동 정리 — 가장 오래된 PID 유지, 나머지 kill."""
    import subprocess
    killed = []
    targets = [
        ("coinbot", "python.*-m core\\.bot", 1),
        ("stockbot-main", "python.*run\\.py$", 1),
        ("stockbot-api", "python.*run\\.py api", 1),
    ]
    for name, pattern, expected in targets:
        try:
            r = subprocess.run(
                ["pgrep", "-f", pattern],
                capture_output=True, text=True, timeout=2
            )
            pids = [int(p.strip()) for p in r.stdout.splitlines() if p.strip()]
            if len(pids) > expected:
                # 작은 PID = 오래된 프로세스(보통). 큰 PID부터 kill (= 최신 좀비 정리)
                # 또는 가장 최근 PID 유지하려면 정렬 후 가장 큰 거 빼고 kill
                # 안전: 오래된 거 유지 (먼저 시작한 게 진짜)
                pids.sort()
                for p in pids[expected:]:
                    try:
                        subprocess.run(["kill", "-9", str(p)], timeout=2)
                        killed.append({"name": name, "pid": p})
                    except Exception:
                        pass
        except Exception:
            pass
    return {"ok": True, "killed": killed, "count": len(killed)}


# ── 외부 의존 헬스 체크 (막힘 모니터링) ────────────────────
@app.get("/system/healthcheck")
async def healthcheck() -> dict:
    """모든 외부 의존 응답 검증 — 대시보드 시스템 뷰에서 모니터링."""
    import time as _time
    out = {}

    async with httpx.AsyncClient(timeout=4.0) as client:
        # KIS
        t0 = _time.time()
        try:
            r = await client.get("https://openapi.koreainvestment.com:9443/", timeout=3)
            ok = r.status_code in (200, 404, 500)  # 200/404는 정상, 500은 서버 살아있음
            out["kis"] = {"ok": True, "ms": int((_time.time()-t0)*1000),
                          "note": f"HTTP {r.status_code}"}
        except Exception as e:
            out["kis"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                          "note": str(e)[:80]}

        # Upbit
        t0 = _time.time()
        try:
            r = await client.get("https://api.upbit.com/v1/ticker?markets=KRW-BTC", timeout=3)
            out["upbit"] = {"ok": r.status_code == 200,
                            "ms": int((_time.time()-t0)*1000),
                            "note": f"HTTP {r.status_code}"}
        except Exception as e:
            out["upbit"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                            "note": str(e)[:80]}

        # Ollama
        t0 = _time.time()
        try:
            r = await client.get("http://127.0.0.1:11434/api/version", timeout=2)
            out["ollama"] = {"ok": r.status_code == 200,
                             "ms": int((_time.time()-t0)*1000),
                             "note": r.json().get("version", "")}
        except Exception as e:
            out["ollama"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                             "note": str(e)[:80]}

        # Gemini — ListModels로 키 유효성만 확인 (generateContent quota 안 잡아먹음)
        # + 60초 캐시 (대시보드 30초 폴링이 quota 다 쓰는 사고 방지)
        t0 = _time.time()
        try:
            global _GEMINI_HEALTH_CACHE
            cached = globals().get("_GEMINI_HEALTH_CACHE", {"ts": 0, "data": None})
            if _time.time() - cached["ts"] < 60 and cached.get("data"):
                out["gemini"] = cached["data"]
            else:
                from pathlib import Path as _P
                env = _P.home() / "Developer/my-company/company-hq/server/.env"
                bot_key = ""
                shared_key = ""
                if env.exists():
                    for line in env.read_text().splitlines():
                        if line.startswith("GEMINI_API_KEY_BOT="):
                            bot_key = line.split("=", 1)[1].strip()
                        elif line.startswith("GEMINI_API_KEY="):
                            shared_key = line.split("=", 1)[1].strip()
                key = bot_key or shared_key
                key_label = "BOT 키" if bot_key else "공용 키"
                if key:
                    # ListModels는 generateContent quota 영향 없음 — 키 유효성만 체크
                    r = await client.get(
                        f"https://generativelanguage.googleapis.com/v1beta/models?key={key}",
                        timeout=5)
                    ms = int((_time.time()-t0)*1000)
                    if r.status_code == 200:
                        result = {"ok": True, "ms": ms, "note": f"{key_label} 유효 (모델 목록 OK)"}
                    elif r.status_code == 403:
                        result = {"ok": False, "ms": ms, "note": f"403 키 무효 ({key_label})"}
                    elif r.status_code == 429:
                        result = {"ok": False, "ms": ms, "note": f"429 (List API 한도, generateContent와 별개)"}
                    else:
                        result = {"ok": False, "ms": ms, "note": f"HTTP {r.status_code} ({key_label})"}
                else:
                    result = {"ok": False, "ms": 0, "note": "키 없음"}
                _GEMINI_HEALTH_CACHE = {"ts": _time.time(), "data": result}
                out["gemini"] = result
        except Exception as e:
            out["gemini"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                             "note": str(e)[:80]}

        # Firestore
        t0 = _time.time()
        try:
            r = await client.get(
                "https://firestore.googleapis.com/v1/projects/datemap-759bf/databases/(default)/documents/trading_status/coin?key=AIzaSyAF6096bC-Q04qWXh5MjVsuJGhYBy76agM",
                timeout=4)
            out["firestore"] = {"ok": r.status_code == 200,
                                "ms": int((_time.time()-t0)*1000),
                                "note": f"HTTP {r.status_code}"}
        except Exception as e:
            out["firestore"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                                "note": str(e)[:80]}

        # GitHub Pages
        t0 = _time.time()
        try:
            r = await client.get("https://600-g.github.io/trading-dashboard/", timeout=3)
            out["github_pages"] = {"ok": r.status_code == 200,
                                   "ms": int((_time.time()-t0)*1000),
                                   "note": f"HTTP {r.status_code}"}
        except Exception as e:
            out["github_pages"] = {"ok": False, "ms": int((_time.time()-t0)*1000),
                                   "note": str(e)[:80]}

    out["all_ok"] = all(v["ok"] for v in out.values() if isinstance(v, dict))
    return out


# ── 정적 파일 서빙 (대시보드) ────────────────────────────
# 마지막에 마운트해야 위 라우트가 우선
DASH_DIR = Path(__file__).resolve().parent
app.mount("/", StaticFiles(directory=str(DASH_DIR), html=True), name="static")


def serve(host: str = "0.0.0.0", port: int = 9000) -> None:
    """기본값 0.0.0.0 — LAN 안의 폰/태블릿에서 접근 가능.
    봇 API는 여전히 127.0.0.1만 노출되며, 이 시스템 API의 /api/* 프록시를 통해 호출됨.
    """
    import uvicorn
    print(f"=== 두근 트레이딩 시스템 API ===")
    print(f"  로컬:    http://127.0.0.1:{port}")
    print(f"  LAN:     http://{_lan_ip()}:{port}  ← 폰/태블릿에서 접근")
    print(f"  대시보드: http://{_lan_ip()}:{port}/index.html")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    serve()
