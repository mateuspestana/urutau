# Autor: Matheus C. Pestana
"""Interpretação da saída de cada decodificador → `obs.record`.

- AIS: AIS-catcher, uma linha JSON por mensagem (`-o 5`).
- ISM: rtl_433 `-F json`.
- APRS: multimon-ng `-A` imprime "APRS: CALL>DEST,PATH:payload"; aprslib interpreta.
- Sondas: o radiosonde_auto_rx manda PAYLOAD_SUMMARY por UDP (porta 55673) para a API.
- RDS: redsea, uma linha JSON por grupo; só o estado atual da emissora fica em memória.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from typing import Any

import aprslib

from . import obs


class SinkDeque(deque):
    """deque que avisa um ouvinte a cada linha nova (deque não aceita trocar `append` na instância)."""

    hook: Any = None

    def append(self, item: Any) -> None:
        if self.hook is not None:
            try:
                self.hook(item)
            except Exception:  # o ouvinte nunca derruba o leitor do processo
                pass
        super().append(item)


log: dict[str, deque[str]] = {
    k: (SinkDeque(maxlen=30) if k == "sat" else deque(maxlen=30)) for k in ("ais", "ism", "aprs", "sonde", "sat", "rds")
}

# AIS: campos que não interessam no estado do navio
_AIS_SKIP = {"class", "device", "nmea", "scaled", "repeat", "second", "spare", "raim", "radio", "rxtime",
             "rxuxtime", "driver", "hardware", "version", "ppm", "eta_month", "eta_day", "eta_hour",
             "eta_minute", "dte", "assigned", "maneuver", "sync_state", "slot_timeout", "regional",
             "epfd", "epfd_text", "ais_version", "cs", "display", "dsc", "band", "msg22", "partno"}


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def ais_line(line: str) -> None:
    line = line.strip()
    if not line.startswith("{"):
        if line:
            log["ais"].append(line[:300])
        return
    try:
        m = json.loads(line)
    except ValueError:
        return
    mmsi = m.get("mmsi")
    if not mmsi:
        return
    data = {k: v for k, v in m.items() if k not in _AIS_SKIP}
    data["last_type"] = m.get("type")
    if m.get("signalpower") is not None:
        data["level"] = m.get("signalpower")
    # 511 = proa desconhecida; 102.3 nós = velocidade indisponível; 360 = rumo indisponível
    if data.get("heading") == 511:
        data.pop("heading")
    if (_float(data.get("speed")) or 0) >= 102.2:
        data.pop("speed", None)
    if (_float(data.get("course")) or 0) >= 360:
        data.pop("course", None)
    if m.get("type") == 24 and m.get("partno") not in (None, 0):
        data.pop("shipname", None)  # parte B não traz nome
    obs.record("ais", str(mmsi), data, lat=m.get("lat"), lon=m.get("lon"),
               ts=_float(m.get("rxuxtime")) or time.time())


def ism_line(line: str) -> None:
    line = line.strip()
    if not line.startswith("{"):
        if line:
            log["ism"].append(line[:300])
        return
    try:
        m = json.loads(line)
    except ValueError:
        return
    # hop/status do rtl_433: JSON sem "model" (só center_frequency / frequencies / hop_times)
    model = m.get("model")
    if not model:
        return
    key = ":".join(str(x) for x in (model, m.get("id", ""), m.get("channel", "")) if x != "")
    ts = _float(m.get("time")) or time.time()
    data = {k: v for k, v in m.items() if k not in ("time", "mic", "mod")}
    summary = ", ".join(f"{k}={v}" for k, v in data.items() if k not in ("model", "id", "channel", "rssi", "snr", "noise", "freq", "freq1", "freq2"))
    obs.record("ism", key, data, ts=ts, text=summary[:400], keep_message=True)


def aprs_line(line: str) -> None:
    line = line.strip()
    if not line.startswith("APRS: "):
        if line and not line.startswith(("AFSK1200:", "multimon-ng", "Enabled demodulators")):
            log["aprs"].append(line[:300])
        return
    raw = line[6:]
    try:
        p = aprslib.parse(raw)
    except Exception as e:  # pacote fora do padrão: guarda mesmo assim
        call = raw.split(">", 1)[0]
        obs.record("aprs", call, {"raw": raw, "error": str(e)[:120]}, text=raw, keep_message=True)
        return
    keep = ("from", "to", "path", "via", "format", "symbol", "symbol_table", "comment", "status", "speed",
            "course", "altitude", "message_text", "addresse", "weather", "telemetry", "object_name", "raw")
    data = {k: p.get(k) for k in keep if p.get(k) not in (None, "", [])}
    key = p.get("object_name") or p.get("from") or raw.split(">", 1)[0]
    obs.record("aprs", str(key).strip(), data, lat=p.get("latitude"), lon=p.get("longitude"),
               alt=p.get("altitude"), text=raw, keep_message=True)


# ---------- radiossondas (UDP do auto_rx) ----------

class SondeProtocol(asyncio.DatagramProtocol):
    def datagram_received(self, data: bytes, addr: Any) -> None:
        try:
            m = json.loads(data.decode(errors="replace"))
        except ValueError:
            return
        if m.get("type") != "PAYLOAD_SUMMARY" or not m.get("callsign"):
            return
        keep = {k: v for k, v in m.items() if k not in ("type", "station")}
        try:
            obs.record("sonde", str(m["callsign"]), keep, lat=m.get("latitude"), lon=m.get("longitude"),
                       alt=m.get("altitude"))
        except Exception as e:
            log["sonde"].append(f"api: {e}")


async def start_sonde_listener(port: int = 55673) -> None:
    loop = asyncio.get_running_loop()
    try:
        await loop.create_datagram_endpoint(SondeProtocol, local_addr=("0.0.0.0", port), allow_broadcast=True)
    except OSError as e:
        log["sonde"].append(f"api: UDP {port} indisponível: {e}")


# ---------- RDS ----------

rds: dict[str, Any] = {}


def reset_rds() -> None:
    rds.clear()


def rds_line(line: str) -> None:
    line = line.strip()
    if not line.startswith("{"):
        if line:
            log["rds"].append(line[:300])
        return
    try:
        m = json.loads(line)
    except ValueError:
        return
    rds["groups"] = rds.get("groups", 0) + 1
    rds["last_ts"] = time.time()
    for k in ("pi", "ps", "long_ps", "prog_type", "radiotext", "callsign", "tp", "ta", "is_music",
              "clock_time", "alt_frequencies_a", "di"):
        if m.get(k) not in (None, "", []):
            rds[k] = m[k]
    # com sinal fraco o PS completo demora; o parcial (com espaços no que falta) já ajuda
    for full, part in (("ps", "partial_ps"), ("radiotext", "partial_radiotext")):
        if isinstance(m.get(part), str) and m[part].strip() and not m.get(full):
            rds[f"{full}_partial"] = m[part]
    rt = m.get("radiotext_plus")
    if isinstance(rt, dict) and rt.get("tags"):
        rds["rt_plus"] = {t.get("content-type"): t.get("data") for t in rt["tags"] if isinstance(t, dict)}
