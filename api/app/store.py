# Autor: Matheus C. Pestana
"""Persistência simples de config e marcadores em JSON."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

DATA = Path(os.environ.get("URUTAU_DATA", "/data"))  # volume api_data; os testes apontam para uma pasta temporária
CONFIG_PATH = DATA / "config.json"
MARKERS_PATH = DATA / "markers.json"



def _env_float(name: str) -> float | None:
    try:
        v = float(os.environ.get(name, "").strip())
    except ValueError:
        return None
    return v if v == v else None  # descarta NaN


DEFAULT_CONFIG: dict[str, Any] = {
    # localização do receptor: vem do .env (READSB_LAT/READSB_LON) até ser mudada no painel; sem ela,
    # alcance, distâncias, passagens de satélite e sondas ficam desligados
    "lat": _env_float("READSB_LAT"),
    "lon": _env_float("READSB_LON"),
    "address": "",
    "fm_freq_mhz": 90.3,
    "fm_gain": 40.0,
    "airband_freq_mhz": 119.3,
    "airband_gain": 45.0,
    "spectrum_start_mhz": 88.0,
    "spectrum_end_mhz": 108.0,
    "spectrum_bin_khz": 50.0,
    "spectrum_gain": 40.0,
    "adsb_url": "http://ultrafeeder",
    "tar1090_public": "",  # vazio = mesmo endereço do painel, porta 8089 (funciona pela rede local e Tailscale)
    "acars_freqs": [131.550, 131.725, 131.825, 131.450, 131.125, 130.450, 130.425, 130.025],
    "vdl2_freqs": [136.975, 136.925, 136.875, 136.825, 136.775, 136.725],
    "datalink_gain": 40.0,
    "ais_gain": 40.0,
    "ism_freqs": [433.92],
    "ism_gain": 0.0,  # 0 = AGC no rtl_433
    "ism_hop_s": 60,
    "aprs_freq_mhz": 145.570,  # frequência APRS do Brasil
    "aprs_gain": 40.0,
    "sonde_gain": 40.0,
    "sonde_min_mhz": 400.05,
    "sonde_max_mhz": 406.0,
    "sonde_auto": False,
    # as estações do INMET/DECEA soltam sondas por volta de 00Z e 12Z → 21h e 9h em Brasília, com ~45 min de antecedência
    "sonde_windows": ["08:00-10:30", "20:00-22:30"],
    "sat_auto": False,
    "sat_min_el": 20.0,
    "sat_gain": 40.0,
    "sat_pipeline": "auto",  # auto | 72k | 80k
    "rec_max_gb": 2.0,  # gravações em /data/rec; apaga as mais antigas ao estourar
    "tiles_max_mb": 512.0,  # cache de blocos de mapa em /data/tiles; descarte do mais antigo
    # dois dongles: vazios = comportamento de um só; o .env (URUTAU_*_SERIAL) é o padrão
    "adsb_serial": "",
    "sdr_serial": "",
    # alertas só no navegador (ver api/app/alerts.py); sem Telegram/e-mail
    "alerts": {},
}


def _ensure() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
    if not MARKERS_PATH.exists():
        MARKERS_PATH.write_text("[]")


def load_config() -> dict[str, Any]:
    _ensure()
    cfg = DEFAULT_CONFIG | json.loads(CONFIG_PATH.read_text())
    return cfg


def receiver() -> tuple[float, float] | None:
    """(lat, lon) do receptor, ou None se ainda não foi definida."""
    cfg = load_config()
    try:
        lat, lon = float(cfg["lat"]), float(cfg["lon"])
    except (TypeError, ValueError, KeyError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None
    return lat, lon


def save_config(cfg: dict[str, Any]) -> dict[str, Any]:
    _ensure()
    merged = load_config() | cfg
    CONFIG_PATH.write_text(json.dumps(merged, indent=2))
    return merged


def load_markers() -> list[dict[str, Any]]:
    _ensure()
    return json.loads(MARKERS_PATH.read_text())


def save_markers(markers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    _ensure()
    MARKERS_PATH.write_text(json.dumps(markers, indent=2))
    return markers


def add_marker(payload: dict[str, Any]) -> dict[str, Any]:
    markers = load_markers()
    item = {
        "id": str(uuid.uuid4()),
        "title": payload.get("title") or "Marcador",
        "kind": payload.get("kind") or "note",
        "freq_mhz": payload.get("freq_mhz"),
        "lat": payload.get("lat"),
        "lon": payload.get("lon"),
        "note": payload.get("note") or "",
        "color": payload.get("color") or "#e8a838",
    }
    markers.append(item)
    save_markers(markers)
    return item


def delete_marker(marker_id: str) -> bool:
    markers = load_markers()
    nxt = [m for m in markers if m["id"] != marker_id]
    if len(nxt) == len(markers):
        return False
    save_markers(nxt)
    return True
