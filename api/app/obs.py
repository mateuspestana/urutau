# Autor: Matheus C. Pestana
"""Registro comum dos decodificadores que não são ADS-B nem datalink: AIS (navios), APRS,
sensores ISM (rtl_433) e radiossondas.

Cada coisa observada é um *objeto* (`source`, `key`): o navio pelo MMSI, a estação APRS pelo
indicativo, o sensor por modelo+id, a sonda pelo serial. `objects` guarda o estado mesclado
(o último valor de cada campo), `tracks` a trilha amostrada e `messages` as mensagens brutas
(só onde o volume é baixo: AIS manda dezenas por segundo num porto e não grava mensagem).
SQLite em `/data/decoders.db`.
"""
from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
from typing import Any

from . import store

DB_PATH = store.DATA / "decoders.db"
TRACK_EVERY_S = {"ais": 30.0, "aprs": 0.0, "sonde": 2.0}

SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  first_ts REAL NOT NULL,
  last_ts REAL NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  lat REAL, lon REAL, alt REAL,
  pos_ts REAL,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (source, key)
);
CREATE INDEX IF NOT EXISTS ix_obj_last ON objects(source, last_ts);
CREATE TABLE IF NOT EXISTS tracks (
  source TEXT NOT NULL, key TEXT NOT NULL,
  ts REAL NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, alt REAL
);
CREATE INDEX IF NOT EXISTS ix_tracks ON tracks(source, key, ts);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  source TEXT NOT NULL,
  key TEXT,
  text TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg ON messages(source, id);
"""

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
_last_track: dict[tuple[str, str], float] = {}
# contadores da sessão de cada fonte (zerados ao iniciar o modo)
session: dict[str, dict[str, Any]] = {}


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


def start_session(source: str) -> None:
    session[source] = {"started": time.time(), "count": 0, "objects": set(), "last_ts": 0.0}


def _ok(v: Any) -> bool:
    if v is None or v == "":
        return False
    if isinstance(v, float) and not math.isfinite(v):
        return False
    return True


def _coord(lat: Any, lon: Any) -> tuple[float, float] | None:
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    # AIS usa 91/181 como "sem posição"; 0,0 é quase sempre lixo
    if not (-90 <= la <= 90 and -180 <= lo <= 180) or (la == 0 and lo == 0):
        return None
    return la, lo


def record(source: str, key: str, data: dict[str, Any], *, lat: Any = None, lon: Any = None,
           alt: Any = None, ts: float | None = None, text: str | None = None,
           keep_message: bool = False) -> None:
    """Mescla `data` no objeto, grava trilha (amostrada) e, se pedido, a mensagem."""
    ts = ts or time.time()
    clean = {k: v for k, v in data.items() if _ok(v)}
    pos = _coord(lat, lon)
    try:
        alt_f = float(alt) if alt is not None else None
    except (TypeError, ValueError):
        alt_f = None
    with _lock:
        db = _db()
        row = db.execute("SELECT data, n FROM objects WHERE source=? AND key=?", (source, key)).fetchone()
        if row:
            merged = json.loads(row["data"]) | clean
            db.execute(
                "UPDATE objects SET last_ts=MAX(last_ts, ?), n=n+1, data=? WHERE source=? AND key=?",
                (ts, json.dumps(merged, ensure_ascii=False), source, key),
            )
        else:
            db.execute(
                "INSERT INTO objects(source, key, first_ts, last_ts, n, data) VALUES (?,?,?,?,1,?)",
                (source, key, ts, ts, json.dumps(clean, ensure_ascii=False)),
            )
        if pos:
            db.execute(
                "UPDATE objects SET lat=?, lon=?, alt=COALESCE(?, alt), pos_ts=? WHERE source=? AND key=?",
                (pos[0], pos[1], alt_f, ts, source, key),
            )
            every = TRACK_EVERY_S.get(source, 30.0)
            last = _last_track.get((source, key), 0.0)
            if ts - last >= every:
                _last_track[(source, key)] = ts
                db.execute(
                    "INSERT INTO tracks(source, key, ts, lat, lon, alt) VALUES (?,?,?,?,?,?)",
                    (source, key, ts, pos[0], pos[1], alt_f),
                )
        if keep_message:
            db.execute(
                "INSERT INTO messages(ts, source, key, text, data) VALUES (?,?,?,?,?)",
                (ts, source, key, text, json.dumps(data, ensure_ascii=False, default=str)),
            )
        db.commit()
    s = session.get(source)
    if s is not None:
        s["count"] += 1
        s["objects"].add(key)
        s["last_ts"] = ts


def objects(source: str, since: float | None = None, limit: int = 2000) -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute(
            "SELECT * FROM objects WHERE source=? AND last_ts >= ? ORDER BY last_ts DESC LIMIT ?",
            (source, since or 0, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"])
        out.append(d)
    return out


def track(source: str, key: str, since: float | None = None) -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute(
            "SELECT ts, lat, lon, alt FROM tracks WHERE source=? AND key=? AND ts >= ? ORDER BY ts",
            (source, key, since or 0),
        ).fetchall()
    return [dict(r) for r in rows]


def messages(source: str, after_id: int = 0, key: str | None = None, q: str | None = None,
             limit: int = 200) -> list[dict[str, Any]]:
    where, args = ["source=?", "id>?"], [source, after_id]
    if key:
        where.append("key=?")
        args.append(key)
    if q:
        where.append("(key LIKE ? OR text LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    with _lock:
        rows = _db().execute(
            f"SELECT * FROM messages WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?", (*args, limit)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"])
        out.append(d)
    return out


def stats(source: str) -> dict[str, Any]:
    now = time.time()
    with _lock:
        db = _db()
        o = db.execute(
            "SELECT COUNT(*) n, SUM(last_ts > ?) h1, SUM(last_ts > ?) h24, SUM(lat IS NOT NULL) pos, MIN(first_ts) since"
            " FROM objects WHERE source=?",
            (now - 3600, now - 86400, source),
        ).fetchone()
        m = db.execute("SELECT COUNT(*) FROM messages WHERE source=?", (source,)).fetchone()[0]
    s = session.get(source)
    return {
        "objects": o["n"] or 0,
        "last1h": o["h1"] or 0,
        "last24h": o["h24"] or 0,
        "with_position": o["pos"] or 0,
        "since": o["since"],
        "messages": m,
        "session": {"started": s["started"], "count": s["count"], "objects": len(s["objects"]),
                    "last_ts": s["last_ts"]} if s else None,
        "db_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
    }
