# Autor: Matheus C. Pestana
"""Exportação genérica de conjuntos de dados (CSV / JSONL).

Parquet: pyarrow soma ~150 MB à imagem da API (~805 MB, >10%). Não embutimos.
Conversão local com DuckDB:
  duckdb -c "COPY (SELECT * FROM read_csv('x.csv')) TO 'x.parquet'"
"""
from __future__ import annotations

import csv
import io
import json
import time
from collections.abc import Iterable, Iterator
from typing import Any

from fastapi.responses import StreamingResponse

from . import alerts, datalink, flightlog, health, obs, range_study, store

# formatos servidos pela API (parquet fica de fora — ver docstring)
FORMATS = ("csv", "jsonl")

DATASETS = (
    "sightings",
    "positions",
    "ais",
    "aprs",
    "ism",
    "sonde",
    "datalink",
    "events",
    "range",
    "health",
    "alerts",
)

OBS_SOURCES = ("ais", "aprs", "ism", "sonde")

# CSV: campos fixos; colunas JSON aninhadas vão como texto (use JSONL para estrutura)
_SIGHTING_FIELDS = flightlog.CSV_FIELDS
_POSITION_FIELDS = ("sighting_id", "ts", "lat", "lon", "alt", "gs", "track", "rssi", "km")
_EVENT_FIELDS = ("ts", "kind", "detail")
_DATALINK_FIELDS = datalink.COLS
_ALERT_FIELDS = ("id", "ts", "kind", "key", "title", "detail", "seen")
_RANGE_FIELDS = ("az_deg", "max_km", "samples", "smoothed_km")
_OBS_OBJ_FIELDS = ("source", "key", "first_ts", "last_ts", "n", "lat", "lon", "alt", "pos_ts", "data")
_OBS_TRACK_FIELDS = ("kind", "source", "key", "ts", "lat", "lon", "alt")
_OBS_MSG_FIELDS = ("kind", "id", "ts", "source", "key", "text", "data")
_HEALTH_FIELDS = (
    "ts", "antenna_label", "band", "start_mhz", "end_mhz",
    "noise_db", "p10", "peak_db", "peak_mhz",
)


def _ts_iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(ts)))
    except (TypeError, ValueError, OSError):
        return None


def _where_ts(col: str, since: float | None, until: float | None) -> tuple[str, list[Any]]:
    parts, args = [], []
    if since is not None:
        parts.append(f"{col} >= ?")
        args.append(since)
    if until is not None:
        parts.append(f"{col} <= ?")
        args.append(until)
    return ((" WHERE " + " AND ".join(parts)) if parts else ""), args


def iter_rows(dataset: str, since: float | None = None, until: float | None = None) -> Iterator[dict[str, Any]]:
    """Gera dicts do conjunto. Para fontes obs: kind=object|track|message."""
    if dataset not in DATASETS:
        raise KeyError(dataset)
    if dataset == "sightings":
        where, args = _where_ts("first_ts", since, until)
        with flightlog._lock:
            rows = flightlog._db().execute(
                f"SELECT * FROM sightings{where} ORDER BY first_ts", args
            ).fetchall()
        for r in rows:
            d = dict(r)
            d["duration_s"] = round(d["last_ts"] - d["first_ts"], 1)
            yield d
        return
    if dataset == "positions":
        where, args = _where_ts("ts", since, until)
        with flightlog._lock:
            cur = flightlog._db().execute(
                f"SELECT sighting_id, ts, lat, lon, alt, gs, track, rssi, km FROM positions{where} ORDER BY ts",
                args,
            )
            while True:
                batch = cur.fetchmany(2000)
                if not batch:
                    break
                for r in batch:
                    yield dict(r)
        return
    if dataset == "events":
        where, args = _where_ts("ts", since, until)
        with flightlog._lock:
            rows = flightlog._db().execute(
                f"SELECT ts, kind, detail FROM station_events{where} ORDER BY ts", args
            ).fetchall()
        for r in rows:
            yield dict(r)
        return
    if dataset == "datalink":
        where, args = _where_ts("ts", since, until)
        cols = ", ".join(datalink.COLS)
        with datalink._lock:
            cur = datalink._db().execute(
                f"SELECT {cols} FROM messages{where} ORDER BY ts", args
            )
            while True:
                batch = cur.fetchmany(2000)
                if not batch:
                    break
                for r in batch:
                    yield dict(r)
        return
    if dataset == "alerts":
        where, args = _where_ts("ts", since, until)
        with alerts._lock:
            rows = alerts._db().execute(
                f"SELECT id, ts, kind, key, title, detail, seen FROM alerts{where} ORDER BY ts",
                args,
            ).fetchall()
        for r in rows:
            d = dict(r)
            try:
                d["detail"] = json.loads(d["detail"] or "{}")
            except (TypeError, ValueError):
                pass
            d["seen"] = bool(d["seen"])
            yield d
        return
    if dataset == "range":
        study = range_study.study
        polar = study.polar_max_km
        samples = study.polar_samples
        smooth = study.smoothed_km()
        for i, km in enumerate(polar):
            yield {
                "az_deg": i,
                "max_km": round(km, 2),
                "samples": samples[i] if i < len(samples) else 0,
                "smoothed_km": smooth[i] if i < len(smooth) else None,
            }
        return
    if dataset == "health":
        for m in health.load_noise_history():
            ts = m.get("ts")
            if since is not None and (ts is None or ts < since):
                continue
            if until is not None and (ts is None or ts > until):
                continue
            for b in m.get("bands") or []:
                yield {
                    "ts": ts,
                    "antenna_label": m.get("antenna_label") or "",
                    "band": b.get("name") or b.get("label"),
                    "start_mhz": b.get("start"),
                    "end_mhz": b.get("end"),
                    "noise_db": b.get("noise_db"),
                    "p10": b.get("p10"),
                    "peak_db": b.get("peak_db"),
                    "peak_mhz": b.get("peak_mhz"),
                }
        return
    if dataset in OBS_SOURCES:
        src = dataset
        parts, args = ["source=?"], [src]
        if since is not None:
            parts.append("last_ts >= ?")
            args.append(since)
        if until is not None:
            parts.append("last_ts <= ?")
            args.append(until)
        with obs._lock:
            objs = obs._db().execute(
                f"SELECT * FROM objects WHERE {' AND '.join(parts)} ORDER BY last_ts", args
            ).fetchall()
        for r in objs:
            d = dict(r)
            try:
                d["data"] = json.loads(d["data"] or "{}")
            except (TypeError, ValueError):
                d["data"] = {}
            d["kind"] = "object"
            yield d
        tparts, targs = ["source=?"], [src]
        if since is not None:
            tparts.append("ts >= ?")
            targs.append(since)
        if until is not None:
            tparts.append("ts <= ?")
            targs.append(until)
        with obs._lock:
            tracks = obs._db().execute(
                f"SELECT source, key, ts, lat, lon, alt FROM tracks WHERE {' AND '.join(tparts)} ORDER BY ts",
                targs,
            ).fetchall()
        for r in tracks:
            yield {"kind": "track", **dict(r)}
        with obs._lock:
            msgs = obs._db().execute(
                f"SELECT id, ts, source, key, text, data FROM messages WHERE {' AND '.join(tparts)} ORDER BY id",
                targs,
            ).fetchall()
        for r in msgs:
            d = dict(r)
            try:
                d["data"] = json.loads(d["data"] or "{}")
            except (TypeError, ValueError):
                d["data"] = {}
            d["kind"] = "message"
            yield d
        return
    raise KeyError(dataset)


def _csv_fields(dataset: str) -> tuple[str, ...]:
    if dataset == "sightings":
        return _SIGHTING_FIELDS
    if dataset == "positions":
        return _POSITION_FIELDS
    if dataset == "events":
        return _EVENT_FIELDS
    if dataset == "datalink":
        return _DATALINK_FIELDS
    if dataset == "alerts":
        return _ALERT_FIELDS
    if dataset == "range":
        return _RANGE_FIELDS
    if dataset == "health":
        return _HEALTH_FIELDS
    if dataset in OBS_SOURCES:
        # união estável: object + track + message
        return (
            "kind", "source", "key", "id", "first_ts", "last_ts", "n",
            "ts", "lat", "lon", "alt", "pos_ts", "text", "data",
        )
    return ()


def _csv_cell(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, default=str)
    if isinstance(v, bool):
        return int(v)
    return v


def iter_csv(dataset: str, since: float | None = None, until: float | None = None) -> Iterator[str]:
    fields = _csv_fields(dataset)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    yield buf.getvalue()
    buf.seek(0)
    buf.truncate(0)
    for row in iter_rows(dataset, since, until):
        out = {k: _csv_cell(row.get(k)) for k in fields}
        if dataset == "sightings":
            for k in ("first_ts", "last_ts"):
                if k in out and out[k] is not None:
                    out[k] = _ts_iso(float(row[k]))
        w.writerow(out)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)


def iter_jsonl(dataset: str, since: float | None = None, until: float | None = None) -> Iterator[str]:
    for row in iter_rows(dataset, since, until):
        yield json.dumps(row, ensure_ascii=False, default=str) + "\n"


def media_type(fmt: str) -> str:
    if fmt == "csv":
        return "text/csv; charset=utf-8"
    if fmt == "jsonl":
        return "application/x-ndjson; charset=utf-8"
    return "application/octet-stream"


def stream(dataset: str, fmt: str, since: float | None = None, until: float | None = None) -> StreamingResponse:
    if dataset not in DATASETS:
        raise KeyError(dataset)
    if fmt == "parquet":
        # ver docstring do módulo — use DuckDB no host
        raise ValueError("parquet")
    if fmt not in FORMATS:
        raise ValueError(fmt)
    gen: Iterable[str] = iter_csv(dataset, since, until) if fmt == "csv" else iter_jsonl(dataset, since, until)
    filename = f"urutau-{dataset}.{fmt}"
    return StreamingResponse(
        gen,
        media_type=media_type(fmt),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def dataset_counts() -> dict[str, Any]:
    """Contagens e tamanho aproximado por conjunto (painel Dados)."""
    out: dict[str, Any] = {}
    with flightlog._lock:
        db = flightlog._db()
        out["sightings"] = {"rows": db.execute("SELECT count(*) FROM sightings").fetchone()[0]}
        out["positions"] = {"rows": db.execute("SELECT count(*) FROM positions").fetchone()[0]}
        out["events"] = {"rows": db.execute("SELECT count(*) FROM station_events").fetchone()[0]}
    fl_size = sum(p.stat().st_size for p in flightlog.DB_PATH.parent.glob(flightlog.DB_PATH.name + "*") if p.exists())
    for k in ("sightings", "positions", "events"):
        out[k]["bytes"] = fl_size
    with datalink._lock:
        out["datalink"] = {
            "rows": datalink._db().execute("SELECT count(*) FROM messages").fetchone()[0],
            "bytes": datalink.DB_PATH.stat().st_size if datalink.DB_PATH.exists() else 0,
        }
    with alerts._lock:
        out["alerts"] = {
            "rows": alerts._db().execute("SELECT count(*) FROM alerts").fetchone()[0],
            "bytes": alerts.DB_PATH.stat().st_size if alerts.DB_PATH.exists() else 0,
        }
    with obs._lock:
        odb = obs._db()
        obs_bytes = obs.DB_PATH.stat().st_size if obs.DB_PATH.exists() else 0
        for src in OBS_SOURCES:
            objs = odb.execute("SELECT count(*) FROM objects WHERE source=?", (src,)).fetchone()[0]
            tr = odb.execute("SELECT count(*) FROM tracks WHERE source=?", (src,)).fetchone()[0]
            msg = odb.execute("SELECT count(*) FROM messages WHERE source=?", (src,)).fetchone()[0]
            out[src] = {"rows": objs + tr + msg, "objects": objs, "tracks": tr, "messages": msg, "bytes": obs_bytes}
    range_path = store.DATA / "range.json"
    out["range"] = {
        "rows": 360,
        "bytes": range_path.stat().st_size if range_path.exists() else 0,
    }
    hist = health.load_noise_history()
    hp = store.DATA / "health.json"
    out["health"] = {
        "rows": sum(len(m.get("bands") or []) for m in hist),
        "measurements": len(hist),
        "bytes": hp.stat().st_size if hp.exists() else 0,
    }
    return out
