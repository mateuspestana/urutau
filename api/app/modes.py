# Autor: Matheus C. Pestana
"""Troca de modo num lugar só: usado pelo `POST /api/mode` e pela agenda automática (satélites, sondas)."""
from __future__ import annotations

import json
from typing import Any

from . import datalink, decoders, flightlog, obs, sdr, store

# Modo escolhido pela pessoa, para a API voltar a ele depois de um reinício. A captura de satélite e o
# scan de espectro são passageiros e não entram; o que a agenda liga sozinha também não.
STATE_PATH = store.DATA / "state.json"
_PERSIST = {"idle", "adsb", "fm", "airband", "acars", "vdl2", "ais", "ism", "aprs", "sonde"}


def _remember(mode: str, freq: float | None, gain: float | None, freqs: list[float] | None) -> None:
    try:
        STATE_PATH.write_text(json.dumps({"mode": mode, "freq": freq, "gain": gain, "freqs": freqs}))
    except OSError as e:
        print(f"state: {e}", flush=True)


def remembered() -> dict[str, Any]:
    try:
        st = json.loads(STATE_PATH.read_text())
        if st.get("mode") in _PERSIST:
            return st
    except (OSError, ValueError):
        pass
    return {"mode": "adsb"}


async def restore() -> None:
    """Chamado no início da API: retoma o último modo escolhido (ADS-B na primeira vez)."""
    st = remembered()
    ok, err = await apply(st["mode"], st.get("freq"), st.get("gain"), st.get("freqs"), origin="retomado")
    if not ok and st["mode"] != "adsb":
        await apply("adsb", origin=f"retomado; {st['mode']} falhou: {err}")

def _detail(mode: str, p: dict[str, Any]) -> str:
    if p.get("freq_mhz"):
        return f" {p['freq_mhz']} MHz"
    if p.get("freqs"):
        return f" {len(p['freqs'])} canais"
    if p.get("sat"):
        return f" {p['sat']}"
    return ""


async def apply(mode: str, freq: float | None = None, gain: float | None = None,
                freqs: list[float] | None = None, extra: dict[str, Any] | None = None,
                origin: str = "") -> tuple[bool, str]:
    cfg = store.load_config()
    mode = mode.lower().strip()
    if mode not in sdr.MODES:
        return False, f"modo inválido: {mode}"
    err = ""
    if mode == "idle":
        await sdr.start_idle()
    elif mode == "adsb":
        await sdr.start_adsb()
    elif mode in ("fm", "airband"):
        f = freq if freq is not None else cfg[f"{mode}_freq_mhz"]
        g = gain if gain is not None else cfg[f"{mode}_gain"]
        await sdr.start_fm(float(f), float(g), am=mode == "airband")
    elif mode in sdr.DATALINK:
        fl = freqs or cfg.get(f"{mode}_freqs") or datalink.DEFAULT_FREQS[mode]
        g = gain if gain is not None else cfg.get("datalink_gain", 40.0)
        err = await sdr.start_datalink(mode, fl, float(g))
        if not err:
            store.save_config({f"{mode}_freqs": sdr.state.params["freqs"], "datalink_gain": float(g)})
    elif mode == "ais":
        g = gain if gain is not None else cfg["ais_gain"]
        await sdr.start_lines(
            "ais", ["AIS-catcher", "-d:0", "-gr", "TUNER", str(g), "RTLAGC", "off", "-o", "5"],
            decoders.ais_line, {"freqs": [161.975, 162.025], "gain": g}, decoders.log["ais"], "AIS-catcher")
        store.save_config({"ais_gain": float(g)})
    elif mode == "ism":
        fl = sorted({round(float(x), 3) for x in (freqs or cfg["ism_freqs"])})
        g = gain if gain is not None else cfg["ism_gain"]
        cmd = ["rtl_433", "-d", "0", "-g", str(g), "-F", "json", "-M", "time:unix", "-M", "level"]
        for x in fl:
            cmd += ["-f", f"{x}M"]
        if len(fl) > 1:
            cmd += ["-H", str(int(cfg.get("ism_hop_s", 60)))]
        await sdr.start_lines("ism", cmd, decoders.ism_line, {"freqs": fl, "gain": g}, decoders.log["ism"], "rtl_433")
        store.save_config({"ism_freqs": fl, "ism_gain": float(g)})
    elif mode == "aprs":
        f = float(freq if freq is not None else cfg["aprs_freq_mhz"])
        g = gain if gain is not None else cfg["aprs_gain"]
        # NBFM a 22,05 kHz → multimon-ng AFSK1200; -A imprime cada pacote como "APRS: CALL>DEST,PATH:..."
        cmd = f"rtl_fm -f {f}M -M fm -s 22050 -g {float(g)} -E dc - | multimon-ng -t raw -a AFSK1200 -A -"
        await sdr.start_lines("aprs", f"stdbuf -oL sh -c '{cmd}'", decoders.aprs_line,
                              {"freq_mhz": f, "gain": g}, decoders.log["aprs"], "rtl_fm|multimon-ng")
        store.save_config({"aprs_freq_mhz": f, "aprs_gain": float(g)})
    elif mode == "sonde":
        g = gain if gain is not None else cfg["sonde_gain"]
        rx = store.receiver()
        if rx is None:
            return False, "defina a localização da estação em Config antes de procurar sondas"
        err = await sdr.start_sonde(rx[0], rx[1], float(g),
                                    float(cfg["sonde_min_mhz"]), float(cfg["sonde_max_mhz"]))
        if not err:
            store.save_config({"sonde_gain": float(g)})
    elif mode == "sat":
        from . import sats  # import tardio: sats importa modes
        err = await sats.start_capture((extra or {}).get("sat") or "", (extra or {}).get("duration"), gain)
    elif mode == "spectrum":
        # scan é endpoint separado; aqui só libera o dongle
        await sdr.start_idle()
        sdr.state.mode = "spectrum"
    if err:
        return False, err
    if mode in ("ais", "ism", "aprs", "sonde"):
        obs.start_session(mode)
    if mode in _PERSIST and (not origin.startswith("agenda") or origin == "agenda: fim"):
        _remember(mode, freq, gain, freqs)
    flightlog.log_event("mode", mode + _detail(mode, sdr.state.params) + (f" ({origin})" if origin else ""))
    return True, ""
