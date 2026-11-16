# Autor: Matheus C. Pestana
"""Satélites: previsão de passagens (skyfield + TLE do CelesTrak) e captura LRPT dos Meteor-M
com o SatDump. A agenda unificada mora em `schedule.py` (este módulo só reexporta o necessário).
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

from . import decoders, sdr, store

SAT_DIR = store.DATA / "sat"
TLE_PATH = store.DATA / "tle.json"
TLE_MAX_AGE_S = 24 * 3600

# Limiares do veredito (dados reais da estação, antena de estoque, nov/2026)
SNR_WEAK_DB = 3.0
PIPELINE_SWITCH_S = 120.0
PIPELINE_SWITCH_SNR_DB = 4.0
SYNC_LINE_INTERVAL_S = 10.0
MIN_CAPTURE_S = 60.0
PIPELINE_72K = "meteor_m2-x_lrpt"
PIPELINE_80K = "meteor_m2-x_lrpt_80k"

# NOAA 15/18/19 (APT) foram desativados em 2025; ficam de fora.
SATS: list[dict[str, Any]] = [
    {"id": "meteor-m2-3", "name": "Meteor-M2 3", "norad": 57166, "freq": 137.9, "kind": "lrpt",
     "pipeline": PIPELINE_72K},
    {"id": "meteor-m2-4", "name": "Meteor-M2 4", "norad": 59051, "freq": 137.9, "kind": "lrpt",
     "pipeline": PIPELINE_72K},
    {"id": "iss", "name": "ISS", "norad": 25544, "freq": 145.8, "kind": "info",
     "note": "voz/SSTV em 145.800 FM (eventos) e APRS em 145.825"},
]
BY_ID = {s["id"]: s for s in SATS}

# Estado da captura em curso (SNR/sync por passagem; o log da UI não serve como fonte)
live: dict[str, Any] = {}
_finalize_lock = asyncio.Lock()
_monitor_task: asyncio.Task | None = None

_ts = load.timescale()
_passes: dict[str, Any] = {"at": 0.0, "items": []}


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

_SNR_RE = re.compile(r"SNR\s*:\s*(-?\d+(?:\.\d+)?)\s*dB", re.I)
_PEAK_RE = re.compile(r"Peak\s*SNR\s*:\s*(-?\d+(?:\.\d+)?)\s*dB", re.I)
_VITERBI_RE = re.compile(r"Viterbi\s*:\s*(SYNCED|NOSYNC)", re.I)
_DEFRAMER_RE = re.compile(r"Deframer\s*:\s*(SYNCED|NOSYNC)", re.I)


def _strip_ansi(line: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", line).strip()


def ingest_satdump_line(text: str, stats: dict[str, Any] | None = None) -> dict[str, Any]:
    """Atualiza stats a partir de uma linha do SatDump. Função pura sobre o dict (mutável)."""
    st = stats if stats is not None else live
    if not text or not st:
        return st
    now = time.time()
    m = _PEAK_RE.search(text)
    if m:
        peak = float(m.group(1))
        st["snr_peak"] = max(float(st.get("snr_peak") or 0), peak)
    m = _SNR_RE.search(text)
    if m:
        snr = float(m.group(1))
        st["snr_last"] = snr
        if snr > 0:
            n = int(st.get("samples") or 0) + 1
            mean = float(st.get("snr_mean") or 0)
            st["snr_mean"] = mean + (snr - mean) / n
            st["samples"] = n
        if st.get("snr_peak") is None:
            st["snr_peak"] = snr
        else:
            st["snr_peak"] = max(float(st["snr_peak"]), snr)
    vm = _VITERBI_RE.search(text)
    if vm:
        if vm.group(1).upper() == "SYNCED":
            st["viterbi_sync_n"] = int(st.get("viterbi_sync_n") or 0) + 1
            st.setdefault("first_sync_ts", now)
    dm = _DEFRAMER_RE.search(text)
    if dm:
        if dm.group(1).upper() == "SYNCED":
            st["deframer_sync_n"] = int(st.get("deframer_sync_n") or 0) + 1
            st.setdefault("first_sync_ts", now)
    sync_n = max(int(st.get("viterbi_sync_n") or 0), int(st.get("deframer_sync_n") or 0))
    st["sync_seconds"] = round(sync_n * SYNC_LINE_INTERVAL_S, 1)
    st["elapsed"] = round(now - float(st.get("started_at") or now), 1)
    return st


def verdict(stats: dict[str, Any], image_count: int, elapsed: float) -> str:
    """Veredito da captura a partir das estatísticas medidas nesta passagem."""
    if elapsed < MIN_CAPTURE_S:
        return "interrupted"
    if image_count >= 1:
        return "ok"
    synced = bool(stats.get("first_sync_ts") or (stats.get("viterbi_sync_n") or 0) > 0
                  or (stats.get("deframer_sync_n") or 0) > 0)
    if synced:
        return "locked_no_image"
    peak = float(stats.get("snr_peak") or 0)
    if peak >= SNR_WEAK_DB:
        return "weak"
    return "no_signal"


def _pipeline_id(cfg: dict[str, Any], forced: str | None = None) -> str:
    if forced:
        return forced
    choice = str(cfg.get("sat_pipeline") or "auto").lower()
    if choice == "80k":
        return PIPELINE_80K
    if choice == "72k":
        return PIPELINE_72K
    return PIPELINE_72K  # auto começa em 72k


def _count_images(out: Path) -> int:
    return sum(1 for p in out.rglob("*") if p.is_file() and p.suffix.lower() in (".png", ".jpg"))


def _write_capture_meta(out: Path, extra: dict[str, Any]) -> None:
    path = out / "capture.json"
    meta: dict[str, Any] = {}
    try:
        meta = json.loads(path.read_text())
    except (OSError, ValueError):
        pass
    meta.update(extra)
    path.write_text(json.dumps(meta, indent=2))


def live_status() -> dict[str, Any] | None:
    if not live or sdr.state.mode != "sat":
        return None
    elapsed = time.time() - float(live.get("started_at") or time.time())
    return {
        "snr": live.get("snr_last"),
        "snr_peak": live.get("snr_peak"),
        "snr_mean": live.get("snr_mean"),
        "synced": bool(live.get("first_sync_ts")),
        "elapsed": round(elapsed, 1),
        "pipeline": live.get("pipeline"),
        "dir": live.get("dir"),
    }


async def finalize_capture(*, interrupted: bool = False) -> None:
    """Grava veredito e estatísticas no capture.json. Idempotente."""
    async with _finalize_lock:
        if not live.get("dir") or live.get("finalized"):
            return
        out = SAT_DIR / str(live["dir"])
        started = float(live.get("started_at") or time.time())
        elapsed = time.time() - started
        images = _count_images(out) if out.is_dir() else 0
        stats = {
            "snr_peak": live.get("snr_peak"),
            "snr_mean": round(float(live["snr_mean"]), 3) if live.get("snr_mean") is not None else None,
            "snr_last": live.get("snr_last"),
            "samples": live.get("samples", 0),
            "viterbi_sync_n": live.get("viterbi_sync_n", 0),
            "deframer_sync_n": live.get("deframer_sync_n", 0),
            "sync_seconds": live.get("sync_seconds", 0),
            "first_sync_ts": live.get("first_sync_ts"),
        }
        ver = "interrupted" if interrupted and elapsed < MIN_CAPTURE_S else verdict(stats, images, elapsed)
        _write_capture_meta(out, {
            **stats,
            "images": images,
            "ended_at": time.time(),
            "elapsed": round(elapsed, 1),
            "verdict": ver,
            "locked": bool(stats.get("first_sync_ts")),
            "pipeline_used": live.get("pipeline"),
        })
        live["finalized"] = True
        _restore_sink_append()


_sink_orig_append: Any = None


def _install_sink_ingest() -> None:
    """stderr do SatDump também traz SNR/Progress; o _pump_log só faz append."""
    global _sink_orig_append
    sink = decoders.log["sat"]
    if _sink_orig_append is None:
        _sink_orig_append = sink.append

        def append_and_ingest(text: str) -> None:
            if isinstance(text, str):
                ingest_satdump_line(_strip_ansi(text))
            _sink_orig_append(text)

        sink.append = append_and_ingest  # type: ignore[method-assign]


def _restore_sink_append() -> None:
    global _sink_orig_append
    if _sink_orig_append is not None:
        decoders.log["sat"].append = _sink_orig_append  # type: ignore[method-assign]
        _sink_orig_append = None


async def _spawn_satdump(pipeline: str, out: Path, meta: dict[str, Any], g: float, dur: int,
                         sat_id: str) -> None:
    cmd = ["satdump", "live", pipeline, str(out), "--source", "rtlsdr", "--samplerate", "1.024e6",
           "--frequency", f"{meta['freq']}e6", "--gain", str(g), "--timeout", str(max(30, dur))]
    sink = decoders.log["sat"]
    _install_sink_ingest()

    def on_line(line: str) -> None:
        text = _strip_ansi(line)
        if not text:
            return
        ingest_satdump_line(text)
        # append já faz ingest via wrapper; evita duplicar o parse chamando o original
        (_sink_orig_append or sink.append)(text[:300])

    await sdr.start_lines(
        "sat", cmd, on_line,
        {"sat": meta["name"], "sat_id": sat_id, "freq_mhz": meta["freq"], "gain": g,
         "until": time.time() + dur, "dir": out.name, "pipeline": pipeline},
        sink, "satdump", ok_exit=True)


async def _monitor_capture() -> None:
    """Acompanha a captura: troca 72k→80k em auto, e finaliza quando o modo sai de sat."""
    switched = False
    try:
        while True:
            await asyncio.sleep(2)
            if not live or live.get("finalized"):
                return
            if sdr.state.mode != "sat":
                await finalize_capture(interrupted=True)
                return
            # auto: após 120 s com SNR alto e sem sync → tenta 80k pelo restante
            if (not switched and live.get("auto_pipeline") and live.get("pipeline") == PIPELINE_72K
                    and time.time() - float(live.get("started_at") or 0) >= PIPELINE_SWITCH_S
                    and float(live.get("snr_peak") or 0) >= PIPELINE_SWITCH_SNR_DB
                    and not live.get("first_sync_ts")):
                remain = int(float(live.get("until") or time.time()) - time.time())
                if remain < 60:
                    continue
                switched = True
                out = SAT_DIR / str(live["dir"])
                meta = BY_ID[live["sat_id"]]
                live["pipeline"] = PIPELINE_80K
                live["pipeline_switched"] = True
                _write_capture_meta(out, {"pipeline_used": PIPELINE_80K, "pipeline_switched_at": time.time()})
                decoders.log["sat"].append("api: trocando para pipeline 80k (auto)")
                await _spawn_satdump(PIPELINE_80K, out, meta, float(live["gain"]), remain, live["sat_id"])
    except asyncio.CancelledError:
        raise
    except Exception as e:
        decoders.log["sat"].append(f"api: monitor captura: {e}")


async def start_capture(sat_id: str, duration: float | None, gain: float | None) -> str:
    global _monitor_task
    meta = BY_ID.get(sat_id)
    if not meta or meta["kind"] != "lrpt":
        return f"satélite sem captura automática: {sat_id or '?'}"
    cfg = store.load_config()
    g = gain if gain is not None else cfg["sat_gain"]
    dur = int(duration or 900)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    out = SAT_DIR / f"{stamp}_{sat_id}"
    out.mkdir(parents=True, exist_ok=True)
    choice = str(cfg.get("sat_pipeline") or "auto").lower()
    pipeline = _pipeline_id(cfg)
    now = time.time()
    # limpa log e estado: cada captura mede o próprio SNR (não herda da anterior)
    decoders.log["sat"].clear()
    live.clear()
    live.update({
        "sat_id": sat_id, "dir": out.name, "started_at": now, "until": now + dur,
        "gain": g, "pipeline": pipeline, "auto_pipeline": choice == "auto",
        "snr_last": None, "snr_peak": 0.0, "snr_mean": 0.0, "samples": 0,
        "viterbi_sync_n": 0, "deframer_sync_n": 0, "sync_seconds": 0, "finalized": False,
    })
    _write_capture_meta(out, {
        "sat": sat_id, "name": meta["name"], "start": now, "duration": dur,
        "freq": meta["freq"], "gain": g, "pipeline_used": pipeline, "sat_pipeline": choice,
    })
    if _monitor_task and not _monitor_task.done():
        _monitor_task.cancel()
    await _spawn_satdump(pipeline, out, meta, float(g), dur, sat_id)
    _monitor_task = asyncio.create_task(_monitor_capture())
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
        # capturas antigas sem veredito continuam válidas (UI mostra "sem dados")
        out.append(meta | {"dir": d.name, "images": imgs[:40], "image_count": len(imgs), "bytes": size})
    return out


def safe_path(rel: str) -> Path | None:
    try:
        base = SAT_DIR.resolve()
        p = (SAT_DIR / rel).resolve()
    except OSError:
        return None
    if base not in p.parents or not p.is_file():
        return None
    return p


def safe_capture_dir(dirname: str) -> Path | None:
    """Diretório de captura dentro de SAT_DIR (bloqueia `..`)."""
    if not dirname or "/" in dirname or "\\" in dirname or dirname.startswith("."):
        return None
    try:
        base = SAT_DIR.resolve()
        p = (SAT_DIR / dirname).resolve()
    except OSError:
        return None
    if p.parent != base or not p.is_dir():
        return None
    return p


def delete_capture(dirname: str) -> tuple[bool, str]:
    import shutil
    p = safe_capture_dir(dirname)
    if not p:
        return False, "caminho inválido"
    shutil.rmtree(p)
    return True, ""


def delete_empty_captures() -> int:
    """Apaga pastas de captura sem imagem. Devolve quantas removeu."""
    import shutil
    if not SAT_DIR.exists():
        return 0
    n = 0
    for d in list(SAT_DIR.iterdir()):
        if not d.is_dir():
            continue
        if _count_images(d) == 0:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n


# ---------- agenda: delegada a schedule (compat com testes e /api/sat/passes) ----------

def __getattr__(name: str) -> Any:
    """job / suppressed / agenda_log vivem em schedule; reexporta sob demanda."""
    if name in ("job", "suppressed", "agenda_log"):
        from . import schedule
        return getattr(schedule, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _sonde_window(now: float, cfg: dict[str, Any]) -> float | None:
    from . import schedule
    return schedule.sonde_window(now, cfg)


async def _tick() -> None:
    from . import schedule
    await schedule.tick()


async def scheduler_loop() -> None:
    from . import schedule
    await schedule.scheduler_loop()


def agenda_status() -> dict[str, Any]:
    from . import schedule
    st = schedule.agenda_status()
    st["tle_fetched"] = _passes.get("tle_fetched")
    return st
