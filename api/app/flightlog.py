# Autor: Matheus C. Pestana
"""Registro persistente (SQLite em /data) de toda aeronave vista pelo readsb.

Uma linha em `sightings` por passagem (hex visto continuamente, com buracos < GAP_S),
inclusive aeronaves sem posição. `positions` guarda a trilha amostrada a cada
POS_EVERY_S. `station_events` registra trocas de modo — os buracos em que o ADS-B
estava desligado.
"""
from __future__ import annotations

import csv
import io
import math
import sqlite3
import threading
import time
from typing import Any

from . import store

DB_PATH = store.DATA / "flightlog.db"
GAP_S = 120.0  # sem ver o hex por mais que isso → nova passagem
POS_EVERY_S = 10.0  # intervalo mínimo entre posições gravadas por aeronave
STALE_S = 60.0  # readsb mantém entradas antigas no aircraft.json; ignora se seen > isso
POS_STALE_S = 15.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS sightings (
  id INTEGER PRIMARY KEY,
  hex TEXT NOT NULL,
  flight TEXT,
  registration TEXT,
  type TEXT,
  category TEXT,
  squawk TEXT,
  first_ts REAL NOT NULL,
  last_ts REAL NOT NULL,
  first_lat REAL, first_lon REAL,
  last_lat REAL, last_lon REAL,
  min_km REAL, max_km REAL,
  min_alt INTEGER, max_alt INTEGER,
  max_gs REAL,
  best_rssi REAL,
  messages INTEGER DEFAULT 0,
  samples INTEGER DEFAULT 0,
  pos_samples INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sightings_hex ON sightings(hex, last_ts);
CREATE INDEX IF NOT EXISTS ix_sightings_last ON sightings(last_ts);
CREATE TABLE IF NOT EXISTS positions (
  sighting_id INTEGER NOT NULL REFERENCES sightings(id) ON DELETE CASCADE,
  ts REAL NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  alt INTEGER, gs REAL, track REAL, rssi REAL, km REAL
);
CREATE INDEX IF NOT EXISTS ix_positions_sighting ON positions(sighting_id, ts);
CREATE TABLE IF NOT EXISTS station_events (
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
"""

CSV_FIELDS = (
    "id", "hex", "flight", "registration", "type", "category", "squawk",
    "first_ts", "last_ts", "duration_s", "first_lat", "first_lon", "last_lat", "last_lon",
    "min_km", "max_km", "min_alt", "max_alt", "max_gs", "best_rssi",
    "messages", "samples", "pos_samples",
)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
# hex → estado da passagem aberta
_active: dict[str, dict[str, Any]] = {}


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA foreign_keys=ON")
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


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, str):  # alt_baro pode ser "ground"
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _min(a: float | None, b: float | None) -> float | None:
    return b if a is None else a if b is None else min(a, b)


def _max(a: float | None, b: float | None) -> float | None:
    return b if a is None else a if b is None else max(a, b)


def log_event(kind: str, detail: str = "") -> None:
    with _lock:
        db = _db()
        db.execute("INSERT INTO station_events(ts, kind, detail) VALUES (?,?,?)", (time.time(), kind, detail))
        db.commit()


def ingest(aircraft: list[dict[str, Any]], rx: tuple[float, float] | None, now: float | None = None) -> None:
    """Chamado a cada poll do aircraft.json."""
    now = now or time.time()
    with _lock:
        db = _db()
        for a in aircraft:
            hex_id = (a.get("hex") or "").lower().strip()
            if not hex_id:
                continue
            seen = _num(a.get("seen")) or 0.0
            if seen > STALE_S:
                continue
            ts = now - seen
            flight = a.get("flight").strip() if isinstance(a.get("flight"), str) else None
            alt = _num(a.get("alt_baro"))
            if alt is None:
                alt = _num(a.get("alt_geom"))
            gs = _num(a.get("gs"))
            rssi = _num(a.get("rssi"))
            msgs = int(_num(a.get("messages")) or 0)

            lat, lon = _num(a.get("lat")), _num(a.get("lon"))
            seen_pos = _num(a.get("seen_pos"))
            has_pos = lat is not None and lon is not None and (seen_pos is None or seen_pos <= POS_STALE_S)
            km = round(_haversine_km(rx[0], rx[1], lat, lon), 2) if has_pos and rx else None
            pos_ts = now - (seen_pos or 0.0) if has_pos else None

            st = _active.get(hex_id)
            if st is not None and ts - st["last_ts"] > GAP_S:
                st = None
            if st is None:
                # retoma passagem recente (ex.: API reiniciou no meio de um voo)
                row = db.execute(
                    "SELECT id, last_ts, messages FROM sightings WHERE hex=? ORDER BY last_ts DESC LIMIT 1",
                    (hex_id,),
                ).fetchone()
                if row and ts - row["last_ts"] <= GAP_S:
                    st = {"id": row["id"], "last_ts": row["last_ts"], "last_pos_ts": 0.0,
                          "msg_base": msgs - (row["messages"] or 0)}
                else:
                    cur = db.execute(
                        "INSERT INTO sightings(hex, first_ts, last_ts) VALUES (?,?,?)", (hex_id, ts, ts)
                    )
                    st = {"id": cur.lastrowid, "last_ts": ts, "last_pos_ts": 0.0, "msg_base": msgs}
                _active[hex_id] = st
            if msgs < st["msg_base"]:  # contador do readsb reiniciou
                st["msg_base"] = msgs - (st.get("msg_last", 0) - st["msg_base"])
            st["msg_last"] = msgs
            st["last_ts"] = max(st["last_ts"], ts)

            row = db.execute("SELECT * FROM sightings WHERE id=?", (st["id"],)).fetchone()
            upd: dict[str, Any] = {
                "last_ts": st["last_ts"],
                "flight": flight or row["flight"],
                "registration": a.get("r") or row["registration"],
                "type": a.get("t") or row["type"],
                "category": a.get("category") or row["category"],
                "squawk": a.get("squawk") or row["squawk"],
                "min_alt": _min(row["min_alt"], alt),
                "max_alt": _max(row["max_alt"], alt),
                "max_gs": _max(row["max_gs"], gs),
                "best_rssi": _max(row["best_rssi"], rssi),
                "messages": max(row["messages"] or 0, msgs - st["msg_base"]),
                "samples": (row["samples"] or 0) + 1,
            }
            if has_pos:
                upd.update(
                    last_lat=lat, last_lon=lon,
                    min_km=_min(row["min_km"], km), max_km=_max(row["max_km"], km),
                )
                if row["first_lat"] is None:
                    upd.update(first_lat=lat, first_lon=lon)
                if pos_ts - st["last_pos_ts"] >= POS_EVERY_S:
                    db.execute(
                        "INSERT INTO positions(sighting_id, ts, lat, lon, alt, gs, track, rssi, km)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (st["id"], pos_ts, lat, lon, alt, gs, _num(a.get("track")), rssi, km),
                    )
                    st["last_pos_ts"] = pos_ts
                    upd["pos_samples"] = (row["pos_samples"] or 0) + 1
            cols = ", ".join(f"{k}=?" for k in upd)
            db.execute(f"UPDATE sightings SET {cols} WHERE id=?", (*upd.values(), st["id"]))

        for hex_id in [h for h, s in _active.items() if now - s["last_ts"] > GAP_S]:
            del _active[hex_id]
        db.commit()


def _where(since: float | None, until: float | None, q: str | None) -> tuple[str, list[Any]]:
    clauses, args = [], []
    if since is not None:
        clauses.append("last_ts >= ?")
        args.append(since)
    if until is not None:
        clauses.append("first_ts <= ?")
        args.append(until)
    if q:
        like = f"%{q.strip().lower()}%"
        clauses.append("(lower(hex) LIKE ? OR lower(coalesce(flight,'')) LIKE ?"
                       " OR lower(coalesce(registration,'')) LIKE ? OR lower(coalesce(type,'')) LIKE ?)")
        args += [like] * 4
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", args


def _row(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["duration_s"] = round(d["last_ts"] - d["first_ts"], 1)
    d["active"] = d["hex"] in _active and _active[d["hex"]]["id"] == d["id"]
    return d


def query(since: float | None = None, until: float | None = None, q: str | None = None,
          limit: int = 200, offset: int = 0) -> dict[str, Any]:
    where, args = _where(since, until, q)
    with _lock:
        db = _db()
        total = db.execute(f"SELECT count(*) FROM sightings{where}", args).fetchone()[0]
        rows = db.execute(
            f"SELECT * FROM sightings{where} ORDER BY last_ts DESC LIMIT ? OFFSET ?", (*args, limit, offset)
        ).fetchall()
        return {"total": total, "items": [_row(r) for r in rows]}


def track(sighting_id: int) -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute(
            "SELECT ts, lat, lon, alt, gs, track, rssi, km FROM positions WHERE sighting_id=? ORDER BY ts",
            (sighting_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def events(limit: int = 100) -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute("SELECT * FROM station_events ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


def stats() -> dict[str, Any]:
    day_ago = time.time() - 86400
    with _lock:
        db = _db()
        r = db.execute(
            "SELECT count(*) AS sightings, count(DISTINCT hex) AS unique_hex, min(first_ts) AS since,"
            " sum(CASE WHEN first_lat IS NOT NULL THEN 1 ELSE 0 END) AS with_position,"
            " max(max_km) AS max_km FROM sightings"
        ).fetchone()
        last24 = db.execute(
            "SELECT count(*), count(DISTINCT hex) FROM sightings WHERE last_ts >= ?", (day_ago,)
        ).fetchone()
        positions = db.execute("SELECT count(*) FROM positions").fetchone()[0]
    size = sum(p.stat().st_size for p in DB_PATH.parent.glob(DB_PATH.name + "*") if p.exists())
    return dict(r) | {
        "last24h_sightings": last24[0],
        "last24h_unique": last24[1],
        "positions": positions,
        "active_now": len(_active),
        "db_bytes": size,
    }


def export_csv(since: float | None = None, until: float | None = None, q: str | None = None) -> str:
    where, args = _where(since, until, q)
    with _lock:
        rows = _db().execute(f"SELECT * FROM sightings{where} ORDER BY first_ts", args).fetchall()
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        d = dict(r)
        d["duration_s"] = round(d["last_ts"] - d["first_ts"], 1)
        for k in ("first_ts", "last_ts"):
            d[k] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(d[k]))
        w.writerow(d)
    return buf.getvalue()


def current_trail(hex_id: str) -> dict[str, Any]:
    """Posições da passagem mais recente do hex, se ainda estiver ativa ou acabou há < GAP_S."""
    h = hex_id.lower().strip()
    with _lock:
        db = _db()
        row = db.execute(
            "SELECT id, last_ts FROM sightings WHERE hex=? ORDER BY last_ts DESC LIMIT 1", (h,)
        ).fetchone()
        if not row or time.time() - row["last_ts"] > GAP_S:
            return {"sighting_id": None, "points": []}
        pts = db.execute(
            "SELECT ts, lat, lon, alt, gs, track FROM positions WHERE sighting_id=? ORDER BY ts", (row["id"],)
        ).fetchall()
        return {"sighting_id": row["id"], "points": [dict(p) for p in pts]}
