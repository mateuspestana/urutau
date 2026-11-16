# Autor: Matheus C. Pestana
"""Gravação de áudio no servidor: PCM s16le das filas do WebSocket → WAV em /data/rec/.

O cabeçalho WAV é fechado ao parar (tamanho final). Limite `rec_max_gb` apaga as mais antigas.
"""
from __future__ import annotations

import asyncio
import struct
import time
import wave
from pathlib import Path
from typing import Any

from . import sdr, store

REC_DIR = store.DATA / "rec"

_task: asyncio.Task | None = None
_file: Any = None
_path: Path | None = None
_queue: asyncio.Queue | None = None
_started_at: float = 0.0
_label: str = ""


def _ensure_dir() -> Path:
    REC_DIR.mkdir(parents=True, exist_ok=True)
    return REC_DIR


def _sample_rate() -> int:
    try:
        return int(sdr.state.params.get("sample_rate") or 48000)
    except (TypeError, ValueError):
        return 48000


def _open_wav(path: Path, rate: int) -> wave.Wave_write:
    w = wave.open(str(path), "wb")
    w.setnchannels(1)
    w.setsampwidth(2)  # s16le
    w.setframerate(rate)
    return w


def enforce_quota(max_gb: float | None = None) -> list[str]:
    """Apaga as gravações mais antigas até caber em `rec_max_gb`. Devolve nomes removidos."""
    _ensure_dir()
    if max_gb is None:
        max_gb = float(store.load_config().get("rec_max_gb") or 2.0)
    limit = max(0.0, float(max_gb)) * (1024 ** 3)
    files = sorted(
        (p for p in REC_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".wav"),
        key=lambda p: p.stat().st_mtime,
    )
    total = sum(p.stat().st_size for p in files)
    removed: list[str] = []
    while total > limit and files:
        victim = files.pop(0)
        # não apaga a gravação em curso
        if _path and victim.resolve() == _path.resolve():
            continue
        try:
            sz = victim.stat().st_size
            victim.unlink()
            total -= sz
            removed.append(victim.name)
        except OSError:
            break
    return removed


def list_recordings() -> list[dict[str, Any]]:
    _ensure_dir()
    out: list[dict[str, Any]] = []
    for p in sorted(REC_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file() or p.suffix.lower() != ".wav":
            continue
        st = p.stat()
        meta: dict[str, Any] = {"name": p.name, "bytes": st.st_size, "mtime": st.st_mtime}
        try:
            with wave.open(str(p), "rb") as w:
                meta["sample_rate"] = w.getframerate()
                meta["channels"] = w.getnchannels()
                meta["duration_s"] = round(w.getnframes() / max(1, w.getframerate()), 2)
        except (OSError, wave.Error):
            pass
        if _path and p.resolve() == _path.resolve():
            meta["recording"] = True
            meta["label"] = _label
        out.append(meta)
    return out


def safe_path(name: str) -> Path | None:
    """Só nomes simples dentro de REC_DIR (bloqueia `..`)."""
    if not name or "/" in name or "\\" in name or name.startswith(".") or ".." in name:
        return None
    if not name.lower().endswith(".wav"):
        return None
    try:
        base = REC_DIR.resolve()
        p = (REC_DIR / name).resolve()
    except OSError:
        return None
    if p.parent != base or not p.is_file():
        return None
    return p


def delete(name: str) -> tuple[bool, str]:
    p = safe_path(name)
    if not p:
        return False, "caminho inválido"
    if _path and p.resolve() == _path.resolve():
        return False, "gravação em curso"
    try:
        p.unlink()
    except OSError as e:
        return False, str(e)
    return True, ""


def status() -> dict[str, Any]:
    return {
        "recording": _file is not None,
        "name": _path.name if _path else None,
        "label": _label or None,
        "started_at": _started_at or None,
        "sample_rate": _sample_rate() if _file else None,
    }


async def _pump() -> None:
    global _file, _path, _queue
    assert _queue is not None and _file is not None
    try:
        while True:
            chunk = await _queue.get()
            if chunk is None:  # sentinela de parada
                break
            try:
                _file.writeframes(chunk)
            except Exception:
                break
    finally:
        try:
            if _file is not None:
                _file.close()
        except Exception:
            pass
        _file = None
        if _queue is not None:
            sdr.state.audio_queues.discard(_queue)
        _queue = None
        # aplica cota depois de fechar (tamanho final conhecido)
        try:
            enforce_quota()
        except Exception:
            pass


async def start(label: str = "") -> str:
    """Começa a gravar o áudio atual. Devolve o nome do arquivo ou mensagem de erro."""
    global _task, _file, _path, _queue, _started_at, _label
    if _file is not None:
        return _path.name if _path else ""
    if sdr.state.mode not in ("fm", "airband"):
        return "só grava em fm/airband"
    _ensure_dir()
    enforce_quota()
    rate = _sample_rate()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in (label or sdr.state.mode))[:40]
    name = f"{stamp}_{safe_label or sdr.state.mode}.wav"
    path = REC_DIR / name
    _file = _open_wav(path, rate)
    _path = path
    _label = label or sdr.state.mode
    _started_at = time.time()
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    _queue = q
    sdr.state.audio_queues.add(q)
    _task = asyncio.create_task(_pump())
    return name


async def stop() -> str | None:
    """Fecha o WAV e devolve o nome, ou None se não havia gravação."""
    global _task, _file, _path, _queue, _started_at, _label
    if _queue is None and _file is None:
        return None
    name = _path.name if _path else None
    q = _queue
    if q is not None:
        try:
            q.put_nowait(None)
        except asyncio.QueueFull:
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
    if _task is not None:
        try:
            await asyncio.wait_for(_task, timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            _task.cancel()
            try:
                if _file is not None:
                    _file.close()
            except Exception:
                pass
            _file = None
            if _queue is not None:
                sdr.state.audio_queues.discard(_queue)
            _queue = None
    _task = None
    _path = None
    _started_at = 0.0
    _label = ""
    return name


def write_pcm_file(path: Path, pcm: bytes, sample_rate: int = 48000) -> Path:
    """Helper de teste: grava PCM s16le num WAV com cabeçalho válido."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _open_wav(path, sample_rate) as w:
        w.writeframes(pcm)
    return path


def silence_pcm(seconds: float, sample_rate: int = 48000) -> bytes:
    n = int(seconds * sample_rate)
    return struct.pack(f"<{n}h", *([0] * n))
