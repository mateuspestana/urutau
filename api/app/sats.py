# Autor: Matheus C. Pestana
"""Satélites: previsão de passagens (skyfield + TLE do CelesTrak), captura LRPT dos Meteor-M com o
SatDump e a agenda automática (satélites e janelas de radiossonda).

A agenda só assume o dongle quando ele está em `adsb` ou `idle` (nunca interrompe uma escuta) e,
ao terminar, devolve o modo anterior.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from skyfield.api import EarthSatellite, load, wgs84

from . import decoders, modes, sdr, store

SAT_DIR = store.DATA / "sat"
TLE_PATH = store.DATA / "tle.json"
TLE_MAX_AGE_S = 24 * 3600

# NOAA 15/18/19 (APT) foram desativados em 2025; ficam de fora.
SATS: list[dict[str, Any]] = [
    {"id": "meteor-m2-3", "name": "Meteor-M2 3", "norad": 57166, "freq": 137.9, "kind": "lrpt",
     "pipeline": "meteor_m2-x_lrpt"},
    {"id": "meteor-m2-4", "name": "Meteor-M2 4", "norad": 59051, "freq": 137.9, "kind": "lrpt",
     "pipeline": "meteor_m2-x_lrpt"},
    {"id": "iss", "name": "ISS", "norad": 25544, "freq": 145.8, "kind": "info",
     "note": "voz/SSTV em 145.800 FM (eventos) e APRS em 145.825"},
]
BY_ID = {s["id"]: s for s in SATS}

_ts = load.timescale()
_passes: dict[str, Any] = {"at": 0.0, "items": []}
job: dict[str, Any] = {}  # tarefa automática em curso: {"mode", "until", "prev", "label"}
# o usuário trocou de modo no meio de uma tarefa: não retoma aquele tipo até o fim da janela/passagem
suppressed: dict[str, float] = {}
agenda_log: list[dict[str, Any]] = []


def _note(kind: str, detail: str) -> None:
    agenda_log.insert(0, {"ts": time.time(), "kind": kind, "detail": detail})
    del agenda_log[30:]


# ---------- TLE e passagens ----------

async def _fetch_tles() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "rtl-sdr-station/1.0"}) as client:
        for s in SATS:
            r = await client.get("https://celestrak.org/NORAD/elements/gp.php",
                                 params={"CATNR": s["norad"], "FORMAT": "tle"})
            lines = [ln.strip() for ln in r.text.splitlines() if ln.strip()]
            if r.status_code == 200 and len(lines) >= 3 and lines[1].startswith("1 "):
                out[s["id"]] = lines[:3]
    return out


async def tles() -> dict[str, Any]:
    cached: dict[str, Any] = {}
    if TLE_PATH.exists():
        try:
            cached = json.loads(TLE_PATH.read_text())
        except ValueError:
            cached = {}
    if time.time() - cached.get("fetched", 0) > TLE_MAX_AGE_S or not cached.get("tle"):
        try:
            fresh = await _fetch_tles()
            if fresh:
                cached = {"fetched": time.time(), "tle": cached.get("tle", {}) | fresh}
                TLE_PATH.write_text(json.dumps(cached))
        except Exception as e:
            decoders.log["sat"].append(f"api: TLE não baixou ({e}); usando o cache")
    return cached


def _compute(tle: dict[str, list[str]], lat: float, lon: float, hours: float, min_el: float,
             start: datetime | None = None) -> list[dict[str, Any]]:
    here = wgs84.latlon(lat, lon, 20)
    begin = start or datetime.now(UTC)
    t0 = _ts.from_datetime(begin)
    t1 = _ts.from_datetime(begin + timedelta(hours=hours))
    items: list[dict[str, Any]] = []
    for sid, lines in tle.items():
        meta = BY_ID.get(sid)
        if not meta:
            continue
        sat = EarthSatellite(lines[1], lines[2], lines[0], _ts)
        times, events = sat.find_events(here, t0, t1, altitude_degrees=5.0)
        cur: dict[str, Any] = {}
        for t, ev in zip(times, events, strict=True):
            if ev == 0:
                cur = {"aos": t.utc_datetime().timestamp()}
                cur["aos_az"] = round((sat - here).at(t).altaz()[1].degrees)
            elif ev == 1 and cur:
                alt, az, _ = (sat - here).at(t).altaz()
                cur["tca"] = t.utc_datetime().timestamp()
                cur["max_el"] = round(alt.degrees, 1)
            elif ev == 2 and cur.get("tca"):
                cur["los"] = t.utc_datetime().timestamp()
                cur["los_az"] = round((sat - here).at(t).altaz()[1].degrees)
                if cur["max_el"] >= min_el or meta["kind"] == "info":
                    items.append(cur | {"sat": sid, "name": meta["name"], "freq": meta["freq"],
                                        "kind": meta["kind"]})
                cur = {}
    items.sort(key=lambda p: p["aos"])
    return items


async def passes(force: bool = False) -> list[dict[str, Any]]:
    if not force and time.time() - _passes["at"] < 1800 and _passes["items"]:
        return [p for p in _passes["items"] if p["los"] > time.time()]
    rx = store.receiver()
    if rx is None:  # sem localização não há como calcular passagens
        return []
    data = await tles()
    tle = data.get("tle") or {}
    if not tle:
        return []
    items = await asyncio.to_thread(_compute, tle, rx[0], rx[1], 48.0, 0.0)
    _passes.update(at=time.time(), items=items, tle_fetched=data.get("fetched"))
    return [p for p in items if p["los"] > time.time()]


# ---------- captura ----------

async def start_capture(sat_id: str, duration: float | None, gain: float | None) -> str:
    meta = BY_ID.get(sat_id)
    if not meta or meta["kind"] != "lrpt":
        return f"satélite sem captura automática: {sat_id or '?'}"
    cfg = store.load_config()
    g = gain if gain is not None else cfg["sat_gain"]
    dur = int(duration or 900)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    out = SAT_DIR / f"{stamp}_{sat_id}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "capture.json").write_text(json.dumps({"sat": sat_id, "name": meta["name"], "start": time.time(),
                                                  "duration": dur, "freq": meta["freq"], "gain": g}))
    cmd = ["satdump", "live", meta["pipeline"], str(out), "--source", "rtlsdr", "--samplerate", "1.024e6",
           "--frequency", f"{meta['freq']}e6", "--gain", str(g), "--timeout", str(dur)]
    sink = decoders.log["sat"]

    def on_line(line: str) -> None:
        # o SatDump colore o log com ANSI
        text = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        if text:
            sink.append(text[:300])

    await sdr.start_lines("sat", cmd, on_line, {"sat": meta["name"], "sat_id": sat_id, "freq_mhz": meta["freq"],
                                               "gain": g, "until": time.time() + dur, "dir": out.name},
                          sink, "satdump", ok_exit=True)
    return ""


def captures(limit: int = 30) -> list[dict[str, Any]]:
    if not SAT_DIR.exists():
        return []
    out = []
    for d in sorted((p for p in SAT_DIR.iterdir() if p.is_dir()), reverse=True)[:limit]:
        meta: dict[str, Any] = {}
        try:
            meta = json.loads((d / "capture.json").read_text())
        except (OSError, ValueError):
            pass
        imgs = sorted(str(p.relative_to(SAT_DIR)) for p in d.rglob("*") if p.suffix.lower() in (".png", ".jpg"))
        size = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
        out.append(meta | {"dir": d.name, "images": imgs[:40], "image_count": len(imgs), "bytes": size})
    return out


def safe_path(rel: str) -> Path | None:
    p = (SAT_DIR / rel).resolve()
    if SAT_DIR.resolve() not in p.parents or not p.is_file():
        return None
    return p


# ---------- agenda automática ----------

def _sonde_window(now: float, cfg: dict[str, Any]) -> float | None:
    """Se `now` cai numa janela de sonda, devolve o fim dela (epoch)."""
    lt = datetime.fromtimestamp(now)
    for w in cfg.get("sonde_windows", []):
        try:
            a, b = w.split("-")
            ha, ma = map(int, a.split(":"))
            hb, mb = map(int, b.split(":"))
        except ValueError:
            continue
        start = lt.replace(hour=ha, minute=ma, second=0, microsecond=0)
        end = lt.replace(hour=hb, minute=mb, second=0, microsecond=0)
        if end <= start:
            end += timedelta(days=1)
        if start.timestamp() <= now < end.timestamp():
            return end.timestamp()
    return None


async def _restore() -> None:
    prev = job.get("prev") or "adsb"
    job.clear()
    if sdr.state.mode in ("sat", "sonde", "idle"):
        await modes.apply(prev, origin="agenda: fim")


async def scheduler_loop() -> None:
    await asyncio.sleep(20)
    while True:
        try:
            await _tick()
        except Exception as e:
            decoders.log["sat"].append(f"agenda: {e}")
        await asyncio.sleep(15)


async def _tick() -> None:
    cfg = store.load_config()
    now = time.time()
    mode = sdr.state.mode

    if job:
        # a tarefa terminou: tempo esgotado, processo saiu sozinho ou o usuário trocou de modo
        if mode == "idle":
            # o processo da tarefa acabou por conta própria (o SatDump sai com --timeout no fim da
            # passagem; uma falha também deixa idle). Troca feita pela pessoa passa pelo POST /api/mode,
            # que já limpa a tarefa antes, então aqui é sempre fim natural: devolve o modo anterior.
            _note("fim", f"{job['label']}: processo terminou")
            await _restore()
        elif mode != job["mode"]:
            _note("fim", f"{job['label']}: modo trocado para {mode}")
            suppressed[job["mode"]] = job["until"]
            job.clear()
        elif now >= job["until"]:
            _note("fim", job["label"])
            await _restore()
        return

    free = mode in ("adsb", "idle")
    if not free:
        return

    if cfg.get("sat_auto") and now >= suppressed.get("sat", 0):
        min_el = float(cfg.get("sat_min_el", 20))
        for p in await passes():
            if p["kind"] != "lrpt" or p["max_el"] < min_el:
                continue
            if p["aos"] - 20 <= now < p["los"] - 60:
                dur = int(p["los"] - now + 20)
                ok, err = await modes.apply("sat", extra={"sat": p["sat"], "duration": dur}, origin="agenda")
                if ok:
                    job.update(mode="sat", until=now + dur + 15, prev=mode, label=f"{p['name']} máx {p['max_el']}°")
                    _note("início", job["label"])
                else:
                    _note("erro", err)
                return

    if cfg.get("sonde_auto") and now >= suppressed.get("sonde", 0):
        end = _sonde_window(now, cfg)
        if end:
            ok, err = await modes.apply("sonde", origin="agenda")
            if ok:
                job.update(mode="sonde", until=end, prev=mode, label="janela de radiossonda")
                _note("início", job["label"])
            else:
                _note("erro", err)


def agenda_status() -> dict[str, Any]:
    cfg = store.load_config()
    return {"job": dict(job), "log": agenda_log, "sat_auto": bool(cfg.get("sat_auto")),
            "sonde_auto": bool(cfg.get("sonde_auto")), "sat_min_el": cfg.get("sat_min_el", 20),
            "sonde_windows": cfg.get("sonde_windows", []), "tle_fetched": _passes.get("tle_fetched")}
