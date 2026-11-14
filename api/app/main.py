# Autor: Matheus C. Pestana
"""Urutau — API da estação RTL-SDR: modos, áudio, espectro, ADS-B, decodificadores, marcadores."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from . import (
    __version__,
    aircraftdb,
    datalink,
    decoders,
    flightlog,
    modes,
    obs,
    range_study,
    report_html,
    sats,
    sdr,
    store,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    flightlog.init()
    datalink.init()
    obs.init()
    await decoders.start_sonde_listener()
    flightlog.log_event("api_start")
    range_study.start_background()
    restore = asyncio.create_task(modes.restore())  # volta ao último modo escolhido
    guard = asyncio.create_task(sdr.guard_loop())
    agenda = asyncio.create_task(sats.scheduler_loop())
    yield
    restore.cancel()
    guard.cancel()
    agenda.cancel()
    await sdr.stop_proc()  # não deixa o container da sonda órfão
    range_study.study.save()
    flightlog.log_event("api_stop")
    flightlog.close()
    datalink.close()
    obs.close()


app = FastAPI(title="Urutau API", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return sdr.status() | {"config": store.load_config()}


@app.post("/api/mode")
async def set_mode(body: ModeRequest) -> dict[str, Any]:
    if sats.job and body.mode != sats.job.get("mode"):
        sats.suppressed[sats.job["mode"]] = sats.job["until"]  # o usuário assumiu: a agenda não retoma
        sats.job.clear()
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
async def log_export(since: float | None = None, until: float | None = None, q: str | None = None) -> PlainTextResponse:
    return PlainTextResponse(
        flightlog.export_csv(since, until, q),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="adsb-log.csv"'},
    )


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
    return {"passes": items, "sats": sats.SATS, "agenda": sats.agenda_status(), "log": list(decoders.log["sat"])}


@app.get("/api/sat/captures")
async def sat_captures() -> list[dict[str, Any]]:
    return await asyncio.to_thread(sats.captures)


@app.get("/api/sat/file/{rel:path}")
async def sat_file(rel: str) -> Any:
    p = sats.safe_path(rel)
    if not p:
        raise HTTPException(404, "arquivo não encontrado")
    return FileResponse(p)


@app.websocket("/api/ws/audio")
async def ws_audio(ws: WebSocket) -> None:
    """PCM s16le mono. Primeiro um JSON `hello` com o sample rate, depois bytes.

    Cada conexão tem a própria fila. Uma tarefa separada só escuta o cliente: quando ele fecha (ou manda
    "bye"), o envio para. Antes a desconexão era engolida e o servidor seguia enviando até estourar."""
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
