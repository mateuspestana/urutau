# Autor: Matheus C. Pestana
"""Urutau — API da estação RTL-SDR: modos, áudio, espectro, ADS-B, decodificadores, marcadores."""
from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import (
    __version__,
    aircraftdb,
    alerts,
    auth,
    datalink,
    decoders,
    export,
    flightlog,
    health,
    modes,
    obs,
    range_study,
    rec,
    report_html,
    retention,
    sats,
    schedule,
    sdr,
    store,
    tiles,
    tower_cycle,
    update_check,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    flightlog.init()
    datalink.init()
    obs.init()
    alerts.init()
    await decoders.start_sonde_listener()
    flightlog.log_event("api_start")
    range_study.start_background()
    restore = asyncio.create_task(modes.restore())  # volta ao último modo escolhido
    guard = asyncio.create_task(sdr.guard_loop())
    agenda = asyncio.create_task(schedule.scheduler_loop())
    retain = asyncio.create_task(retention.retention_loop())
    updates = asyncio.create_task(update_check.update_loop())
    tower = asyncio.create_task(tower_cycle.loop())
    yield
    restore.cancel()
    guard.cancel()
    agenda.cancel()
    retain.cancel()
    updates.cancel()
    tower.cancel()
    await rec.stop()
    await sdr.stop_proc()  # não deixa o container da sonda órfão
    range_study.study.save()
    flightlog.log_event("api_stop")
    flightlog.close()
    datalink.close()
    obs.close()
    alerts.close()


app = FastAPI(
    title="Urutau API",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(auth.AuthMiddleware)
app.include_router(auth.router)


class ModeRequest(BaseModel):
    mode: str
    freq_mhz: float | None = None
    gain: float | None = None
    freqs: list[float] | None = None  # acars / vdl2 / ism: vários canais de uma vez
    sat: str | None = None  # modo sat: id do satélite
    duration: float | None = None  # modo sat: segundos


class SpectrumRequest(BaseModel):
    start_mhz: float = 88.0
    end_mhz: float = 108.0
    bin_khz: float = 50.0
    gain: float = 40.0
    seconds: int = Field(default=12, ge=4, le=60)


class MarkerIn(BaseModel):
    title: str = "Marcador"
    kind: str = "note"
    freq_mhz: float | None = None
    lat: float | None = None
    lon: float | None = None
    note: str = ""
    color: str = "#e8a838"


class ConfigIn(BaseModel):
    lat: float | None = None
    lon: float | None = None
    address: str | None = None
    fm_freq_mhz: float | None = None
    fm_gain: float | None = None
    airband_freq_mhz: float | None = None
    airband_gain: float | None = None
    spectrum_start_mhz: float | None = None
    spectrum_end_mhz: float | None = None
    spectrum_bin_khz: float | None = None
    spectrum_gain: float | None = None
    tar1090_public: str | None = None
    acars_freqs: list[float] | None = None
    vdl2_freqs: list[float] | None = None
    datalink_gain: float | None = None
    ais_gain: float | None = None
    ism_freqs: list[float] | None = None
    ism_gain: float | None = None
    aprs_freq_mhz: float | None = None
    aprs_gain: float | None = None
    sonde_gain: float | None = None
    sonde_min_mhz: float | None = None
    sonde_max_mhz: float | None = None
    sonde_auto: bool | None = None
    sonde_windows: list[str] | None = None
    sat_auto: bool | None = None
    sat_min_el: float | None = None
    sat_gain: float | None = None
    sat_pipeline: str | None = None
    rec_max_gb: float | None = None
    tiles_max_mb: float | None = None
    adsb_serial: str | None = None
    sdr_serial: str | None = None
    retention: dict[str, int | None] | None = None
    update_check: bool | None = None
    range_median_deg: float | None = None
    range_sigma_deg: float | None = None
    range_gap_deg: float | None = None
    range_view: str | None = None
    tower_cycle: bool | None = None
    tower_adsb_s: float | None = None
    tower_acars_s: float | None = None
    tower_min_rssi: float | None = None


@app.get("/api/health")
async def health_ok() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/diagnostics")
async def diagnostics() -> dict[str, Any]:
    return health.diagnostics()


class NoiseRequest(BaseModel):
    antenna_label: str = ""
    gain: float | None = None


@app.post("/api/diagnostics/noise")
async def diagnostics_noise(body: NoiseRequest) -> dict[str, Any]:
    flightlog.log_event("mode", f"noise-floor ({body.antenna_label or 'sem rótulo'})")
    return await health.measure_noise(body.antenna_label, body.gain)


@app.get("/api/diagnostics/noise")
async def diagnostics_noise_history() -> dict[str, Any]:
    items = health.load_noise_history()
    return {"measurements": items, "count": len(items)}


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return sdr.status() | {"config": store.load_config()}


@app.post("/api/mode")
async def set_mode(body: ModeRequest) -> dict[str, Any]:
    had_job = bool(schedule.job)
    schedule.on_manual_mode_change(body.mode)  # se a agenda tinha tarefa, suprime até o fim da janela
    if had_job:
        await rec.stop()
    ok, err = await modes.apply(body.mode, body.freq_mhz, body.gain, body.freqs,
                                {"sat": body.sat, "duration": body.duration})
    return {"ok": ok, "error": err or None, "status": sdr.status()}


@app.post("/api/spectrum/scan")
async def spectrum_scan(body: SpectrumRequest) -> dict[str, Any]:
    flightlog.log_event("mode", f"spectrum {body.start_mhz}-{body.end_mhz} MHz")
    series = await sdr.run_spectrum(
        body.start_mhz, body.end_mhz, body.bin_khz, body.gain, body.seconds
    )
    return {"ok": True, "points": series, "meta": sdr.state.spectrum_meta, "status": sdr.status()}


@app.get("/api/spectrum/latest")
async def spectrum_latest() -> dict[str, Any]:
    return {"points": sdr.state.spectrum, "meta": sdr.state.spectrum_meta}


@app.get("/api/adsb/aircraft")
async def adsb_aircraft() -> Any:
    cfg = store.load_config()
    base = cfg.get("adsb_url") or "http://ultrafeeder"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/data/aircraft.json")
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        return {"now": 0, "messages": 0, "aircraft": [], "error": str(e)}
    await aircraftdb.enrich(data.get("aircraft") or [], base)
    return data


@app.get("/api/adsb/trail/{hex_id}")
async def adsb_trail(hex_id: str) -> dict[str, Any]:
    """Trilha da passagem atual (posições do registro SQLite, ~10 s) para desenhar ao selecionar."""
    return flightlog.current_trail(hex_id)


_photo_cache: dict[str, Any] = {}


@app.get("/api/adsb/photo/{hex_id}")
async def adsb_photo(hex_id: str) -> Any:
    """Foto do planespotters (a API deles bloqueia CORS do navegador). Cache em memória."""
    h = hex_id.lower().strip()
    if not h.isalnum() or len(h) > 8:
        return {"photo": None}
    if h in _photo_cache:
        return _photo_cache[h]
    out: dict[str, Any] = {"photo": None}
    # planespotters exige contato (URL ou e-mail) no User-Agent de chamadas server-side
    contact = os.environ.get("PHOTO_CONTACT", "").strip()
    if not contact:
        return {"photo": None, "reason": "defina PHOTO_CONTACT no .env para fotos do planespotters"}
    try:
        ua = f"rtl-sdr-station/1.0 (+{contact})"
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": ua}) as client:
            r = await client.get(f"https://api.planespotters.net/pub/photos/hex/{h}")
            if r.status_code == 200:
                p = (r.json().get("photos") or [None])[0]
                if p:
                    out = {"photo": {
                        "src": (p.get("thumbnail_large") or p.get("thumbnail") or {}).get("src"),
                        "link": p.get("link"),
                        "by": p.get("photographer"),
                    }}
            elif r.status_code != 404:
                return out | {"reason": f"planespotters HTTP {r.status_code}"}  # não cacheia erro
    except Exception:
        return out
    _photo_cache[h] = out
    return out


@app.get("/api/adsb/receiver")
async def adsb_receiver() -> Any:
    cfg = store.load_config()
    base = cfg.get("adsb_url") or "http://ultrafeeder"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/data/receiver.json")
            r.raise_for_status()
            return r.json() | {"db": aircraftdb.status()}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/adsb/stats")
async def adsb_stats() -> Any:
    cfg = store.load_config()
    base = cfg.get("adsb_url") or "http://ultrafeeder"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/data/stats.json")
            r.raise_for_status()
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return store.load_config()


@app.put("/api/config")
async def put_config(body: ConfigIn) -> dict[str, Any]:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    return store.save_config(patch)


@app.get("/api/tower/cycle")
async def tower_cycle_status() -> dict[str, Any]:
    return tower_cycle.status()


@app.get("/api/markers")
async def markers() -> list[dict[str, Any]]:
    return store.load_markers()


@app.post("/api/markers")
async def create_marker(body: MarkerIn) -> dict[str, Any]:
    return store.add_marker(body.model_dump())


@app.delete("/api/markers/{marker_id}")
async def remove_marker(marker_id: str) -> dict[str, bool]:
    return {"ok": store.delete_marker(marker_id)}


@app.get("/api/range")
async def get_range() -> dict[str, Any]:
    return range_study.study.summary()


@app.post("/api/range/reset")
async def reset_range() -> dict[str, Any]:
    range_study.study.reset()
    return {"ok": True, "range": range_study.study.summary()}


@app.post("/api/range/start")
async def start_range(reset: bool = True) -> dict[str, Any]:
    """Liga ADS-B e (opcional) zera o estudo — ideal ao mudar de local."""
    if reset:
        range_study.study.reset()
    await sdr.start_adsb()
    flightlog.log_event("mode", "adsb (range/start)")
    return {"ok": True, "status": sdr.status(), "range": range_study.study.summary()}


@app.get("/api/range/report.html")
async def range_report_html() -> HTMLResponse:
    html = report_html.build_range_html(range_study.study.summary())
    return HTMLResponse(
        content=html,
        headers={"Content-Disposition": 'inline; filename="adsb-range-study.html"'},
    )


@app.get("/api/range/report.download")
async def range_report_download() -> Response:
    html = report_html.build_range_html(range_study.study.summary())
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="adsb-range-study.html"'},
    )


@app.get("/api/log")
async def log_list(
    since: float | None = None,
    until: float | None = None,
    q: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    return flightlog.query(since, until, q, max(1, min(limit, 2000)), max(0, offset))


@app.get("/api/log/stats")
async def log_stats() -> dict[str, Any]:
    return flightlog.stats()


@app.get("/api/log/events")
async def log_events(limit: int = 100) -> list[dict[str, Any]]:
    return flightlog.events(max(1, min(limit, 1000)))


@app.get("/api/log/export.csv")
async def log_export(since: float | None = None, until: float | None = None, q: str | None = None) -> Response:
    """Apelido de GET /api/export/sightings.csv (mantém o link antigo do Registro)."""
    if q:
        # filtro textual só no apelido legado (export genérico não tem q)
        return PlainTextResponse(
            flightlog.export_csv(since, until, q),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="adsb-log.csv"'},
        )
    return export.stream("sightings", "csv", since, until)


@app.get("/api/export/{name}")
async def export_dataset(name: str, since: float | None = None, until: float | None = None) -> StreamingResponse:
    """GET /api/export/{dataset}.{csv|jsonl}?since=&until= — Parquet: ver docstring de export.py."""
    if "." not in name:
        raise HTTPException(404, "use dataset.csv ou dataset.jsonl")
    dataset, fmt = name.rsplit(".", 1)
    dataset, fmt = dataset.lower(), fmt.lower()
    if dataset not in export.DATASETS:
        raise HTTPException(404, "conjunto desconhecido")
    if fmt == "parquet":
        raise HTTPException(
            501,
            "parquet não embutido (pyarrow ~150 MB). "
            "Exporte CSV e converta: duckdb -c \"COPY (SELECT * FROM read_csv('x.csv')) TO 'x.parquet'\"",
        )
    if fmt not in export.FORMATS:
        raise HTTPException(404, "formato desconhecido")
    return export.stream(dataset, fmt, since, until)


@app.get("/api/data")
async def data_summary() -> dict[str, Any]:
    return await asyncio.to_thread(retention.sizes)


class RetentionPurgeIn(BaseModel):
    confirm: str = ""
    retention: dict[str, int | None] | None = None


@app.post("/api/data/retention/simulate")
async def data_retention_simulate(body: RetentionPurgeIn | None = None) -> dict[str, Any]:
    cfg = retention.retention_cfg()
    if body and body.retention is not None:
        cfg = {**cfg, **body.retention}
        for k, v in list(cfg.items()):
            if v is not None and int(v) <= 0:
                cfg[k] = None
    return {"simulate": await asyncio.to_thread(retention.simulate, cfg), "retention": cfg}


@app.post("/api/data/retention/purge")
async def data_retention_purge(body: RetentionPurgeIn) -> dict[str, Any]:
    if (body.confirm or "").strip() != retention.CONFIRM_PHRASE:
        raise HTTPException(400, f'digite "{retention.CONFIRM_PHRASE}" para confirmar')
    cfg = retention.retention_cfg()
    if body.retention is not None:
        cfg = {**cfg, **body.retention}
        for k, v in list(cfg.items()):
            if v is not None and int(v) <= 0:
                cfg[k] = None
    result = await asyncio.to_thread(retention.run, cfg)
    return {"ok": True, **result}


@app.get("/api/update")
async def get_update() -> dict[str, Any]:
    return update_check.status()


@app.get("/api/log/{sighting_id}/track")
async def log_track(sighting_id: int) -> list[dict[str, Any]]:
    return flightlog.track(sighting_id)


@app.get("/api/datalink")
async def datalink_list(
    after_id: int = 0,
    source: str | None = None,
    q: str | None = None,
    control: bool = True,
    limit: int = 200,
) -> list[dict[str, Any]]:
    return await asyncio.to_thread(datalink.query, max(0, after_id), source, q, control, max(1, min(limit, 2000)))


@app.get("/api/datalink/stats")
async def datalink_stats() -> dict[str, Any]:
    return await asyncio.to_thread(datalink.stats) | {"defaults": datalink.DEFAULT_FREQS, "max_span_mhz": datalink.MAX_SPAN_MHZ}


@app.get("/api/datalink/{msg_id}/raw")
async def datalink_raw(msg_id: int) -> Any:
    return {"raw": await asyncio.to_thread(datalink.raw, msg_id)}


OBS_SOURCES = ("ais", "ism", "aprs", "sonde")


def _src(source: str) -> str:
    if source not in OBS_SOURCES:
        raise HTTPException(404, "fonte desconhecida")
    return source


@app.get("/api/obs/{source}/objects")
async def obs_objects(source: str, since: float | None = None, limit: int = 2000) -> list[dict[str, Any]]:
    return await asyncio.to_thread(obs.objects, _src(source), since, max(1, min(limit, 5000)))


@app.get("/api/obs/{source}/track/{key}")
async def obs_track(source: str, key: str, since: float | None = None) -> list[dict[str, Any]]:
    return await asyncio.to_thread(obs.track, _src(source), key, since)


@app.get("/api/obs/{source}/messages")
async def obs_messages(source: str, after_id: int = 0, key: str | None = None, q: str | None = None,
                       limit: int = 200) -> list[dict[str, Any]]:
    return await asyncio.to_thread(obs.messages, _src(source), max(0, after_id), key, q, max(1, min(limit, 2000)))


@app.get("/api/obs/{source}/stats")
async def obs_stats(source: str) -> dict[str, Any]:
    out = await asyncio.to_thread(obs.stats, _src(source))
    if source == "sonde":
        out["container"] = await asyncio.to_thread(sdr.sonde_status)
        out["log"] = await asyncio.to_thread(sdr.sonde_logs, 30) if out["container"]["running"] else list(decoders.log["sonde"])
    else:
        out["log"] = list(decoders.log[source])
    return out


@app.get("/api/rds")
async def rds() -> dict[str, Any]:
    return {"rds": decoders.rds, "log": list(decoders.log["rds"])[-10:]}


@app.get("/api/sat/passes")
async def sat_passes(refresh: bool = False) -> dict[str, Any]:
    items = await sats.passes(force=refresh)
    return {"passes": items, "sats": sats.SATS, "agenda": sats.agenda_status(),
            "log": list(decoders.log["sat"]), "live": sats.live_status()}


@app.get("/api/sat/passes/{pass_id}/track")
async def sat_pass_track(pass_id: str) -> dict[str, Any]:
    tr = await sats.track(pass_id)
    if not tr:
        raise HTTPException(404, "passagem não encontrada")
    return tr


@app.get("/api/sat/now")
async def sat_now() -> dict[str, Any]:
    return {"sats": await sats.now_positions(), "ts": time.time()}


@app.get("/api/sat/captures")
async def sat_captures() -> list[dict[str, Any]]:
    return await asyncio.to_thread(sats.captures)


@app.delete("/api/sat/captures/{dirname}")
async def sat_capture_delete(dirname: str) -> dict[str, Any]:
    ok, err = await asyncio.to_thread(sats.delete_capture, dirname)
    if not ok:
        raise HTTPException(400, err or "não apagou")
    return {"ok": True}


@app.post("/api/sat/captures/prune-empty")
async def sat_captures_prune() -> dict[str, Any]:
    n = await asyncio.to_thread(sats.delete_empty_captures)
    return {"ok": True, "removed": n}


@app.get("/api/sat/file/{rel:path}")
async def sat_file(rel: str) -> Any:
    p = sats.safe_path(rel)
    if not p:
        raise HTTPException(404, "arquivo não encontrado")
    return FileResponse(p)


@app.get("/api/sat/thumb/{rel:path}")
async def sat_thumb(rel: str, w: int = 480) -> Any:
    p = await asyncio.to_thread(sats.make_thumb, rel, w)
    if not p:
        raise HTTPException(404, "miniatura indisponível")
    return FileResponse(p, media_type="image/jpeg")


# ---------- agenda unificada ----------

class ScheduleEntryIn(BaseModel):
    label: str = ""
    kind: str = "mode"  # mode | audio
    mode: str = "fm"
    freq: float | None = None
    freqs: list[float] | None = None
    gain: float | None = None
    repeat: str = "once"  # once | daily | weekly
    days: list[int] = Field(default_factory=list)
    date: str = ""
    start: str = "00:00"
    end: str = "00:30"
    enabled: bool = True


class ScheduleSkipIn(BaseModel):
    ref: str
    date: str = ""


@app.get("/api/schedule/timeline")
async def schedule_timeline(hours: float = 48.0) -> dict[str, Any]:
    hours = max(1.0, min(float(hours), 168.0))
    cfg = store.load_config()
    passes = await sats.passes() if cfg.get("sat_auto") else []
    return {
        "hours": hours,
        "segments": schedule.timeline(hours=hours, passes=passes),
        "agenda": schedule.agenda_status() | {"tle_fetched": sats.agenda_status().get("tle_fetched")},
        "entries": schedule.list_entries(),
        "skips": schedule.list_skips(),
        "recording": rec.status(),
    }


@app.get("/api/schedule/entries")
async def schedule_entries() -> list[dict[str, Any]]:
    return schedule.list_entries()


@app.post("/api/schedule/entries")
async def schedule_entry_create(body: ScheduleEntryIn) -> dict[str, Any]:
    return schedule.add_entry(body.model_dump())


@app.put("/api/schedule/entries/{entry_id}")
async def schedule_entry_update(entry_id: str, body: ScheduleEntryIn) -> dict[str, Any]:
    item = schedule.update_entry(entry_id, body.model_dump())
    if not item:
        raise HTTPException(404, "entrada não encontrada")
    return item


@app.delete("/api/schedule/entries/{entry_id}")
async def schedule_entry_delete(entry_id: str) -> dict[str, bool]:
    if not schedule.delete_entry(entry_id):
        raise HTTPException(404, "entrada não encontrada")
    return {"ok": True}


@app.post("/api/schedule/skip")
async def schedule_skip(body: ScheduleSkipIn) -> dict[str, Any]:
    return schedule.add_skip(body.ref, body.date)


class AlertsSeenIn(BaseModel):
    ids: list[int] | None = None
    all: bool = False


class AlertsRulesIn(BaseModel):
    emergency_squawk: bool | None = None
    military: bool | None = None
    watchlist_hex: list[str] | None = None
    watchlist_reg: list[str] | None = None
    watchlist_flight: list[str] | None = None
    low_near_enabled: bool | None = None
    low_near_km: float | None = None
    low_near_alt_ft: float | None = None
    new_ship: bool | None = None
    sonde_enabled: bool | None = None
    sonde_km: float | None = None
    sonde_descending: bool | None = None
    sat_ok: bool | None = None
    silence_s: dict[str, float] | None = None


@app.get("/api/alerts")
async def alerts_list(after_id: int = 0, limit: int = 50, unseen: bool = False) -> dict[str, Any]:
    items = alerts.list_alerts(after_id=after_id, limit=limit, unseen_only=unseen)
    return {"items": items, "unseen": alerts.unseen_count()}


@app.post("/api/alerts/seen")
async def alerts_seen(body: AlertsSeenIn) -> dict[str, Any]:
    n = alerts.mark_seen(body.ids, all_unseen=body.all)
    return {"ok": True, "updated": n, "unseen": alerts.unseen_count()}


@app.get("/api/alerts/rules")
async def alerts_rules_get() -> dict[str, Any]:
    return alerts.rules()


@app.put("/api/alerts/rules")
async def alerts_rules_put(body: AlertsRulesIn) -> dict[str, Any]:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    return alerts.save_rules(patch)


@app.get("/api/tiles/{provider}/{z}/{x}/{y}.png")
async def get_tile(provider: str, z: int, x: int, y: int) -> Response:
    """Bloco de mapa: serve de /data/tiles/ ou busca no provedor (whitelist) e grava."""
    body = await tiles.fetch_and_cache(provider, z, x, y)
    return Response(
        content=body,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/maps")
async def maps_list() -> dict[str, Any]:
    """Lista arquivos PMTiles em /data/maps/*.pmtiles (camada Offline do painel)."""
    return {"maps": tiles.list_pmtiles()}


@app.get("/api/maps/{name}.pmtiles")
async def maps_get(name: str, request: Request) -> Response:
    """Serve PMTiles com Range (biblioteca pmtiles no front). Ver docstring de tiles.py."""
    p = tiles.pmtiles_path(name)
    if not p:
        raise HTTPException(404, "mapa não encontrado")
    return tiles.pmtiles_response(p, request)


@app.get("/api/rec")
async def rec_list() -> dict[str, Any]:
    return {"recordings": rec.list_recordings(), "status": rec.status(),
            "rec_max_gb": store.load_config().get("rec_max_gb", 2.0)}


@app.get("/api/rec/{name}")
async def rec_get(name: str) -> Any:
    p = rec.safe_path(name)
    if not p:
        raise HTTPException(404, "gravação não encontrada")
    # FileResponse do Starlette já responde a Range
    return FileResponse(p, media_type="audio/wav", filename=p.name)


@app.delete("/api/rec/{name}")
async def rec_delete(name: str) -> dict[str, Any]:
    ok, err = rec.delete(name)
    if not ok:
        raise HTTPException(400, err or "não apagou")
    return {"ok": True}


@app.websocket("/api/ws/audio")
async def ws_audio(ws: WebSocket) -> None:
    """PCM s16le mono. Primeiro um JSON `hello` com o sample rate, depois bytes.

    Cada conexão tem a própria fila. Uma tarefa separada só escuta o cliente: quando ele fecha (ou manda
    "bye"), o envio para. Antes a desconexão era engolida e o servidor seguia enviando até estourar.
    Viewer pode ouvir; sem cookie válido (auth ligada) fecha com 4401 antes do accept."""
    if auth.auth_required():
        role = await auth.reject_ws_if_unauthorized(ws)
        if role is None:
            return
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    sdr.state.audio_queues.add(q)
    closed = asyncio.Event()

    async def watch_client() -> None:
        try:
            while True:
                if await ws.receive_text() == "bye":
                    break
        except Exception:  # WebSocketDisconnect ou socket já fechado
            pass
        finally:
            closed.set()

    watcher = asyncio.create_task(watch_client())
    try:
        rate = int(sdr.state.params.get("sample_rate") or 48000)
        await ws.send_json({"type": "hello", "sample_rate": rate, "mode": sdr.state.mode})
        while not closed.is_set():
            try:
                chunk = await asyncio.wait_for(q.get(), timeout=0.5)
            except TimeoutError:
                continue
            await ws.send_bytes(chunk)
    except (WebSocketDisconnect, RuntimeError):
        pass  # cliente saiu no meio de um envio
    finally:
        sdr.state.audio_queues.discard(q)
        watcher.cancel()
