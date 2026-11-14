# Autor: Matheus C. Pestana
"""Controle do dongle: modos, processos rtl_* e decodificadores, containers ultrafeeder e radiosonde.

Toda troca de modo: `stop_proc()` (mata o grupo de processos e para a sonda) → `drain_audio()` →
ultrafeeder ligado/desligado → inicia o novo modo. Os processos nascem em sessão própria
(`start_new_session`), então um pipeline em shell (`rtl_fm | multimon-ng`) morre inteiro.
"""
from __future__ import annotations

import asyncio
import os
import re
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import docker
import httpx

from . import datalink, decoders

MODES = ("idle", "adsb", "fm", "airband", "spectrum", "acars", "vdl2", "ais", "ism", "aprs", "sonde", "sat")
DATALINK = ("acars", "vdl2")
# modos em que a API (ou a sonda) segura o USB: o ultrafeeder tem de ficar parado
HOLDS_DONGLE = ("fm", "airband", "spectrum", "acars", "vdl2", "ais", "ism", "aprs", "sonde", "sat")

SONDE_IMAGE = "ghcr.io/projecthorus/radiosonde_auto_rx:latest"
SONDE_NAME = os.environ.get("SONDE_CONTAINER", "urutau-radiosonde")
UF_NAME = os.environ.get("ULTRAFEEDER_CONTAINER", "urutau-ultrafeeder")
BIND = os.environ.get("URUTAU_BIND", "127.0.0.1")  # interface onde a UI do auto_rx (:5000) é publicada


@dataclass
class Runtime:
    mode: str = "idle"
    proc: asyncio.subprocess.Process | None = None  # processo principal (o que "segura" o modo)
    procs: list = field(default_factory=list)  # todos, para matar juntos
    # uma fila por ouvinte do WebSocket: o áudio é replicado (antes, uma fila só dividia os pedaços entre eles)
    audio_queues: set = field(default_factory=set)
    spectrum: list[dict[str, float]] = field(default_factory=list)
    spectrum_meta: dict[str, Any] = field(default_factory=dict)
    last_error: str = ""
    started_at: float = 0.0
    params: dict[str, Any] = field(default_factory=dict)


state = Runtime()


def _docker() -> docker.DockerClient:
    return docker.from_env()


def ultrafeeder_status() -> dict[str, Any]:
    try:
        c = _docker().containers.get(UF_NAME)
        return {"running": c.status == "running", "status": c.status}
    except Exception as e:
        return {"running": False, "status": "missing", "error": str(e)}


async def set_ultrafeeder(running: bool) -> None:
    try:
        c = _docker().containers.get(UF_NAME)
    except Exception as e:
        state.last_error = f"docker: {e}"
        return
    if running:
        if c.status != "running":
            await asyncio.to_thread(c.start)
            # espera API JSON
            for _ in range(30):
                try:
                    async with httpx.AsyncClient(timeout=2.0) as client:
                        r = await client.get("http://ultrafeeder/data/aircraft.json")
                        if r.status_code == 200:
                            break
                except Exception:
                    pass
                await asyncio.sleep(1)
    else:
        if c.status == "running":
            await asyncio.to_thread(c.stop, timeout=20)


# ---------- processos ----------

async def _spawn(*argv: str, stdin: Any = None, shell: bool = False) -> asyncio.subprocess.Process:
    kw: dict[str, Any] = dict(stdin=stdin, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                              start_new_session=True, limit=1 << 20)
    if shell:
        proc = await asyncio.create_subprocess_shell(argv[0], **kw)
    else:
        proc = await asyncio.create_subprocess_exec(*argv, **kw)
    state.procs.append(proc)
    return proc


async def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


async def stop_proc() -> None:
    if state.mode in DATALINK:
        datalink.reset_live(None)
    if state.mode == "sonde":
        await stop_sonde()
    procs, state.procs, state.proc = state.procs, [], None
    await asyncio.gather(*(_kill(p) for p in procs))


async def drain_audio() -> None:
    for q in list(state.audio_queues):
        while not q.empty():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                break


def _fanout_audio(chunk: bytes) -> None:
    for q in list(state.audio_queues):
        if q.full():  # ouvinte lento: descarta o pedaço mais antigo, nunca trava o rtl_fm
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(chunk)
        except asyncio.QueueFull:
            pass


async def _pump_audio(proc: asyncio.subprocess.Process) -> None:
    assert proc.stdout
    while True:
        chunk = await proc.stdout.read(4096)
        if not chunk:
            break
        _fanout_audio(chunk)


async def _pump_log(proc: asyncio.subprocess.Process, sink: Any) -> None:
    """stderr → deque da UI. Também guarda o fim do texto para o caso de o processo morrer."""
    if not proc.stderr:
        return
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
        text = re.sub(r"\x1b\[[0-9;]*m", "", line.decode(errors="replace")).strip()  # SatDump colore o log
        if text and "noninteger number of samples" not in text:  # aviso inofensivo do multimon-ng
            sink.append(text[:300])


async def _watch_exit(proc: asyncio.subprocess.Process, label: str, sink: Any, ok_exit: bool = False) -> None:
    """Se o processo principal morre sozinho (não por troca de modo), o modo vira idle com o erro.
    `ok_exit`: sair com código 0 é o fim normal (captura de satélite com --timeout)."""
    await proc.wait()
    if state.proc is proc and ok_exit and proc.returncode == 0:
        await stop_proc()
        state.mode = "idle"
        state.params = {}
        sink.append(f"api: {label} terminou normalmente")
        return
    if state.proc is proc:
        tail = " | ".join(list(sink)[-4:])
        await stop_proc()
        state.mode = "idle"
        state.params = {}
        state.last_error = f"{label} terminou (código {proc.returncode}): {tail}"[:500]


def _begin(mode: str, params: dict[str, Any]) -> None:
    state.mode = mode
    state.started_at = time.time()
    state.params = params
    state.last_error = ""


async def _release_for(mode: str) -> None:
    await stop_proc()
    await drain_audio()
    await set_ultrafeeder(False)


# ---------- FM / airband ----------

async def start_fm(freq_mhz: float, gain: float, am: bool = False) -> None:
    await _release_for("airband" if am else "fm")
    decoders.reset_rds()
    if am:
        # airband AM → 12 kHz
        proc = await _spawn("rtl_fm", "-f", f"{freq_mhz}M", "-M", "am", "-s", "12k", "-g", str(gain), "-")
        state.proc = proc
        _begin("airband", {"freq_mhz": freq_mhz, "gain": gain, "sample_rate": 12000, "am": True})
        asyncio.create_task(_pump_audio(proc))
        asyncio.create_task(_pump_log(proc, decoders.log["rds"]))
        asyncio.create_task(_watch_exit(proc, "rtl_fm", decoders.log["rds"]))
        return

    # WBFM: o rtl_fm entrega o MPX cru a 171 kHz (com piloto e subportadora RDS em 57 kHz).
    # A API divide: redsea decodifica o RDS; o sox filtra 15 kHz, aplica de-ênfase de 75 µs
    # (padrão das Américas; polo único em 2122 Hz) e reamostra para 48 kHz de áudio.
    rtl = await _spawn("rtl_fm", "-M", "fm", "-l", "0", "-A", "std", "-p", "0", "-s", "171k",
                       "-g", str(gain), "-F", "9", "-f", f"{freq_mhz}M", "-")
    sox = await _spawn("sox", "-t", "raw", "-r", "171000", "-e", "signed", "-b", "16", "-c", "1", "-",
                       "-t", "raw", "-r", "48000", "-e", "signed", "-b", "16", "-c", "1", "-",
                       "lowpass", "15000", "lowpass", "-1", "2122", "vol", "2", stdin=asyncio.subprocess.PIPE)
    rds = await _spawn("redsea", "-r", "171000", "--show-partial", stdin=asyncio.subprocess.PIPE)
    state.proc = rtl
    _begin("fm", {"freq_mhz": freq_mhz, "gain": gain, "sample_rate": 48000, "am": False, "rds": True})

    async def split() -> None:
        assert rtl.stdout
        while True:
            chunk = await rtl.stdout.read(8192)
            if not chunk:
                break
            for p in (sox, rds):
                if p.stdin and not p.stdin.is_closing():
                    try:
                        p.stdin.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            try:
                await asyncio.wait_for(sox.stdin.drain(), timeout=2) if sox.stdin else None
            except Exception:
                pass
            # o redsea nunca pode segurar o áudio: se ele atrasar, os bytes ficam no buffer dele
        for p in (sox, rds):
            if p.stdin:
                p.stdin.close()

    async def rds_lines() -> None:
        assert rds.stdout
        while True:
            line = await rds.stdout.readline()
            if not line:
                break
            decoders.rds_line(line.decode(errors="replace"))

    asyncio.create_task(split())
    asyncio.create_task(_pump_audio(sox))
    asyncio.create_task(rds_lines())
    for p, sink in ((rtl, decoders.log["rds"]), (sox, decoders.log["rds"]), (rds, decoders.log["rds"])):
        asyncio.create_task(_pump_log(p, sink))
    asyncio.create_task(_watch_exit(rtl, "rtl_fm", decoders.log["rds"]))


# ---------- decodificadores de linha (um JSON/linha por mensagem) ----------

async def start_lines(mode: str, cmd: list[str] | str, on_line: Callable[[str], Any], params: dict[str, Any],
                      sink: Any, label: str, ok_exit: bool = False) -> None:
    """Roda `cmd` (lista = exec; str = shell, para pipelines) e entrega cada linha do stdout a `on_line`
    numa thread (o SQLite não pode travar o loop). stdbuf: sem TTY o stdout iria em blocos de 4 KB."""
    await _release_for(mode)
    sink.clear()
    if isinstance(cmd, str):
        proc = await _spawn(cmd, shell=True)
    else:
        proc = await _spawn("stdbuf", "-oL", "-eL", *cmd)
    state.proc = proc
    _begin(mode, params)

    async def pump() -> None:
        assert proc.stdout
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                await asyncio.to_thread(on_line, line.decode(errors="replace"))
            except Exception as e:  # nunca derruba a leitura por causa de uma linha
                sink.append(f"api: {e}")

    asyncio.create_task(pump())
    asyncio.create_task(_pump_log(proc, sink))
    asyncio.create_task(_watch_exit(proc, label, sink, ok_exit))


async def start_datalink(source: str, freqs: list[float], gain: float) -> str:
    """ACARS (acarsdec) ou VDL2 (dumpvdl2): uma linha JSON por mensagem no stdout → SQLite.
    Devolve "" ou a mensagem de erro (frequências que não cabem na janela do dongle)."""
    freqs = sorted({round(float(f), 3) for f in freqs})
    err = datalink.check_freqs(source, freqs)
    if err:
        return err
    if source == "acars":
        cmd = ["acarsdec", "-o", "4", "-g", str(gain), "-r", "0", *[f"{f:.3f}" for f in freqs]]
    else:
        cmd = ["dumpvdl2", "--output", "decoded:json:file:path=-", "--rtlsdr", "0", "--gain", str(gain),
               *[f"{f:.3f}M" for f in freqs]]

    def on_line(line: str) -> None:
        datalink.ingest_line(source, line)

    await start_lines(source, cmd, on_line, {"freqs": freqs, "gain": gain}, datalink.decoder_log,
                      cmd[0])
    datalink.reset_live(source)
    return ""


# ---------- radiossondas (container radiosonde_auto_rx) ----------

def _self_container() -> Any:
    return _docker().containers.get(os.environ.get("HOSTNAME", "urutau-api"))


def sonde_status() -> dict[str, Any]:
    try:
        c = _docker().containers.get(SONDE_NAME)
        return {"running": c.status == "running", "status": c.status}
    except Exception:
        return {"running": False, "status": "ausente"}


async def start_sonde(lat: float, lon: float, gain: float, min_mhz: float, max_mhz: float) -> str:
    await _release_for("sonde")
    decoders.log["sonde"].clear()

    def run() -> str:
        cli = _docker()
        try:
            cli.containers.get(SONDE_NAME).remove(force=True)
        except Exception:
            pass
        me = _self_container()
        net = next(iter(me.attrs["NetworkSettings"]["Networks"]))
        api_host = me.attrs["Config"]["Hostname"]
        try:
            api_host = me.name
        except Exception:
            pass
        # a config do auto_rx é gerada a partir do exemplo da própria imagem.
        # SondeHub (upload público da posição da estação) fica DESLIGADO: nada sai desta máquina.
        sets = {
            "station_lat": lat, "station_lon": lon, "station_alt": 20,
            "sondehub_enabled": "False", "uploader_callsign": "LOCAL",
            "min_freq": min_mhz, "max_freq": max_mhz, "gain": gain,
            "payload_summary_enabled": "True", "payload_summary_host": api_host,
            "payload_summary_port": 55673, "web_control": "False",
        }
        sed = " ".join(f"-e 's|^{k} = .*|{k} = {v}|'" for k, v in sets.items())
        script = f"cp station.cfg.example station.cfg && sed -i {sed} station.cfg && exec python3 auto_rx.py"
        cli.containers.run(
            SONDE_IMAGE,
            name=SONDE_NAME,
            entrypoint=["/usr/bin/tini", "--", "sh", "-c", script],
            working_dir="/opt/auto_rx",
            detach=True,
            network=net,
            ports={"5000/tcp": (BIND, 5000)},
            volumes={"/dev/bus/usb": {"bind": "/dev/bus/usb", "mode": "rw"}},
            device_cgroup_rules=["c 189:* rwm"],
            labels={"urutau": "radiosonde"},
        )
        return ""

    try:
        err = await asyncio.to_thread(run)
    except Exception as e:
        err = f"radiosonde: {e}"
    if err:
        state.mode = "idle"
        state.last_error = err
        return err
    _begin("sonde", {"min_mhz": min_mhz, "max_mhz": max_mhz, "gain": gain})
    return ""


async def stop_sonde() -> None:
    def run() -> None:
        try:
            c = _docker().containers.get(SONDE_NAME)
        except Exception:
            return
        try:
            tail = c.logs(tail=30).decode(errors="replace").splitlines()
            decoders.log["sonde"].extend(t[:300] for t in tail)
        except Exception:
            pass
        c.remove(force=True)

    await asyncio.to_thread(run)


def sonde_logs(n: int = 30) -> list[str]:
    try:
        c = _docker().containers.get(SONDE_NAME)
        return [t[:300] for t in c.logs(tail=n).decode(errors="replace").splitlines()]
    except Exception:
        return list(decoders.log["sonde"])


# ---------- ADS-B / idle / espectro ----------

async def start_adsb() -> None:
    await stop_proc()
    await drain_audio()
    await set_ultrafeeder(True)
    _begin("adsb", {})


async def start_idle() -> None:
    await stop_proc()
    await drain_audio()
    await set_ultrafeeder(False)
    _begin("idle", {})


async def run_spectrum(start_mhz: float, end_mhz: float, bin_khz: float, gain: float, seconds: int = 12) -> list[dict[str, float]]:
    await stop_proc()
    await set_ultrafeeder(False)
    # limpa os parâmetros do modo anterior (senão o status seguia mostrando a freq. do FM/airband)
    _begin("spectrum", {"start_mhz": start_mhz, "end_mhz": end_mhz})
    out = f"/tmp/spectrum_{int(time.time())}.csv"
    bin_hz = int(bin_khz * 1000)
    proc = await asyncio.create_subprocess_exec(
        "rtl_power", "-f", f"{start_mhz}M:{end_mhz}M:{bin_hz}", "-g", str(gain), "-i", "1", "-e", f"{seconds}s", out,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    state.proc = proc
    state.procs = [proc]
    stderr = await proc.stderr.read() if proc.stderr else b""
    await proc.wait()
    state.proc = None
    state.procs = []
    if proc.returncode not in (0, -15) and not os.path.exists(out):
        state.last_error = stderr.decode(errors="replace")[-400:]
        state.mode = "idle"
        return []

    points: dict[float, list[float]] = {}
    with open(out) as f:
        for line in f:
            parts = line.strip().split(",")
            if len(parts) < 7:
                continue
            try:
                low = float(parts[2])
                step = float(parts[4])
                for i, v in enumerate(parts[6:]):
                    hz = low + i * step
                    points.setdefault(hz, []).append(float(v))
            except ValueError:
                continue
    try:
        os.remove(out)
    except OSError:
        pass
    series = [
        {"hz": hz, "mhz": hz / 1e6, "db": sum(vals) / len(vals)}
        for hz, vals in sorted(points.items())
    ]
    state.spectrum = series
    state.spectrum_meta = {
        "start_mhz": start_mhz,
        "end_mhz": end_mhz,
        "bin_khz": bin_khz,
        "gain": gain,
        "seconds": seconds,
        "points": len(series),
        "ts": time.time(),
    }
    state.mode = "idle"
    state.params = {}
    state.last_error = ""
    return series


async def guard_loop() -> None:
    """Enquanto a API (ou a sonda) segura o dongle, o ultrafeeder tem de ficar parado.
    Um `docker compose up` de qualquer serviço o religa pela cadeia de depends_on, e aí o readsb
    disputa o USB. Este laço o derruba de novo. Também percebe a sonda morrendo sozinha."""
    while True:
        await asyncio.sleep(5)
        try:
            if state.mode in HOLDS_DONGLE:
                uf = await asyncio.to_thread(ultrafeeder_status)
                if uf.get("running"):
                    datalink.decoder_log.append("api: ultrafeeder religado por fora; parando para liberar o dongle")
                    decoders.log.get(state.mode, decoders.log["rds"]).append(
                        "api: ultrafeeder religado por fora; parando para liberar o dongle")
                    await set_ultrafeeder(False)
            if state.mode == "sonde":
                st = await asyncio.to_thread(sonde_status)
                if not st["running"]:
                    logs = await asyncio.to_thread(sonde_logs, 6)
                    await stop_proc()
                    state.mode = "idle"
                    state.last_error = f"radiosonde parou ({st['status']}): {' | '.join(logs[-4:])}"[:500]
        except Exception:
            pass


def status() -> dict[str, Any]:
    return {
        "mode": state.mode,
        "params": state.params,
        "listeners": len(state.audio_queues),
        "started_at": state.started_at,
        "last_error": state.last_error,
        "ultrafeeder": ultrafeeder_status(),
        "spectrum_meta": state.spectrum_meta,
        "has_spectrum": bool(state.spectrum),
        "dongle_hint": "RTL-SDR V4 via USB (um modo por vez)",
    }
