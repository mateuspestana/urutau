# Autor: Matheus C. Pestana
"""Agenda unificada: planeja segmentos (satélite, sonda, entradas do usuário) e decide o que
fazer no dongle. Funções puras `plan`/`decide`; o laço assíncrono aplica via `modes.apply`.

Prioridades (menor número vence): 0 once → 1 satélite → 2 sonda → 3 recorrente → base.
Satélite preempta sonda; ao fim, retoma a sonda se a janela ainda estiver aberta.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any

from . import decoders, modes, sdr, store

SCHEDULE_PATH = store.DATA / "schedule.json"
AGENDA_PATH = store.DATA / "agenda.json"
AGENDA_MAX = 200

# prioridades
PRI_ONCE = 0
PRI_SAT = 1
PRI_SONDE = 2
PRI_RECUR = 3

USER_MODES = ("fm", "airband", "ais", "aprs", "ism", "acars", "vdl2", "sonde")

job: dict[str, Any] = {}  # tarefa automática em curso
# o usuário trocou de modo no meio: não retoma aquele tipo até o fim da janela/passagem
suppressed: dict[str, float] = {}
agenda_log: list[dict[str, Any]] = []


@dataclass
class Segment:
    id: str
    start: float
    end: float
    kind: str  # sat | sonde | once | daily | weekly | audio
    label: str
    priority: int
    mode: str
    ref: str = ""  # chave para skips (passagem, entrada+data, …)
    params: dict[str, Any] = field(default_factory=dict)
    state: str = "planned"  # planned | running | skipped | preempted | done
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Action:
    op: str  # noop | start | end | preempt | suppress
    segment: Segment | None = None
    restore: str | None = None  # modo base a restaurar
    resume: dict[str, Any] | None = None  # job pausado a retomar
    reason: str = ""
    suppress_key: str | None = None
    suppress_until: float | None = None


# ---------- persistência ----------

def _default_file() -> dict[str, Any]:
    return {"entries": [], "skips": []}


def load_schedule() -> dict[str, Any]:
    store.DATA.mkdir(parents=True, exist_ok=True)
    if not SCHEDULE_PATH.exists():
        SCHEDULE_PATH.write_text(json.dumps(_default_file(), indent=2))
    try:
        data = json.loads(SCHEDULE_PATH.read_text())
    except (OSError, ValueError):
        data = _default_file()
    data.setdefault("entries", [])
    data.setdefault("skips", [])
    return data


def save_schedule(data: dict[str, Any]) -> dict[str, Any]:
    store.DATA.mkdir(parents=True, exist_ok=True)
    SCHEDULE_PATH.write_text(json.dumps(data, indent=2))
    return data


def load_agenda_log() -> list[dict[str, Any]]:
    if not AGENDA_PATH.exists():
        return []
    try:
        raw = json.loads(AGENDA_PATH.read_text())
        return list(raw) if isinstance(raw, list) else []
    except (OSError, ValueError):
        return []


def _persist_log() -> None:
    store.DATA.mkdir(parents=True, exist_ok=True)
    AGENDA_PATH.write_text(json.dumps(agenda_log[:AGENDA_MAX], indent=2))


def note(kind: str, detail: str, ts: float | None = None) -> None:
    agenda_log.insert(0, {"ts": ts if ts is not None else time.time(), "kind": kind, "detail": detail})
    del agenda_log[AGENDA_MAX:]
    try:
        _persist_log()
    except OSError:
        pass


def bootstrap_log() -> None:
    """Carrega o log persistido na subida da API."""
    global agenda_log
    agenda_log = load_agenda_log()[:AGENDA_MAX]


# ---------- janelas de sonda ----------

def sonde_window(now: float, cfg: dict[str, Any]) -> float | None:
    """Se `now` cai numa janela de sonda, devolve o fim dela (epoch)."""
    for start, end in _sonde_intervals(now, now + 1, cfg):
        if start <= now < end:
            return end
    return None


def _parse_hhmm(s: str) -> tuple[int, int] | None:
    try:
        a, b = s.split(":")
        return int(a), int(b)
    except ValueError:
        return None


def _sonde_intervals(t0: float, t1: float, cfg: dict[str, Any]) -> list[tuple[float, float]]:
    """Expande as janelas HH:MM-HH:MM para o intervalo [t0, t1]."""
    windows = cfg.get("sonde_windows") or []
    if not windows:
        return []
    out: list[tuple[float, float]] = []
    day0 = datetime.fromtimestamp(t0).replace(hour=0, minute=0, second=0, microsecond=0)
    # um dia a mais no fim para janelas que cruzam meia-noite
    days = int((t1 - day0.timestamp()) // 86400) + 2
    for d in range(-1, days + 1):
        base = day0 + timedelta(days=d)
        for w in windows:
            try:
                a, b = str(w).split("-")
            except ValueError:
                continue
            pa, pb = _parse_hhmm(a.strip()), _parse_hhmm(b.strip())
            if not pa or not pb:
                continue
            start = base.replace(hour=pa[0], minute=pa[1])
            end = base.replace(hour=pb[0], minute=pb[1])
            if end.timestamp() <= start.timestamp():
                end += timedelta(days=1)
            s, e = start.timestamp(), end.timestamp()
            if e > t0 and s < t1:
                out.append((s, e))
    out.sort()
    return out


def _skip_set(skips: list[dict[str, Any]]) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for s in skips or []:
        ref = str(s.get("ref") or "")
        date = str(s.get("date") or "")
        if ref:
            out.add((ref, date))
    return out


def _is_skipped(ref: str, start: float, skips: set[tuple[str, str]]) -> bool:
    date = datetime.fromtimestamp(start).strftime("%Y-%m-%d")
    return (ref, date) in skips or (ref, "") in skips


# ---------- entradas do usuário ----------

def _entry_occurrences(entry: dict[str, Any], t0: float, t1: float) -> list[tuple[float, float]]:
    """Devolve (start, end) das ocorrências da entrada no horizonte."""
    if not entry.get("enabled", True):
        return []
    hh = _parse_hhmm(str(entry.get("start") or "00:00"))
    he = _parse_hhmm(str(entry.get("end") or "00:00"))
    if not hh or not he:
        return []
    repeat = str(entry.get("repeat") or "once")
    out: list[tuple[float, float]] = []

    def span_on(day: datetime) -> tuple[float, float]:
        start = day.replace(hour=hh[0], minute=hh[1], second=0, microsecond=0)
        end = day.replace(hour=he[0], minute=he[1], second=0, microsecond=0)
        if end.timestamp() <= start.timestamp():
            end += timedelta(days=1)
        return start.timestamp(), end.timestamp()

    if repeat == "once":
        date_s = str(entry.get("date") or "")
        try:
            y, m, d = map(int, date_s.split("-"))
            day = datetime(y, m, d)
        except ValueError:
            return []
        s, e = span_on(day)
        if e > t0 and s < t1:
            out.append((s, e))
        return out

    day0 = datetime.fromtimestamp(t0).replace(hour=0, minute=0, second=0, microsecond=0)
    days_n = int((t1 - day0.timestamp()) // 86400) + 2
    want_days = set(int(x) for x in (entry.get("days") or []))
    for i in range(-1, days_n + 1):
        day = day0 + timedelta(days=i)
        if repeat == "weekly" and day.weekday() not in want_days:
            continue
        if repeat == "daily" or repeat == "weekly":
            s, e = span_on(day)
            if e > t0 and s < t1:
                out.append((s, e))
    return out


# ---------- plan / decide ----------

def plan(now: float, cfg: dict[str, Any], entries: list[dict[str, Any]],
         passes: list[dict[str, Any]], skips: list[dict[str, Any]],
         horizon_h: float = 48.0) -> list[Segment]:
    """Monta os segmentos no horizonte. Função pura."""
    t1 = now + horizon_h * 3600
    skip_s = _skip_set(skips)
    segs: list[Segment] = []

    # satélites
    if cfg.get("sat_auto"):
        min_el = float(cfg.get("sat_min_el", 20))
        for p in passes or []:
            if p.get("kind") != "lrpt" or float(p.get("max_el") or 0) < min_el:
                continue
            aos, los = float(p["aos"]), float(p["los"])
            start, end = aos - 20, los + 20
            if end <= now or start >= t1:
                continue
            ref = f"sat:{p.get('sat')}:{int(aos)}"
            name = p.get("name") or p.get("sat") or "satélite"
            label = f"{name} máx {p.get('max_el')}°"
            st = "skipped" if _is_skipped(ref, aos, skip_s) else "planned"
            segs.append(Segment(
                id=ref, start=start, end=end, kind="sat", label=label, priority=PRI_SAT,
                mode="sat", ref=ref, params={"sat": p.get("sat"), "aos": aos, "los": los,
                                             "max_el": p.get("max_el"), "name": name},
                state=st, reason="pulado" if st == "skipped" else "",
            ))

    # radiossondas
    if cfg.get("sonde_auto"):
        for s, e in _sonde_intervals(now, t1, cfg):
            ref = f"sonde:{datetime.fromtimestamp(s).strftime('%Y-%m-%d_%H%M')}"
            st = "skipped" if _is_skipped(ref, s, skip_s) or _is_skipped("sonde", s, skip_s) else "planned"
            segs.append(Segment(
                id=ref, start=s, end=e, kind="sonde", label="janela de radiossonda",
                priority=PRI_SONDE, mode="sonde", ref=ref, params={},
                state=st, reason="pulado" if st == "skipped" else "",
            ))

    # entradas do usuário
    for entry in entries or []:
        if not entry.get("enabled", True):
            continue
        eid = str(entry.get("id") or "")
        repeat = str(entry.get("repeat") or "once")
        kind = str(entry.get("kind") or "mode")
        mode = str(entry.get("mode") or "fm")
        if kind == "audio" and mode not in ("fm", "airband"):
            mode = "fm"
        label = str(entry.get("label") or entry.get("mode") or "agenda")
        pri = PRI_ONCE if repeat == "once" else PRI_RECUR
        seg_kind = "audio" if kind == "audio" else repeat
        for s, e in _entry_occurrences(entry, now, t1):
            ref = f"entry:{eid}:{datetime.fromtimestamp(s).strftime('%Y-%m-%d')}"
            st = "skipped" if _is_skipped(ref, s, skip_s) or _is_skipped(f"entry:{eid}", s, skip_s) else "planned"
            segs.append(Segment(
                id=ref, start=s, end=e, kind=seg_kind, label=label, priority=pri, mode=mode,
                ref=ref, params={
                    "entry_id": eid, "freq": entry.get("freq"), "freqs": entry.get("freqs"),
                    "gain": entry.get("gain"), "kind": kind, "record": kind == "audio",
                },
                state=st, reason="pulado" if st == "skipped" else "",
            ))

    segs.sort(key=lambda x: (x.start, x.priority, x.id))
    return segs


def _active(now: float, segments: list[Segment]) -> list[Segment]:
    return [s for s in segments if s.state != "skipped" and s.start <= now < s.end]


def _best(now: float, segments: list[Segment]) -> Segment | None:
    act = _active(now, segments)
    if not act:
        return None
    act.sort(key=lambda s: (s.priority, s.start, s.id))
    return act[0]


def decide(now: float, current_job: dict[str, Any] | None, segments: list[Segment]) -> Action:
    """Decide a próxima ação. Função pura.

    `current_job` pode trazer `actual_mode` (modo real do SDR) para detectar fim natural
    (`idle`) ou troca manual (outro modo). Sem job, devolve `start` do melhor segmento ativo.
    """
    best = _best(now, segments)
    job = current_job or None

    if job:
        actual = job.get("actual_mode")
        paused = job.get("paused")
        # fim natural: processo saiu sozinho → idle
        if actual == "idle":
            if paused and float(paused.get("until") or 0) > now:
                return Action(op="end", resume=dict(paused), restore=None,
                              reason=f"{job.get('label')}: processo terminou; retomando {paused.get('label')}")
            return Action(op="end", restore=job.get("prev") or "adsb",
                          reason=f"{job.get('label')}: processo terminou")
        # troca manual
        if actual is not None and actual != job.get("mode"):
            return Action(
                op="suppress",
                suppress_key=str(job.get("mode")),
                suppress_until=float(job.get("until") or now),
                reason=f"{job.get('label')}: modo trocado para {actual}",
            )
        # tempo esgotado
        if now >= float(job.get("until") or 0):
            if paused and float(paused.get("until") or 0) > now:
                return Action(op="end", resume=dict(paused), restore=None,
                              reason=f"{job.get('label')}: fim; retomando {paused.get('label')}")
            return Action(op="end", restore=job.get("prev") or "adsb",
                          reason=f"{job.get('label')}: fim")
        # preempção: segmento melhor (prioridade menor) que o job atual
        if best and best.priority < int(job.get("priority", 99)) and best.id != job.get("seg_id"):
            return Action(
                op="preempt", segment=best,
                reason=f"{job.get('label')} pausada para {best.label}",
            )
        return Action(op="noop", reason="em curso")

    if best:
        return Action(op="start", segment=best, reason=f"início: {best.label}")
    return Action(op="noop", reason="livre")


# ---------- CRUD ----------

def list_entries() -> list[dict[str, Any]]:
    return list(load_schedule()["entries"])


def get_entry(entry_id: str) -> dict[str, Any] | None:
    for e in load_schedule()["entries"]:
        if e.get("id") == entry_id:
            return e
    return None


def add_entry(payload: dict[str, Any]) -> dict[str, Any]:
    data = load_schedule()
    item = {
        "id": str(payload.get("id") or uuid.uuid4()),
        "label": payload.get("label") or "",
        "kind": payload.get("kind") or "mode",
        "mode": payload.get("mode") or "fm",
        "freq": payload.get("freq"),
        "freqs": payload.get("freqs"),
        "gain": payload.get("gain"),
        "repeat": payload.get("repeat") or "once",
        "days": list(payload.get("days") or []),
        "date": payload.get("date") or "",
        "start": payload.get("start") or "00:00",
        "end": payload.get("end") or "00:30",
        "enabled": bool(payload.get("enabled", True)),
    }
    if item["mode"] not in USER_MODES:
        item["mode"] = "fm"
    if item["kind"] not in ("mode", "audio"):
        item["kind"] = "mode"
    if item["repeat"] not in ("once", "daily", "weekly"):
        item["repeat"] = "once"
    data["entries"].append(item)
    save_schedule(data)
    return item


def update_entry(entry_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    data = load_schedule()
    for i, e in enumerate(data["entries"]):
        if e.get("id") != entry_id:
            continue
        for k in ("label", "kind", "mode", "freq", "freqs", "gain", "repeat", "days",
                  "date", "start", "end", "enabled"):
            if k in patch and patch[k] is not None:
                e[k] = patch[k]
        data["entries"][i] = e
        save_schedule(data)
        return e
    return None


def delete_entry(entry_id: str) -> bool:
    data = load_schedule()
    nxt = [e for e in data["entries"] if e.get("id") != entry_id]
    if len(nxt) == len(data["entries"]):
        return False
    data["entries"] = nxt
    save_schedule(data)
    return True


def add_skip(ref: str, date: str = "") -> dict[str, Any]:
    data = load_schedule()
    item = {"ref": ref, "date": date}
    # evita duplicata
    for s in data["skips"]:
        if s.get("ref") == ref and s.get("date") == date:
            return s
    data["skips"].append(item)
    save_schedule(data)
    return item


def list_skips() -> list[dict[str, Any]]:
    return list(load_schedule()["skips"])


# ---------- runtime ----------

def _job_from_segment(seg: Segment, prev: str, paused: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "mode": seg.mode,
        "until": seg.end,
        "prev": prev,
        "label": seg.label,
        "priority": seg.priority,
        "seg_id": seg.id,
        "kind": seg.kind,
        "params": dict(seg.params),
        "paused": paused,
    }


async def _start_segment(seg: Segment, prev: str, paused: dict[str, Any] | None = None) -> bool:
    extra: dict[str, Any] = {}
    freq = seg.params.get("freq")
    freqs = seg.params.get("freqs")
    gain = seg.params.get("gain")
    if seg.mode == "sat":
        los = float(seg.params.get("los") or seg.end)
        now = time.time()
        dur = int(max(60, los - now + 20))
        extra = {"sat": seg.params.get("sat"), "duration": dur}
        until = now + dur + 15
    else:
        until = seg.end

    ok, err = await modes.apply(
        seg.mode,
        float(freq) if freq is not None else None,
        float(gain) if gain is not None else None,
        list(freqs) if freqs else None,
        extra or None,
        origin="agenda",
    )
    if not ok:
        note("erro", err or f"falha ao iniciar {seg.label}")
        return False
    j = _job_from_segment(seg, prev, paused)
    j["until"] = until
    job.clear()
    job.update(j)
    note("início", seg.label)
    if seg.params.get("record") and seg.mode in ("fm", "airband"):
        from . import rec
        try:
            await rec.start(label=seg.label)
        except Exception as e:
            note("erro", f"gravação: {e}")
    return True


async def _stop_recording() -> None:
    from . import rec
    try:
        await rec.stop()
    except Exception:
        pass


async def _restore(prev: str) -> None:
    await _stop_recording()
    job.clear()
    if sdr.state.mode in ("sat", "sonde", "idle") or sdr.state.mode in USER_MODES:
        # devolve o modo base (ADS-B etc.); se já for o prev, só limpa
        if sdr.state.mode != prev:
            await modes.apply(prev, origin="agenda: fim")


async def _apply_action(action: Action, mode: str) -> None:
    if action.op == "noop":
        return
    if action.op == "suppress":
        await _stop_recording()
        if action.suppress_key:
            suppressed[action.suppress_key] = float(action.suppress_until or time.time())
        note("fim", action.reason)
        job.clear()
        return
    if action.op == "end":
        await _stop_recording()
        note("fim", action.reason)
        if action.resume:
            # retoma a tarefa preemptada
            paused = dict(action.resume)
            paused.pop("paused", None)
            paused.pop("actual_mode", None)
            # limpa job antes de aplicar
            job.clear()
            seg = Segment(
                id=str(paused.get("seg_id") or "resume"),
                start=time.time(),
                end=float(paused.get("until") or time.time()),
                kind=str(paused.get("kind") or paused.get("mode") or "sonde"),
                label=str(paused.get("label") or "retomada"),
                priority=int(paused.get("priority", PRI_SONDE)),
                mode=str(paused.get("mode") or "sonde"),
                ref=str(paused.get("seg_id") or ""),
                params=dict(paused.get("params") or {}),
            )
            prev = str(paused.get("prev") or action.restore or "adsb")
            note("retomada", f"{seg.label} retomada")
            await _start_segment(seg, prev, paused=None)
            return
        prev = action.restore or "adsb"
        await _restore(prev)
        return
    if action.op == "preempt" and action.segment:
        await _stop_recording()
        paused = {k: v for k, v in job.items() if k != "actual_mode"}
        note("preempt", action.reason)
        prev = str(job.get("prev") or mode or "adsb")
        await _start_segment(action.segment, prev, paused=paused)
        return
    if action.op == "start" and action.segment:
        # só assume o dongle em adsb/idle (nunca interrompe escuta manual)
        if mode not in ("adsb", "idle"):
            return
        # respeita suppressed
        key = action.segment.mode
        if time.time() < float(suppressed.get(key, 0)):
            return
        # sat/sonde também checam chave genérica
        if action.segment.kind == "sat" and time.time() < float(suppressed.get("sat", 0)):
            return
        if action.segment.kind == "sonde" and time.time() < float(suppressed.get("sonde", 0)):
            return
        await _start_segment(action.segment, mode, paused=None)


async def tick() -> None:
    """Um passo da agenda: planeja, decide e aplica."""
    cfg = store.load_config()
    now = time.time()
    mode = sdr.state.mode
    data = load_schedule()

    # limpa suppressed vencidos
    for k, until in list(suppressed.items()):
        if now >= until:
            suppressed.pop(k, None)

    from . import sats
    try:
        passes = await sats.passes() if cfg.get("sat_auto") else []
    except Exception as e:
        passes = []
        decoders.log["sat"].append(f"agenda: passagens {e}")

    segments = plan(now, cfg, data["entries"], passes, data["skips"], horizon_h=48.0)

    cur = dict(job) if job else None
    if cur is not None:
        cur["actual_mode"] = mode
    action = decide(now, cur, segments)
    await _apply_action(action, mode)


async def _tick() -> None:
    """Alias compatível com o antigo sats._tick."""
    await tick()


async def scheduler_loop() -> None:
    bootstrap_log()
    await asyncio.sleep(20)
    while True:
        try:
            await tick()
        except Exception as e:
            decoders.log["sat"].append(f"agenda: {e}")
            note("erro", str(e))
        await asyncio.sleep(15)


def timeline(hours: float = 48.0, now: float | None = None,
             passes: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Segmentos para a UI, com estado running/done/preempted quando possível."""
    cfg = store.load_config()
    data = load_schedule()
    t = now if now is not None else time.time()
    segs = plan(t, cfg, data["entries"], passes or [], data["skips"], horizon_h=hours)
    out: list[dict[str, Any]] = []
    running_id = job.get("seg_id") if job else None
    paused_id = (job.get("paused") or {}).get("seg_id") if job else None
    for s in segs:
        d = s.to_dict()
        if s.state == "skipped":
            pass
        elif running_id and s.id == running_id:
            d["state"] = "running"
        elif paused_id and s.id == paused_id:
            d["state"] = "preempted"
            d["reason"] = d.get("reason") or "preemptado"
        elif s.end <= t:
            d["state"] = "done"
        out.append(d)
    return out


def agenda_status() -> dict[str, Any]:
    cfg = store.load_config()
    return {
        "job": dict(job),
        "log": list(agenda_log),
        "sat_auto": bool(cfg.get("sat_auto")),
        "sonde_auto": bool(cfg.get("sonde_auto")),
        "sat_min_el": cfg.get("sat_min_el", 20),
        "sonde_windows": cfg.get("sonde_windows", []),
    }


def on_manual_mode_change(new_mode: str) -> None:
    """Chamado pelo POST /api/mode quando a pessoa assume o dongle."""
    if job and new_mode != job.get("mode"):
        suppressed[str(job["mode"])] = float(job.get("until") or time.time())
        note("fim", f"{job.get('label')}: modo trocado para {new_mode}")
        # se havia gravação, o apply seguinte para o processo; rec para no stop
        job.clear()
