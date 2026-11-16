# Autor: Matheus C. Pestana
"""Retenção diária (~03:30): apaga em lotes e faz VACUUM só se liberar >20%.

Bancos já existentes e inchados antes desta rotina precisam de um VACUUM único
manual (`sqlite3 /data/foo.db 'VACUUM'`) — a rotina não reescreve o arquivo
inteiro em toda passagem.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import alerts, datalink, flightlog, health, obs, range_study, rec, sats, store

BATCH = 5000
VACUUM_THRESHOLD = 0.20  # só VACUUM se liberou ≥ 20% do tamanho anterior
CONFIRM_PHRASE = "APAGAR"

# None = nunca apagar automaticamente
DEFAULT_RETENTION: dict[str, int | None] = {
    "sightings": None,
    "positions": None,
    "range": None,
    "events": 365,
    "datalink": 365,
    "ais": 180,
    "aprs": 180,
    "ism": 90,
    "sonde": 365,
    "alerts": 90,
    "health": 365,
    "sat_empty": 7,  # dias; pastas de captura sem imagem
}


def retention_cfg() -> dict[str, int | None]:
    raw = store.load_config().get("retention") or {}
    out = dict(DEFAULT_RETENTION)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k not in out:
                continue
            if v is None or v == "" or v == 0:
                out[k] = None
            else:
                try:
                    days = int(v)
                except (TypeError, ValueError):
                    continue
                out[k] = None if days <= 0 else days
    return out


def _cutoff(days: int | None) -> float | None:
    if days is None or days <= 0:
        return None
    return time.time() - days * 86400


def _db_file_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.parent.glob(path.name + "*") if p.exists())


def _delete_batches(db: Any, sql: str, args: tuple[Any, ...]) -> int:
    """DELETE ... WHERE id/rowid IN (SELECT ... LIMIT). Devolve total apagado."""
    total = 0
    while True:
        cur = db.execute(sql, (*args, BATCH))
        n = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        total += n
        if n < BATCH:
            break
    return total


def simulate(cfg: dict[str, int | None] | None = None) -> dict[str, int]:
    """Contagem do que seria apagado por conjunto (sem escrever)."""
    cfg = cfg or retention_cfg()
    would: dict[str, int] = {}

    cut = _cutoff(cfg.get("sightings"))
    if cut is not None:
        with flightlog._lock:
            would["sightings"] = flightlog._db().execute(
                "SELECT count(*) FROM sightings WHERE last_ts < ?", (cut,)
            ).fetchone()[0]
    else:
        would["sightings"] = 0

    cut = _cutoff(cfg.get("positions"))
    if cut is not None:
        with flightlog._lock:
            would["positions"] = flightlog._db().execute(
                "SELECT count(*) FROM positions WHERE ts < ?", (cut,)
            ).fetchone()[0]
    else:
        would["positions"] = 0

    cut = _cutoff(cfg.get("events"))
    if cut is not None:
        with flightlog._lock:
            would["events"] = flightlog._db().execute(
                "SELECT count(*) FROM station_events WHERE ts < ?", (cut,)
            ).fetchone()[0]
    else:
        would["events"] = 0

    cut = _cutoff(cfg.get("datalink"))
    if cut is not None:
        with datalink._lock:
            would["datalink"] = datalink._db().execute(
                "SELECT count(*) FROM messages WHERE ts < ?", (cut,)
            ).fetchone()[0]
    else:
        would["datalink"] = 0

    cut = _cutoff(cfg.get("alerts"))
    if cut is not None:
        with alerts._lock:
            would["alerts"] = alerts._db().execute(
                "SELECT count(*) FROM alerts WHERE ts < ?", (cut,)
            ).fetchone()[0]
    else:
        would["alerts"] = 0

    for src in ("ais", "aprs", "ism", "sonde"):
        cut = _cutoff(cfg.get(src))
        if cut is None:
            would[src] = 0
            continue
        with obs._lock:
            db = obs._db()
            n = db.execute("SELECT count(*) FROM tracks WHERE source=? AND ts < ?", (src, cut)).fetchone()[0]
            n += db.execute("SELECT count(*) FROM messages WHERE source=? AND ts < ?", (src, cut)).fetchone()[0]
            n += db.execute("SELECT count(*) FROM objects WHERE source=? AND last_ts < ?", (src, cut)).fetchone()[0]
            would[src] = n

    cut = _cutoff(cfg.get("health"))
    if cut is not None:
        would["health"] = sum(1 for m in health.load_noise_history() if (m.get("ts") or 0) < cut)
    else:
        would["health"] = 0

    # range: se configurado, apaga o arquivo inteiro (1 unidade)
    cut = _cutoff(cfg.get("range"))
    if cut is not None and range_study.DATA.exists():
        try:
            mtime = range_study.DATA.stat().st_mtime
        except OSError:
            mtime = 0
        would["range"] = 1 if mtime < cut else 0
    else:
        would["range"] = 0

    cut = _cutoff(cfg.get("sat_empty"))
    if cut is not None and sats.SAT_DIR.exists():
        n = 0
        for d in sats.SAT_DIR.iterdir():
            if not d.is_dir() or d.name.startswith("."):
                continue
            try:
                if d.stat().st_mtime >= cut:
                    continue
            except OSError:
                continue
            if sats._count_images(d) == 0:
                n += 1
        would["sat_empty"] = n
    else:
        would["sat_empty"] = 0

    would["recordings"] = _simulate_rec_quota()
    return would


def _simulate_rec_quota() -> int:
    """Quantas gravações a cota rec_max_gb apagaria (sem apagar)."""
    rec._ensure_dir()
    max_gb = float(store.load_config().get("rec_max_gb") or 2.0)
    limit = max(0.0, max_gb) * (1024 ** 3)
    files = sorted(
        (p for p in rec.REC_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".wav"),
        key=lambda p: p.stat().st_mtime,
    )
    total = sum(p.stat().st_size for p in files)
    n = 0
    for victim in files:
        if total <= limit:
            break
        if rec._path and victim.resolve() == rec._path.resolve():
            continue
        total -= victim.stat().st_size
        n += 1
    return n


def run(cfg: dict[str, int | None] | None = None, *, vacuum: bool = True) -> dict[str, Any]:
    """Executa a retenção. Devolve {deleted, bytes_before, bytes_after, vacuumed}."""
    cfg = cfg or retention_cfg()
    before = _data_bytes()
    deleted = dict.fromkeys(
        ["sightings", "positions", "events", "datalink", "alerts",
         "ais", "aprs", "ism", "sonde", "health", "range", "sat_empty", "recordings"],
        0,
    )
    vacuumed: list[str] = []

    # --- flightlog ---
    fl_before = _db_file_bytes(flightlog.DB_PATH)
    fl_deleted = 0
    with flightlog._lock:
        db = flightlog._db()
        cut = _cutoff(cfg.get("sightings"))
        if cut is not None:
            n = _delete_batches(
                db,
                "DELETE FROM sightings WHERE id IN (SELECT id FROM sightings WHERE last_ts < ? LIMIT ?)",
                (cut,),
            )
            deleted["sightings"] = n
            fl_deleted += n
        cut = _cutoff(cfg.get("positions"))
        if cut is not None:
            n = _delete_batches(
                db,
                "DELETE FROM positions WHERE rowid IN (SELECT rowid FROM positions WHERE ts < ? LIMIT ?)",
                (cut,),
            )
            deleted["positions"] = n
            fl_deleted += n
        cut = _cutoff(cfg.get("events"))
        if cut is not None:
            n = _delete_batches(
                db,
                "DELETE FROM station_events WHERE rowid IN (SELECT rowid FROM station_events WHERE ts < ? LIMIT ?)",
                (cut,),
            )
            deleted["events"] = n
            fl_deleted += n
        db.commit()
        if vacuum and fl_deleted and fl_before > 0:
            # libera páginas; VACUUM só se a estimativa passar do limiar
            freelist = db.execute("PRAGMA freelist_count").fetchone()[0]
            page = db.execute("PRAGMA page_size").fetchone()[0]
            freed_est = freelist * page
            if freed_est / fl_before >= VACUUM_THRESHOLD:
                db.execute("VACUUM")
                vacuumed.append("flightlog")

    # --- datalink ---
    cut = _cutoff(cfg.get("datalink"))
    if cut is not None:
        dl_before = _db_file_bytes(datalink.DB_PATH)
        with datalink._lock:
            db = datalink._db()
            n = _delete_batches(
                db,
                "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ts < ? LIMIT ?)",
                (cut,),
            )
            deleted["datalink"] = n
            db.commit()
            if vacuum and n and dl_before > 0:
                freelist = db.execute("PRAGMA freelist_count").fetchone()[0]
                page = db.execute("PRAGMA page_size").fetchone()[0]
                if (freelist * page) / dl_before >= VACUUM_THRESHOLD:
                    db.execute("VACUUM")
                    vacuumed.append("datalink")

    # --- alerts ---
    cut = _cutoff(cfg.get("alerts"))
    if cut is not None:
        al_before = _db_file_bytes(alerts.DB_PATH)
        with alerts._lock:
            db = alerts._db()
            n = _delete_batches(
                db,
                "DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE ts < ? LIMIT ?)",
                (cut,),
            )
            deleted["alerts"] = n
            db.commit()
            if vacuum and n and al_before > 0:
                freelist = db.execute("PRAGMA freelist_count").fetchone()[0]
                page = db.execute("PRAGMA page_size").fetchone()[0]
                if (freelist * page) / al_before >= VACUUM_THRESHOLD:
                    db.execute("VACUUM")
                    vacuumed.append("alerts")

    # --- obs ---
    obs_before = _db_file_bytes(obs.DB_PATH)
    obs_n = 0
    with obs._lock:
        db = obs._db()
        for src in ("ais", "aprs", "ism", "sonde"):
            cut = _cutoff(cfg.get(src))
            if cut is None:
                continue
            n = _delete_batches(
                db,
                "DELETE FROM tracks WHERE rowid IN (SELECT rowid FROM tracks WHERE source=? AND ts < ? LIMIT ?)",
                (src, cut),
            )
            n += _delete_batches(
                db,
                "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE source=? AND ts < ? LIMIT ?)",
                (src, cut),
            )
            n += _delete_batches(
                db,
                "DELETE FROM objects WHERE rowid IN (SELECT rowid FROM objects WHERE source=? AND last_ts < ? LIMIT ?)",
                (src, cut),
            )
            deleted[src] = n
            obs_n += n
        db.commit()
        if vacuum and obs_n and obs_before > 0:
            freelist = db.execute("PRAGMA freelist_count").fetchone()[0]
            page = db.execute("PRAGMA page_size").fetchone()[0]
            if (freelist * page) / obs_before >= VACUUM_THRESHOLD:
                db.execute("VACUUM")
                vacuumed.append("decoders")

    # --- health.json ---
    cut = _cutoff(cfg.get("health"))
    if cut is not None:
        items = health.load_noise_history()
        keep = [m for m in items if (m.get("ts") or 0) >= cut]
        deleted["health"] = len(items) - len(keep)
        if deleted["health"]:
            health.HEALTH_PATH.write_text(json.dumps(keep[-health.MAX_NOISE_ENTRIES:], indent=2))

    # --- range ---
    cut = _cutoff(cfg.get("range"))
    if cut is not None and range_study.DATA.exists():
        try:
            mtime = range_study.DATA.stat().st_mtime
        except OSError:
            mtime = 0
        if mtime < cut:
            range_study.study.reset()
            deleted["range"] = 1

    # --- sat empty ---
    cut = _cutoff(cfg.get("sat_empty"))
    if cut is not None and sats.SAT_DIR.exists():
        n = 0
        for d in list(sats.SAT_DIR.iterdir()):
            if not d.is_dir() or d.name.startswith("."):
                continue
            try:
                if d.stat().st_mtime >= cut:
                    continue
            except OSError:
                continue
            if sats._count_images(d) == 0:
                shutil.rmtree(d, ignore_errors=True)
                n += 1
        deleted["sat_empty"] = n

    # --- recordings quota ---
    removed = rec.enforce_quota()
    deleted["recordings"] = len(removed)

    after = _data_bytes()
    return {
        "deleted": deleted,
        "bytes_before": before,
        "bytes_after": after,
        "vacuumed": vacuumed,
    }


def _data_bytes() -> int:
    total = 0
    data = store.DATA
    if not data.exists():
        return 0
    for p in data.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def sizes() -> dict[str, Any]:
    """Tamanhos por caminho + config de retenção + simulação."""
    from . import export as export_mod
    return {
        "retention": retention_cfg(),
        "rec_max_gb": store.load_config().get("rec_max_gb", 2.0),
        "confirm_phrase": CONFIRM_PHRASE,
        "counts": export_mod.dataset_counts(),
        "simulate": simulate(),
        "formats": list(export_mod.FORMATS),
        "parquet_note": (
            "Parquet não vem na API (pyarrow ~150 MB). "
            "No host: duckdb -c \"COPY (SELECT * FROM read_csv('x.csv')) TO 'x.parquet'\""
        ),
    }


async def retention_loop() -> None:
    """Roda run() por volta das 03:30 locais, todos os dias."""
    while True:
        now = datetime.now()
        target = now.replace(hour=3, minute=30, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        await asyncio.sleep(max(1.0, (target - now).total_seconds()))
        try:
            await asyncio.to_thread(run)
        except Exception:
            pass
