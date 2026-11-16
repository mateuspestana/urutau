# Autor: Matheus C. Pestana
"""Torre com um dongle só: alterna ADS-B e ACARS.

O ADS-B (1090 MHz) e o ACARS (131 MHz) não cabem juntos na janela de um RTL-SDR. Com o ciclo ligado, a
API fica no ADS-B e, a cada `tower_adsb_s` segundos, se há aeronave com sinal razoável, passa
`tower_acars_s` segundos no ACARS e volta. Só age quando o modo atual é o ADS-B ou o ACARS iniciado por ele
mesmo: troca manual de modo, tarefa da agenda e dois dongles o põem em pausa.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from . import datalink, flightlog, modes, sdr, store

ADS_MIN, ADS_MAX = 60.0, 1800.0
ACARS_MIN, ACARS_MAX = 30.0, 600.0
RSSI_WINDOW_S = 10.0  # "visto" há no máximo isso, para a aeronave contar como presente

state: dict[str, Any] = {
    "phase": None,  # None | "adsb" | "acars" (fase iniciada ou acompanhada pelo ciclo)
    "started": 0.0,
    "cycles": 0,
    "restart_s": None,  # quanto levou para o ADS-B voltar na última vez
    "last_msgs": None,  # mensagens ACARS captadas na última janela
    "last_error": "",
}


@dataclass(frozen=True)
class Settings:
    enabled: bool
    adsb_s: float
    acars_s: float
    min_rssi: float


def settings(cfg: dict[str, Any]) -> Settings:
    def num(key: str, default: float, lo: float, hi: float) -> float:
        try:
            v = float(cfg.get(key, default))
        except (TypeError, ValueError):
            v = default
        return min(max(v, lo), hi)

    return Settings(
        enabled=bool(cfg.get("tower_cycle", False)),
        adsb_s=num("tower_adsb_s", 180.0, ADS_MIN, ADS_MAX),
        acars_s=num("tower_acars_s", 60.0, ACARS_MIN, ACARS_MAX),
        min_rssi=num("tower_min_rssi", -30.0, -50.0, 0.0),
    )


def strong_aircraft(aircraft: list[dict[str, Any]], min_rssi: float) -> int:
    """Quantas aeronaves têm sinal ≥ min_rssi e foram vistas agora há pouco."""
    n = 0
    for a in aircraft:
        try:
            if float(a.get("rssi", -99)) >= min_rssi and float(a.get("seen", 99)) <= RSSI_WINDOW_S:
                n += 1
        except (TypeError, ValueError):
            continue
    return n


def decide(now: float, st: Settings, *, mode: str, phase: str | None, started: float,
           dual: bool, job_active: bool, strong: int) -> tuple[str, str | None, float]:
    """Um passo do ciclo, sem efeitos colaterais.

    Devolve (ação, nova fase, novo início); ação: "noop" | "to_acars" | "to_adsb".
    """
    if dual or not st.enabled:
        # desligado: se o ACARS era dele, devolve o ADS-B; senão não mexe
        if phase == "acars" and mode == "acars":
            return "to_adsb", None, now
        return "noop", None, 0.0
    if job_active:
        return "noop", None, 0.0
    if mode == "acars":
        if phase != "acars":  # ACARS escolhido pela pessoa: o ciclo não interfere
            return "noop", None, 0.0
        if now - started >= st.acars_s:
            return "to_adsb", "adsb", now
        return "noop", "acars", started
    if mode == "adsb":
        if phase != "adsb":  # começou agora (ou a pessoa voltou ao ADS-B): conta a partir de já
            return "noop", "adsb", now
        if now - started >= st.adsb_s and strong > 0:
            return "to_acars", "acars", now
        return "noop", "adsb", started
    return "noop", None, 0.0  # qualquer outro modo: em pausa


def owns_acars() -> bool:
    """O ACARS em curso foi iniciado pelo ciclo? (a agenda pode tomar o dongle de volta)"""
    return state["phase"] == "acars" and sdr.state.mode == "acars"


async def _strong_now(cfg: dict[str, Any], min_rssi: float) -> int:
    base = cfg.get("adsb_url") or "http://ultrafeeder"
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{base}/data/aircraft.json")
            r.raise_for_status()
            return strong_aircraft(r.json().get("aircraft") or [], min_rssi)
    except Exception:
        return 0


async def tick() -> None:
    from . import schedule

    cfg = store.load_config()
    st = settings(cfg)
    now = time.time()
    mode = sdr.state.mode
    phase, started = state["phase"], float(state["started"])
    strong = 0
    if st.enabled and mode == "adsb" and phase == "adsb" and now - started >= st.adsb_s:
        strong = await _strong_now(cfg, st.min_rssi)
    action, new_phase, new_started = decide(
        now, st, mode=mode, phase=phase, started=started, dual=sdr.dual(),
        job_active=bool(schedule.job), strong=strong)
    state["phase"], state["started"] = new_phase, new_started
    if action == "to_acars":
        ok, err = await modes.apply("acars", origin="agenda: torre")
        if not ok:
            state["last_error"] = err
            state["phase"], state["started"] = "adsb", time.time()
            return
        state["last_error"] = ""
        state["cycles"] += 1
    elif action == "to_adsb":
        try:
            msgs = datalink.stats().get("session", {}).get("count")
        except Exception:
            msgs = None
        t0 = time.time()
        await modes.apply("adsb", origin="agenda: fim")
        state["restart_s"] = round(time.time() - t0, 1)
        state["last_msgs"] = msgs
        if new_phase == "adsb":
            state["started"] = time.time()
        flightlog.log_event("torre", f"ciclo: {msgs if msgs is not None else '?'} msgs ACARS; ADS-B voltou em {state['restart_s']} s")


def status() -> dict[str, Any]:
    cfg = store.load_config()
    st = settings(cfg)
    now = time.time()
    phase = state["phase"]
    if not st.enabled:
        run = "off"
    elif sdr.dual():
        run = "dual"
    elif phase in ("adsb", "acars"):
        run = phase
    else:
        run = "pausa"
    left: float | None = None
    if run == "adsb":
        left = max(0.0, st.adsb_s - (now - float(state["started"])))
    elif run == "acars":
        left = max(0.0, st.acars_s - (now - float(state["started"])))
    return {
        "enabled": st.enabled, "run": run, "seconds_left": None if left is None else round(left),
        "adsb_s": st.adsb_s, "acars_s": st.acars_s, "min_rssi": st.min_rssi,
        "cycles": state["cycles"], "restart_s": state["restart_s"], "last_msgs": state["last_msgs"],
        "last_error": state["last_error"], "dual": sdr.dual(),
    }


async def loop() -> None:
    await asyncio.sleep(25)
    while True:
        try:
            await tick()
        except Exception as e:
            state["last_error"] = str(e)
        await asyncio.sleep(5)
