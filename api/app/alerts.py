# Autor: Matheus C. Pestana
"""Alertas só no navegador: SQLite em /data/alerts.db, regras em store.config['alerts'].

Sem Telegram, e-mail ou push externo. O front consulta GET /api/alerts e mostra sino/toast/título.
"""
from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
from typing import Any

from . import store

DB_PATH = store.DATA / "alerts.db"

EMERGENCY_SQUAWKS = frozenset({"7500", "7600", "7700"})

# silêncio padrão por kind (segundos); squawk = 30 min
DEFAULT_SILENCE_S: dict[str, float] = {
    "squawk": 1800,
    "military": 1800,
    "watchlist": 1800,
    "low_near": 600,
    "new_ship": 86400 * 365,
    "sonde_new": 86400,
    "sonde_descending": 600,
    "sat_ok": 0,
}

DEFAULT_RULES: dict[str, Any] = {
    "emergency_squawk": True,
    "military": True,
    "watchlist_hex": [],
    "watchlist_reg": [],
    "watchlist_flight": [],
    "low_near_enabled": True,
    "low_near_km": 5.0,
    "low_near_alt_ft": 3000.0,
    "new_ship": True,
    "sonde_enabled": True,
    "sonde_km": 150.0,
    "sonde_descending": True,
    "sat_ok": True,
    "silence_s": dict(DEFAULT_SILENCE_S),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alerts_id ON alerts(id);
CREATE INDEX IF NOT EXISTS ix_alerts_kind_key_ts ON alerts(kind, key, ts);
CREATE INDEX IF NOT EXISTS ix_alerts_seen ON alerts(seen, id);
"""

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


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


def reset_for_tests() -> None:
    """Fecha e apaga o banco — só para pytest."""
    close()
    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        p = DB_PATH.parent / (DB_PATH.name + suffix)
        if p.exists():
            p.unlink()
    init()


def rules() -> dict[str, Any]:
    raw = store.load_config().get("alerts") or {}
    if not isinstance(raw, dict):
        raw = {}
    out = dict(DEFAULT_RULES)
    silence = dict(DEFAULT_SILENCE_S)
    for k, v in raw.items():
        if k == "silence_s" and isinstance(v, dict):
            silence.update({str(sk): float(sv) for sk, sv in v.items()})
        else:
            out[k] = v
    out["silence_s"] = silence
    # listas sempre listas de str
    for lk in ("watchlist_hex", "watchlist_reg", "watchlist_flight"):
        val = out.get(lk) or []
        out[lk] = [str(x).strip() for x in val if str(x).strip()]
    return out


def save_rules(patch: dict[str, Any]) -> dict[str, Any]:
    cur = rules()
    silence = dict(cur.get("silence_s") or DEFAULT_SILENCE_S)
    for k, v in patch.items():
        if k == "silence_s" and isinstance(v, dict):
            silence.update({str(sk): float(sv) for sk, sv in v.items()})
        elif k in DEFAULT_RULES or k == "silence_s":
            cur[k] = v
    cur["silence_s"] = silence
    for lk in ("watchlist_hex", "watchlist_reg", "watchlist_flight"):
        val = cur.get(lk) or []
        cur[lk] = [str(x).strip().upper() if lk == "watchlist_hex" else str(x).strip()
                   for x in val if str(x).strip()]
    store.save_config({"alerts": cur})
    return rules()


def _silence(kind: str, cfg: dict[str, Any] | None = None) -> float:
    cfg = cfg or rules()
    sil = cfg.get("silence_s") or DEFAULT_SILENCE_S
    try:
        return float(sil.get(kind, DEFAULT_SILENCE_S.get(kind, 1800)))
    except (TypeError, ValueError):
        return float(DEFAULT_SILENCE_S.get(kind, 1800))


def _silenced(kind: str, key: str, now: float | None = None, cfg: dict[str, Any] | None = None) -> bool:
    now = now or time.time()
    win = _silence(kind, cfg)
    if win <= 0:
        with _lock:
            row = _db().execute(
                "SELECT 1 FROM alerts WHERE kind=? AND key=? LIMIT 1", (kind, key)
            ).fetchone()
        return row is not None
    cutoff = now - win
    with _lock:
        row = _db().execute(
            "SELECT 1 FROM alerts WHERE kind=? AND key=? AND ts>=? LIMIT 1",
            (kind, key, cutoff),
        ).fetchone()
    return row is not None


def emit(kind: str, key: str, title: str, detail: dict[str, Any] | None = None,
         *, now: float | None = None, cfg: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Grava alerta se a janela de silêncio de (kind, key) permitir. Devolve a linha ou None."""
    now = now or time.time()
    cfg = cfg or rules()
    key = str(key)
    if _silenced(kind, key, now=now, cfg=cfg):
        return None
    detail = detail or {}
    with _lock:
        db = _db()
        cur = db.execute(
            "INSERT INTO alerts(ts, kind, key, title, detail, seen) VALUES (?,?,?,?,?,0)",
            (now, kind, key, title, json.dumps(detail, ensure_ascii=False, default=str)),
        )
        db.commit()
        aid = int(cur.lastrowid)
    return {"id": aid, "ts": now, "kind": kind, "key": key, "title": title, "detail": detail, "seen": 0}


def list_alerts(*, after_id: int = 0, limit: int = 50, unseen_only: bool = False) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    where, args = ["id > ?"], [after_id]
    if unseen_only:
        where.append("seen=0")
    with _lock:
        rows = _db().execute(
            f"SELECT * FROM alerts WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?",
            (*args, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["detail"] = json.loads(d["detail"] or "{}")
        except ValueError:
            d["detail"] = {}
        d["seen"] = bool(d["seen"])
        out.append(d)
    return out


def unseen_count() -> int:
    with _lock:
        return int(_db().execute("SELECT COUNT(*) FROM alerts WHERE seen=0").fetchone()[0])


def mark_seen(ids: list[int] | None = None, *, all_unseen: bool = False) -> int:
    """Marca como visto. Sem ids e all_unseen=True → todos. Devolve quantos atualizou."""
    with _lock:
        db = _db()
        if all_unseen or not ids:
            cur = db.execute("UPDATE alerts SET seen=1 WHERE seen=0")
        else:
            clean = [int(i) for i in ids]
            placeholders = ",".join("?" * len(clean))
            cur = db.execute(f"UPDATE alerts SET seen=1 WHERE id IN ({placeholders}) AND seen=0", clean)
        db.commit()
        return int(cur.rowcount)


def _alt_ft(a: dict[str, Any]) -> float | None:
    alt = a.get("alt_baro")
    if alt is None:
        alt = a.get("alt_geom")
    if alt is None:
        return None
    if isinstance(alt, str) and alt.lower() == "ground":
        return 0.0
    try:
        return float(alt)
    except (TypeError, ValueError):
        return None


def _flight(a: dict[str, Any]) -> str:
    f = a.get("flight")
    return f.strip().upper() if isinstance(f, str) else ""


def on_aircraft(aircraft: list[dict[str, Any]], *, now: float | None = None,
                cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Avalia regras ADS-B no lote atual (após enrich do aircraftdb)."""
    now = now or time.time()
    cfg = cfg or rules()
    rx = store.receiver()
    emitted: list[dict[str, Any]] = []

    wl_hex = {h.upper() for h in (cfg.get("watchlist_hex") or [])}
    wl_reg = {r.upper() for r in (cfg.get("watchlist_reg") or [])}
    wl_flight = [p.upper() for p in (cfg.get("watchlist_flight") or []) if p]

    low_on = bool(cfg.get("low_near_enabled", True))
    try:
        low_km = float(cfg.get("low_near_km") or 5.0)
        low_alt = float(cfg.get("low_near_alt_ft") or 3000.0)
    except (TypeError, ValueError):
        low_km, low_alt = 5.0, 3000.0

    for a in aircraft:
        hex_id = (a.get("hex") or "").strip().lower()
        if not hex_id:
            continue
        flight = _flight(a)
        reg = (a.get("r") or a.get("registration") or "").strip().upper()
        squawk = str(a.get("squawk") or "").strip()

        if cfg.get("emergency_squawk", True) and squawk in EMERGENCY_SQUAWKS:
            row = emit(
                "squawk", f"{hex_id}:{squawk}",
                f"Squawk {squawk} · {flight or hex_id.upper()}",
                {"hex": hex_id, "flight": flight or None, "reg": reg or None, "squawk": squawk,
                 "lat": a.get("lat"), "lon": a.get("lon"), "alt": _alt_ft(a)},
                now=now, cfg=cfg,
            )
            if row:
                emitted.append(row)

        if cfg.get("military", True) and a.get("military"):
            row = emit(
                "military", hex_id,
                f"Militar · {flight or reg or hex_id.upper()}",
                {"hex": hex_id, "flight": flight or None, "reg": reg or None,
                 "type": a.get("t") or a.get("desc"), "lat": a.get("lat"), "lon": a.get("lon")},
                now=now, cfg=cfg,
            )
            if row:
                emitted.append(row)

        watch_hit = None
        if hex_id.upper() in wl_hex:
            watch_hit = "hex"
        elif reg and reg in wl_reg:
            watch_hit = "reg"
        elif flight:
            for pref in wl_flight:
                if flight.startswith(pref):
                    watch_hit = "flight"
                    break
        if watch_hit:
            row = emit(
                "watchlist", hex_id,
                f"Lista · {flight or reg or hex_id.upper()}",
                {"hex": hex_id, "flight": flight or None, "reg": reg or None, "match": watch_hit,
                 "lat": a.get("lat"), "lon": a.get("lon")},
                now=now, cfg=cfg,
            )
            if row:
                emitted.append(row)

        if low_on and rx is not None:
            lat, lon = a.get("lat"), a.get("lon")
            alt = _alt_ft(a)
            if lat is not None and lon is not None and alt is not None:
                try:
                    lat_f, lon_f = float(lat), float(lon)
                except (TypeError, ValueError):
                    continue
                dist = _haversine_km(rx[0], rx[1], lat_f, lon_f)
                if dist < low_km and alt < low_alt:
                    row = emit(
                        "low_near", hex_id,
                        f"Baixo e perto · {flight or hex_id.upper()} ({dist:.1f} km, {int(alt)} ft)",
                        {"hex": hex_id, "flight": flight or None, "reg": reg or None,
                         "km": round(dist, 2), "alt_ft": alt, "lat": lat_f, "lon": lon_f},
                        now=now, cfg=cfg,
                    )
                    if row:
                        emitted.append(row)

    return emitted


def on_obs(source: str, key: str, data: dict[str, Any], *, lat: Any = None, lon: Any = None,
           alt: Any = None, is_new: bool = False, now: float | None = None,
           cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Chamado após obs.record para navios (ais) e sondas."""
    now = now or time.time()
    cfg = cfg or rules()
    emitted: list[dict[str, Any]] = []
    rx = store.receiver()

    if source == "ais" and cfg.get("new_ship", True) and is_new:
        name = data.get("shipname") or data.get("name") or key
        row = emit(
            "new_ship", str(key),
            f"Navio novo · {name}",
            {"mmsi": str(key), "name": name, "lat": lat, "lon": lon, **{k: data.get(k)
             for k in ("shipname", "shiptype", "callsign") if data.get(k)}},
            now=now, cfg=cfg,
        )
        if row:
            emitted.append(row)

    if source == "sonde" and cfg.get("sonde_enabled", True):
        try:
            max_km = float(cfg.get("sonde_km") or 150.0)
        except (TypeError, ValueError):
            max_km = 150.0
        dist = None
        if rx is not None and lat is not None and lon is not None:
            try:
                dist = _haversine_km(rx[0], rx[1], float(lat), float(lon))
            except (TypeError, ValueError):
                dist = None
        near = dist is not None and dist < max_km
        # sem receptor configurado: avisa sonda nova; com receptor: só se estiver perto
        if is_new and (rx is None or near):
            row = emit(
                "sonde_new", str(key),
                f"Sonda nova · {key}" + (f" ({dist:.0f} km)" if dist is not None else ""),
                {"serial": str(key), "km": round(dist, 1) if dist is not None else None,
                 "lat": lat, "lon": lon, "alt": alt, "model": data.get("model")},
                now=now, cfg=cfg,
            )
            if row:
                emitted.append(row)

        if cfg.get("sonde_descending", True) and near:
            vel_v = data.get("vel_v")
            try:
                vv = float(vel_v) if vel_v is not None else None
            except (TypeError, ValueError):
                vv = None
            if vv is not None and vv < -0.5:
                row = emit(
                    "sonde_descending", str(key),
                    f"Sonda descendo · {key} ({dist:.0f} km, {vv:.1f} m/s)",
                    {"serial": str(key), "km": round(dist, 1) if dist is not None else None,
                     "lat": lat, "lon": lon, "alt": alt, "vel_v": vv},
                    now=now, cfg=cfg,
                )
                if row:
                    emitted.append(row)

    return emitted


def on_sat_ok(capture_dir: str, *, sat: str | None = None, images: int = 0,
              now: float | None = None, cfg: dict[str, Any] | None = None) -> dict[str, Any] | None:
    cfg = cfg or rules()
    if not cfg.get("sat_ok", True):
        return None
    label = sat or capture_dir
    return emit(
        "sat_ok", str(capture_dir),
        f"Captura OK · {label}",
        {"dir": capture_dir, "sat": sat, "images": images},
        now=now, cfg=cfg,
    )
