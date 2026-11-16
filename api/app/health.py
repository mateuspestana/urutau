# Autor: Matheus C. Pestana
"""Diagnóstico da estação: dongles USB, avisos, disco, piso de ruído por faixa.

`GET /api/diagnostics` (não confundir com `/api/health`, que só responde ok).
Medição de ruído usa `sdr.run_spectrum` e restaura o modo anterior via `modes.apply`.
"""
from __future__ import annotations

import json
import math
import shutil
import time
from pathlib import Path
from typing import Any

from . import datalink, decoders, flightlog, modes, range_study, sdr, store

HEALTH_PATH = store.DATA / "health.json"
MAX_NOISE_ENTRIES = 50
USB_CLAIM_NEEDLE = "usb_claim_interface error -6"
RTL_IDS = {("0bda", "2838"), ("0bda", "2832")}  # RTL2832U / RTL-SDR Blog V3–V4
DVB_MODULE = "dvb_usb_rtl28xxu"

# Faixas para medir (~8 s cada). Passo 10–50 kHz: faixas estreitas → 10, largas → 50.
NOISE_BANDS: list[dict[str, Any]] = [
    {"name": "fm", "label": "FM", "start": 88.0, "end": 108.0, "bin_khz": 50.0},
    {"name": "aero", "label": "aeronáutica", "start": 118.0, "end": 137.0, "bin_khz": 50.0},
    {"name": "meteor", "label": "Meteor", "start": 137.0, "end": 138.0, "bin_khz": 10.0},
    {"name": "ais", "label": "AIS", "start": 161.0, "end": 163.0, "bin_khz": 20.0},
    {"name": "sonde", "label": "sondas", "start": 400.0, "end": 406.0, "bin_khz": 25.0},
    {"name": "ism", "label": "ISM", "start": 433.0, "end": 434.0, "bin_khz": 10.0},
    {"name": "adsb", "label": "ADS-B", "start": 1085.0, "end": 1095.0, "bin_khz": 50.0},
]
NOISE_SECONDS = 8
NOISE_GAIN = 40.0

_boot_ts = time.time()


def median(values: list[float]) -> float | None:
    """Mediana de uma lista; None se vazia."""
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def percentile10(values: list[float]) -> float | None:
    """Percentil 10 (piso baixo de ruído); None se vazia."""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    # índice linear 0…n-1
    idx = 0.10 * (len(s) - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return s[lo]
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def band_stats(points: list[dict[str, float]]) -> dict[str, float | None]:
    """Resumo de pontos rtl_power: mediana, p10, pico e freq. do pico."""
    dbs = [float(p["db"]) for p in points if p.get("db") is not None]
    noise = median(dbs)
    p10 = percentile10(dbs)
    peak_db: float | None = None
    peak_mhz: float | None = None
    for p in points:
        db = p.get("db")
        if db is None:
            continue
        if peak_db is None or float(db) > peak_db:
            peak_db = float(db)
            peak_mhz = float(p.get("mhz") or 0)
    return {
        "noise_db": round(noise, 2) if noise is not None else None,
        "p10": round(p10, 2) if p10 is not None else None,
        "peak_db": round(peak_db, 2) if peak_db is not None else None,
        "peak_mhz": round(peak_mhz, 3) if peak_mhz is not None else None,
    }


def compare_bands(
    current: list[dict[str, Any]],
    baseline: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Delta de noise_db por faixa (atual − baseline). Negativo = mais silencioso = melhor antena?"""
    by_name = {str(b.get("name")): b for b in baseline}
    out: list[dict[str, Any]] = []
    for b in current:
        name = str(b.get("name"))
        other = by_name.get(name)
        cur_n = b.get("noise_db")
        base_n = other.get("noise_db") if other else None
        delta = None
        if cur_n is not None and base_n is not None:
            delta = round(float(cur_n) - float(base_n), 2)
        out.append({
            "name": name,
            "label": b.get("label") or (other or {}).get("label") or name,
            "start": b.get("start"),
            "end": b.get("end"),
            "noise_db": cur_n,
            "baseline_db": base_n,
            "delta_db": delta,
        })
    return out


def _read_sys(path: Path) -> str:
    try:
        return path.read_text(errors="replace").strip()
    except OSError:
        return ""


def list_rtl_dongles(sys_root: str | Path = "/sys") -> list[dict[str, str]]:
    """Lista RTL-SDR em /sys/bus/usb/devices (sem abrir o dispositivo)."""
    root = Path(sys_root) / "bus" / "usb" / "devices"
    found: list[dict[str, str]] = []
    if not root.is_dir():
        return found
    for dev in sorted(root.iterdir()):
        if ":" in dev.name:  # interfaces, não o dispositivo
            continue
        vendor = _read_sys(dev / "idVendor").lower()
        product = _read_sys(dev / "idProduct").lower()
        if (vendor, product) not in RTL_IDS:
            continue
        found.append({
            "bus_path": dev.name,
            "id_vendor": vendor,
            "id_product": product,
            "product": _read_sys(dev / "product") or f"RTL-SDR {vendor}:{product}",
            "serial": _read_sys(dev / "serial"),
        })
    return found


def dvb_driver_loaded(sys_root: str | Path = "/sys") -> bool:
    return (Path(sys_root) / "module" / DVB_MODULE).exists()


def _scan_text_for_usb_claim(chunks: list[str]) -> bool:
    needle = USB_CLAIM_NEEDLE
    return any(needle in (c or "") for c in chunks)


def usb_claim_sources() -> list[dict[str, str]]:
    """Onde aparece usb_claim_interface error -6 (dongle já em uso / driver DVB)."""
    hits: list[dict[str, str]] = []
    for src, dq in decoders.log.items():
        if _scan_text_for_usb_claim(list(dq)):
            hits.append({"source": f"decoders.log[{src}]", "level": "critical",
                         "code": "usb_claim"})
    if _scan_text_for_usb_claim(list(datalink.decoder_log)):
        hits.append({"source": "datalink.decoder_log", "level": "critical", "code": "usb_claim"})
    if USB_CLAIM_NEEDLE in (sdr.state.last_error or ""):
        hits.append({"source": "state.last_error", "level": "critical", "code": "usb_claim"})
    return hits


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    try:
        for p in path.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def data_usage() -> dict[str, Any]:
    data = store.DATA
    try:
        du = shutil.disk_usage(data)
        disk = {
            "total_bytes": du.total,
            "used_bytes": du.used,
            "free_bytes": du.free,
            "used_pct": round(100 * du.used / du.total, 1) if du.total else 0.0,
        }
    except OSError as e:
        disk = {"error": str(e)}
    folders = {
        "flightlog.db": _dir_size(data / "flightlog.db"),
        "datalink.db": _dir_size(data / "datalink.db"),
        "decoders.db": _dir_size(data / "decoders.db"),
        "range.json": _dir_size(data / "range.json"),
        "tle.json": _dir_size(data / "tle.json"),
        "health.json": _dir_size(data / "health.json"),
        "sat": _dir_size(data / "sat"),
        "rec": _dir_size(data / "rec"),
    }
    return {"disk": disk, "paths": folders, "data_bytes": sum(folders.values())}


def tle_age_s() -> float | None:
    path = store.DATA / "tle.json"
    if not path.exists():
        return None
    try:
        cached = json.loads(path.read_text())
        fetched = float(cached.get("fetched") or 0)
        if fetched <= 0:
            return None
        return max(0.0, time.time() - fetched)
    except (OSError, ValueError, TypeError):
        return None


def last_mode_event() -> dict[str, Any] | None:
    try:
        for ev in flightlog.events(50):
            if ev.get("kind") == "mode":
                return {"ts": ev.get("ts"), "detail": ev.get("detail")}
    except Exception:
        pass
    return None


def build_warnings(sys_root: str | Path = "/sys") -> list[dict[str, str]]:
    """Avisos críticos primeiro."""
    warnings: list[dict[str, str]] = []
    dongles = list_rtl_dongles(sys_root)
    if not dongles:
        warnings.append({
            "level": "critical",
            "code": "no_dongle",
            "message": "Nenhum dongle RTL-SDR detectado no USB",
            "hint": "Conecte o dongle e confira se aparece em /sys/bus/usb",
        })
    if dvb_driver_loaded(sys_root):
        warnings.append({
            "level": "critical",
            "code": "dvb_driver",
            "message": "Driver de TV (dvb_usb_rtl28xxu) carregado",
            "hint": "Rode ./install.sh e aceite bloquear o driver DVB",
        })
    for hit in usb_claim_sources():
        warnings.append({
            "level": "critical",
            "code": "usb_claim",
            "message": "usb_claim_interface error -6 (dongle em uso ou driver DVB)",
            "hint": hit["source"],
        })
    usage = data_usage()
    disk = usage.get("disk") or {}
    if isinstance(disk.get("used_pct"), (int, float)) and disk["used_pct"] >= 90:
        warnings.append({
            "level": "warn",
            "code": "disk_full",
            "message": "Disco quase cheio",
            "hint": f"{disk['used_pct']}% usado — libere espaço em /data (sat/, rec/, bancos)",
        })
    age = tle_age_s()
    if age is not None and age > 7 * 86400:
        warnings.append({
            "level": "warn",
            "code": "tle_stale",
            "message": "TLE com mais de 7 dias",
            "hint": "Abra Satélites ou aguarde a agenda baixar de novo",
        })
    # críticos primeiro
    order = {"critical": 0, "warn": 1, "info": 2}
    warnings.sort(key=lambda w: order.get(w.get("level", "info"), 9))
    return warnings


def diagnostics(sys_root: str | Path = "/sys") -> dict[str, Any]:
    """Payload completo de GET /api/diagnostics."""
    warnings = build_warnings(sys_root)
    dongles = list_rtl_dongles(sys_root)
    usage = data_usage()
    try:
        range_max = range_study.study.summary().get("max_km")
    except Exception:
        range_max = None
    mode_ev = last_mode_event()
    history = load_noise_history()
    return {
        "ts": time.time(),
        "warnings": warnings,
        "critical": any(w.get("level") == "critical" for w in warnings),
        "dongles": dongles,
        "dvb_driver": dvb_driver_loaded(sys_root),
        "containers": {
            "ultrafeeder": sdr.ultrafeeder_status(),
            "radiosonde": sdr.sonde_status(),
        },
        "disk": usage["disk"],
        "paths": usage["paths"],
        "data_bytes": usage["data_bytes"],
        "tle_age_s": tle_age_s(),
        "range_max_km": range_max,
        "last_mode": mode_ev,
        "mode": sdr.state.mode,
        "uptime_s": round(time.time() - _boot_ts, 1),
        "noise_count": len(history),
        "noise_latest": history[-1] if history else None,
        "ppm_hint": (
            "O RTL-SDR Blog V4 tem TCXO (±1 ppm); calibração de PPM não é necessária."
        ),
    }


def load_noise_history() -> list[dict[str, Any]]:
    if not HEALTH_PATH.exists():
        return []
    try:
        raw = json.loads(HEALTH_PATH.read_text())
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict) and isinstance(raw.get("measurements"), list):
            return raw["measurements"]
    except (OSError, ValueError):
        pass
    return []


def _save_noise_history(items: list[dict[str, Any]]) -> None:
    store.DATA.mkdir(parents=True, exist_ok=True)
    HEALTH_PATH.write_text(json.dumps(items[-MAX_NOISE_ENTRIES:], indent=2))


def append_noise_measurement(entry: dict[str, Any]) -> list[dict[str, Any]]:
    items = load_noise_history()
    items.append(entry)
    items = items[-MAX_NOISE_ENTRIES:]
    _save_noise_history(items)
    return items


async def measure_noise(antenna_label: str = "", gain: float | None = None) -> dict[str, Any]:
    """Varre as faixas com rtl_power e restaura o modo anterior."""
    label = (antenna_label or "").strip() or "sem rótulo"
    g = float(gain if gain is not None else NOISE_GAIN)

    prev_mode = sdr.state.mode
    prev_params = dict(sdr.state.params)
    # sat/spectrum não entram em _PERSIST; ao restaurar, preferimos remembered se era passageiro
    restore_mode = prev_mode
    restore_freq = prev_params.get("freq_mhz")
    restore_gain = prev_params.get("gain")
    restore_freqs = prev_params.get("freqs")
    if prev_mode in ("spectrum", "sat"):
        rem = modes.remembered()
        restore_mode = rem.get("mode") or "adsb"
        restore_freq = rem.get("freq")
        restore_gain = rem.get("gain")
        restore_freqs = rem.get("freqs")

    bands_out: list[dict[str, Any]] = []
    try:
        for band in NOISE_BANDS:
            points = await sdr.run_spectrum(
                float(band["start"]),
                float(band["end"]),
                float(band["bin_khz"]),
                g,
                NOISE_SECONDS,
            )
            stats = band_stats(points)
            bands_out.append({
                "name": band["name"],
                "label": band["label"],
                "start": band["start"],
                "end": band["end"],
                "bin_khz": band["bin_khz"],
                **stats,
            })
    finally:
        # sempre tenta devolver o dongle ao modo anterior
        try:
            await modes.apply(
                restore_mode,
                restore_freq if isinstance(restore_freq, (int, float)) else None,
                restore_gain if isinstance(restore_gain, (int, float)) else None,
                restore_freqs if isinstance(restore_freqs, list) else None,
                origin="saúde: fim",
            )
        except Exception as e:
            sdr.state.last_error = f"saúde: falha ao restaurar {restore_mode}: {e}"[:500]

    entry = {
        "ts": time.time(),
        "antenna_label": label,
        "gain": g,
        "bands": bands_out,
    }
    history = append_noise_measurement(entry)
    prev = history[-2] if len(history) >= 2 else None
    return {
        "ok": True,
        "measurement": entry,
        "delta_vs_previous": compare_bands(bands_out, prev["bands"]) if prev else None,
        "status": sdr.status(),
    }
