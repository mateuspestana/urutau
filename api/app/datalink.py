# Autor: Matheus C. Pestana
"""Datalink de aviação: mensagens ACARS (acarsdec) e VDL Modo 2 (dumpvdl2).

Os dois decodificadores escrevem uma linha JSON por mensagem no stdout. `parse_*` normaliza
para um formato só, `ingest` grava em SQLite (`/data/datalink.db`, separado do registro
ADS-B para não disputar a mesma trava) e guarda o JSON original para o detalhe na UI.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections import deque
from typing import Any

from . import store

DB_PATH = store.DATA / "datalink.db"

# Faixas e padrões. O RTL-SDR amostra ~2 MHz por vez: todas as frequências de uma sessão
# precisam caber nessa janela (o acarsdec e o dumpvdl2 centralizam sozinhos).
MAX_SPAN_MHZ = 1.8
DEFAULT_FREQS = {
    "acars": [131.550, 131.725, 131.825, 131.450, 131.125, 130.450, 130.425, 130.025],
    "vdl2": [136.975, 136.925, 136.875, 136.825, 136.775, 136.725],
}
BAND = {"acars": (129.0, 137.0), "vdl2": (136.0, 137.0)}

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  source TEXT NOT NULL,          -- acars | vdl2
  kind TEXT,                     -- acars | xid | x25 | cpdlc | adsc | frame
  freq_mhz REAL,
  level REAL,                    -- dB (acarsdec: nível; dumpvdl2: sinal)
  noise REAL,
  uplink INTEGER,                -- 1 = solo → aeronave
  hex TEXT,                      -- endereço ICAO (VDL2 traz; ACARS não)
  reg TEXT,
  flight TEXT,
  label TEXT,
  block TEXT,
  msgno TEXT,
  text TEXT,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_dl_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS ix_dl_reg ON messages(reg);
CREATE INDEX IF NOT EXISTS ix_dl_flight ON messages(flight);
CREATE INDEX IF NOT EXISTS ix_dl_hex ON messages(hex);
"""

COLS = ("id", "ts", "source", "kind", "freq_mhz", "level", "noise", "uplink", "hex", "reg",
        "flight", "label", "block", "msgno", "text")

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

# estado da sessão atual (some ao trocar de modo)
live: dict[str, Any] = {"source": None, "started": 0.0, "count": 0, "bad": 0, "last_ts": 0.0}
decoder_log: deque[str] = deque(maxlen=30)


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.executescript(SCHEMA)
        _conn.commit()
    return _conn


def init() -> None:
    with _lock:
        _db()


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.commit()
            _conn.close()
            _conn = None


def reset_live(source: str | None) -> None:
    live.update(source=source, started=time.time() if source else 0.0, count=0, bad=0, last_ts=0.0)
    decoder_log.clear()


def check_freqs(source: str, freqs: list[float]) -> str:
    """Devolve a mensagem de erro, ou "" se a lista serve."""
    if not freqs:
        return "informe ao menos uma frequência"
    if len(freqs) > 16:
        return "no máximo 16 canais"
    lo, hi = BAND[source]
    bad = [f for f in freqs if not lo <= f <= hi]
    if bad:
        return f"fora da faixa {lo}–{hi} MHz: {', '.join(f'{f:.3f}' for f in bad)}"
    span = max(freqs) - min(freqs)
    if span > MAX_SPAN_MHZ:
        return f"as frequências cobrem {span:.3f} MHz; o dongle só enxerga {MAX_SPAN_MHZ} MHz de uma vez"
    return ""


def _clean(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip().strip(".").strip()
    return v or None


def _num(v: Any) -> float | None:
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def _has_key(obj: Any, key: str, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if isinstance(obj, dict):
        return key in obj or any(_has_key(v, key, depth + 1) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_key(v, key, depth + 1) for v in obj)
    return False


def _app_kind(obj: Any) -> str | None:
    for key, kind in (("cpdlc", "cpdlc"), ("adsc", "adsc"), ("adsc_v2", "adsc")):
        if _has_key(obj, key):
            return kind
    return None


def parse_acarsdec(o: dict[str, Any]) -> dict[str, Any]:
    blk = _clean(o.get("block_id"))
    # bloco numérico = aeronave → solo; letra = solo → aeronave
    uplink = None if blk is None else int(not blk.isdigit())
    return {
        "ts": _num(o.get("timestamp")) or time.time(),
        "source": "acars",
        "kind": _app_kind(o.get("libacars")) or "acars",
        "freq_mhz": _num(o.get("freq")),
        "level": _num(o.get("level")),
        "noise": None,
        "uplink": uplink,
        "hex": _clean(o.get("icao")) if isinstance(o.get("icao"), str) else None,
        "reg": _clean(o.get("tail")),
        "flight": _clean(o.get("flight")),
        "label": o.get("label") if isinstance(o.get("label"), str) else None,
        "block": blk,
        "msgno": _clean(o.get("msgno")),
        "text": o.get("text") if isinstance(o.get("text"), str) else None,
    }


def parse_vdl2(o: dict[str, Any]) -> dict[str, Any]:
    v = o.get("vdl2") or {}
    avlc = v.get("avlc") or {}
    src, dst = avlc.get("src") or {}, avlc.get("dst") or {}
    src_air = "aircraft" in str(src.get("type", "")).lower()
    dst_air = "aircraft" in str(dst.get("type", "")).lower()
    hex_id = src.get("addr") if src_air else dst.get("addr") if dst_air else None
    t = v.get("t") or {}
    ts = (t.get("sec") or 0) + (t.get("usec") or 0) / 1e6 or time.time()
    freq = _num(v.get("freq"))
    acars = avlc.get("acars")
    base = {
        "ts": ts,
        "source": "vdl2",
        "freq_mhz": round(freq / 1e6, 3) if freq else None,
        "level": _num(v.get("sig_level")),
        "noise": _num(v.get("noise_level")),
        "uplink": int(not src_air) if (src_air or dst_air) else None,
        "hex": hex_id.lower() if isinstance(hex_id, str) else None,
    }
    if isinstance(acars, dict):
        return base | {
            "kind": _app_kind(acars) or "acars",
            "reg": _clean(acars.get("reg")),
            "flight": _clean(acars.get("flight")),
            "label": acars.get("label"),
            "block": _clean(acars.get("blk_id")),
            "msgno": _clean(acars.get("msg_num")),
            "text": acars.get("msg_text"),
        }
    if "xid" in avlc:
        xid = avlc.get("xid") or {}
        kind, text = "xid", xid.get("type_descr") or "XID"
    elif "x25" in avlc:
        kind, text = _app_kind(avlc["x25"]) or "x25", "X.25"
    else:
        kind, text = "frame", f"AVLC {avlc.get('frame_type', '?')}"
    return base | {"kind": kind, "reg": None, "flight": None, "label": None, "block": None,
                   "msgno": None, "text": text}


def ingest_line(source: str, line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line.startswith("{"):
        if line:
            decoder_log.append(line[:300])
        return None
    try:
        obj = json.loads(line)
        msg = parse_vdl2(obj) if source == "vdl2" else parse_acarsdec(obj)
    except Exception:
        live["bad"] += 1
        return None
    with _lock:
        db = _db()
        cur = db.execute(
            "INSERT INTO messages(ts, source, kind, freq_mhz, level, noise, uplink, hex, reg, flight,"
            " label, block, msgno, text, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (msg["ts"], msg["source"], msg["kind"], msg["freq_mhz"], msg["level"], msg["noise"],
             msg["uplink"], msg["hex"], msg["reg"], msg["flight"], msg["label"], msg["block"],
             msg["msgno"], msg["text"], line),
        )
        db.commit()
    live["count"] += 1
    live["last_ts"] = msg["ts"]
    return msg | {"id": cur.lastrowid}


def query(after_id: int = 0, source: str | None = None, q: str | None = None,
          control: bool = True, limit: int = 200) -> list[dict[str, Any]]:
    """Mais novas primeiro. `after_id` traz só o que chegou depois (poll incremental)."""
    where, args = ["id > ?"], [after_id]
    if source in ("acars", "vdl2"):
        where.append("source = ?")
        args.append(source)
    if not control:  # esconde quadros de controle do VDL2 e ACARS vazios
        where.append("kind NOT IN ('xid','frame','x25') AND COALESCE(TRIM(text),'') <> ''")
    if q:
        like = f"%{q.strip()}%"
        where.append("(reg LIKE ? OR flight LIKE ? OR hex LIKE ? OR label LIKE ? OR text LIKE ?)")
        args += [like] * 5
    sql = f"SELECT {', '.join(COLS)} FROM messages WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?"
    with _lock:
        rows = _db().execute(sql, (*args, limit)).fetchall()
    return [dict(r) for r in rows]


def raw(msg_id: int) -> Any:
    with _lock:
        row = _db().execute("SELECT raw FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["raw"])
    except ValueError:
        return row["raw"]


def stats() -> dict[str, Any]:
    now = time.time()
    with _lock:
        db = _db()
        tot = db.execute(
            "SELECT COUNT(*) n, MIN(ts) since,"
            " SUM(source='acars') acars, SUM(source='vdl2') vdl2,"
            " SUM(ts > ?) last1h, SUM(ts > ?) last24h FROM messages",
            (now - 3600, now - 86400),
        ).fetchone()
        uniq = db.execute(
            "SELECT COUNT(DISTINCT COALESCE(reg, hex, flight)) FROM messages"
            " WHERE ts > ? AND COALESCE(reg, hex, flight) IS NOT NULL",
            (now - 86400,),
        ).fetchone()[0]
        session = live["started"] or now
        freqs = db.execute(
            "SELECT freq_mhz, COUNT(*) n, AVG(level) level, MAX(ts) last FROM messages"
            " WHERE ts >= ? AND source = ? GROUP BY freq_mhz ORDER BY freq_mhz",
            (session, live["source"] or ""),
        ).fetchall()
        labels = db.execute(
            "SELECT label, COUNT(*) n FROM messages WHERE ts > ? AND label IS NOT NULL"
            " GROUP BY label ORDER BY n DESC LIMIT 12",
            (now - 86400,),
        ).fetchall()
    return {
        "total": tot["n"] or 0,
        "since": tot["since"],
        "acars": tot["acars"] or 0,
        "vdl2": tot["vdl2"] or 0,
        "last1h": tot["last1h"] or 0,
        "last24h": tot["last24h"] or 0,
        "aircraft24h": uniq or 0,
        "session": dict(live),
        "freqs": [dict(r) for r in freqs],
        "labels": [dict(r) for r in labels],
        "log": list(decoder_log),
        "db_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
    }
