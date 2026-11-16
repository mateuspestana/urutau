# Autor: Matheus C. Pestana
"""Agenda unificada: plan/decide com relógio simulado e o caso real sonda+Meteor."""
from __future__ import annotations

import asyncio
from datetime import datetime

from app import schedule, sdr
from app.schedule import PRI_ONCE, PRI_RECUR, PRI_SAT, PRI_SONDE, Action, Segment, decide, plan


def _ts(h: int, m: int = 0, day: int = 16) -> float:
    """Epoch local em 2026-11-{day} HH:MM (sem fuso: datetime naive = local do teste)."""
    return datetime(2026, 11, day, h, m, 0).timestamp()


CFG = {
    "sat_auto": True,
    "sonde_auto": True,
    "sat_min_el": 15.0,
    "sonde_windows": ["20:00-22:30"],
}


def _pass(aos: float, los: float, max_el: float = 65.0) -> dict:
    return {
        "sat": "meteor-m2-3", "name": "Meteor-M2 3", "kind": "lrpt",
        "aos": aos, "los": los, "tca": (aos + los) / 2, "max_el": max_el,
        "aos_az": 10, "los_az": 200, "freq": 137.9,
    }


def test_plan_caso_real_sonda_e_passagem():
    # janela 20:00–22:30 + passagem 20:54–21:07
    now = _ts(19, 0)
    aos, los = _ts(20, 54), _ts(21, 7)
    segs = plan(now, CFG, [], [_pass(aos, los)], [], horizon_h=6)
    kinds = {s.kind for s in segs}
    assert "sonde" in kinds and "sat" in kinds
    sonde = next(s for s in segs if s.kind == "sonde")
    sat = next(s for s in segs if s.kind == "sat")
    assert sonde.start == _ts(20, 0) and sonde.end == _ts(22, 30)
    assert sonde.priority == PRI_SONDE
    assert sat.priority == PRI_SAT
    assert sat.start == aos - 20 and sat.end == los + 20


def test_decide_sat_preempta_sonda_e_retoma():
    aos, los = _ts(20, 54), _ts(21, 7)
    segs = plan(_ts(19, 0), CFG, [], [_pass(aos, los)], [], horizon_h=6)
    sonde = next(s for s in segs if s.kind == "sonde")
    sat = next(s for s in segs if s.kind == "sat")

    # 20:00 → inicia sonda
    a = decide(_ts(20, 0), None, segs)
    assert a.op == "start" and a.segment and a.segment.kind == "sonde"

    job = {
        "mode": "sonde", "until": sonde.end, "prev": "adsb", "label": sonde.label,
        "priority": PRI_SONDE, "seg_id": sonde.id, "kind": "sonde", "params": {},
        "actual_mode": "sonde",
    }
    # 20:54 → satélite preempta
    a = decide(_ts(20, 54), job, segs)
    assert a.op == "preempt" and a.segment and a.segment.kind == "sat"
    assert "pausada" in a.reason.lower() or "Meteor" in a.reason

    # sat em curso com sonda pausada; until = LOS (21:07), como na passagem real
    job_sat = {
        "mode": "sat", "until": los, "prev": "adsb", "label": sat.label,
        "priority": PRI_SAT, "seg_id": sat.id, "kind": "sat", "params": {},
        "actual_mode": "sat",
        "paused": {
            "mode": "sonde", "until": sonde.end, "prev": "adsb", "label": sonde.label,
            "priority": PRI_SONDE, "seg_id": sonde.id, "kind": "sonde", "params": {},
        },
    }
    # 21:07 → fim do sat; retoma sonda (janela ainda aberta até 22:30)
    a = decide(los, job_sat, segs)
    assert a.op == "end" and a.resume is not None
    assert a.resume["mode"] == "sonde"
    assert a.restore is None

    # sonda retomada até 22:30
    job_sonde2 = {
        "mode": "sonde", "until": sonde.end, "prev": "adsb", "label": sonde.label,
        "priority": PRI_SONDE, "seg_id": sonde.id, "kind": "sonde", "params": {},
        "actual_mode": "sonde",
    }
    a = decide(_ts(22, 30), job_sonde2, segs)
    assert a.op == "end" and a.restore == "adsb" and a.resume is None


def test_daily_e_weekly_e_skips():
    now = _ts(8, 0, day=16)  # segunda 16/11/2026
    entries = [
        {"id": "d1", "label": "FM manhã", "kind": "mode", "mode": "fm", "freq": 90.3,
         "repeat": "daily", "start": "09:00", "end": "09:30", "enabled": True, "days": []},
        {"id": "w1", "label": "AIS semanal", "kind": "mode", "mode": "ais",
         "repeat": "weekly", "days": [0], "start": "10:00", "end": "11:00", "enabled": True},  # seg
        {"id": "o1", "label": "uma vez", "kind": "mode", "mode": "aprs",
         "repeat": "once", "date": "2026-11-16", "start": "12:00", "end": "12:15", "enabled": True},
    ]
    segs = plan(now, {"sat_auto": False, "sonde_auto": False}, entries, [], [], horizon_h=48)
    daily = [s for s in segs if s.params.get("entry_id") == "d1"]
    weekly = [s for s in segs if s.params.get("entry_id") == "w1"]
    once = [s for s in segs if s.params.get("entry_id") == "o1"]
    assert len(daily) >= 2
    assert all(s.priority == PRI_RECUR for s in daily)
    assert len(weekly) >= 1 and all(datetime.fromtimestamp(s.start).weekday() == 0 for s in weekly)
    assert len(once) == 1 and once[0].priority == PRI_ONCE

    # skip da ocorrência diária de 16/11
    ref = "entry:d1:2026-11-16"
    segs2 = plan(now, {"sat_auto": False, "sonde_auto": False}, entries, [],
                 [{"ref": ref, "date": "2026-11-16"}], horizon_h=48)
    skipped = [s for s in segs2 if s.params.get("entry_id") == "d1" and s.state == "skipped"]
    assert skipped
    assert decide(_ts(9, 5, day=16), None, segs2).op == "noop" or (
        decide(_ts(9, 5, day=16), None, segs2).segment
        and decide(_ts(9, 5, day=16), None, segs2).segment.params.get("entry_id") != "d1"
    )


def test_troca_manual_suprime():
    segs: list[Segment] = []
    job = {
        "mode": "sat", "until": 9e12, "prev": "adsb", "label": "teste",
        "priority": PRI_SAT, "seg_id": "sat:x", "actual_mode": "fm",
    }
    a = decide(_ts(12, 0), job, segs)
    assert a.op == "suppress"
    assert a.suppress_key == "sat"
    assert a.suppress_until == 9e12


def test_fim_natural_restaura():
    job = {
        "mode": "sat", "until": 9e12, "prev": "adsb", "label": "teste",
        "priority": PRI_SAT, "seg_id": "sat:x", "actual_mode": "idle",
    }
    a = decide(_ts(12, 0), job, [])
    assert a.op == "end" and a.restore == "adsb" and a.resume is None


def test_once_vence_sat():
    aos, los = _ts(20, 54), _ts(21, 7)
    entries = [{
        "id": "u1", "label": "escuta", "kind": "mode", "mode": "fm", "freq": 90.3,
        "repeat": "once", "date": "2026-11-16", "start": "20:50", "end": "21:10", "enabled": True,
    }]
    segs = plan(_ts(19, 0), CFG, entries, [_pass(aos, los)], [], horizon_h=6)
    a = decide(_ts(20, 55), None, segs)
    assert a.op == "start" and a.segment and a.segment.priority == PRI_ONCE


def _run_tick(monkeypatch, mode):
    calls = []

    async def fake_apply(m, *a, **kw):
        calls.append((m, kw.get("origin")))
        return True, ""

    monkeypatch.setattr(schedule.modes, "apply", fake_apply)
    schedule.job.clear()
    schedule.suppressed.clear()
    schedule.job.update(mode="sat", until=9e12, prev="adsb", label="teste",
                        priority=PRI_SAT, seg_id="sat:x", kind="sat", params={})
    monkeypatch.setattr(sdr.state, "mode", mode)
    # sem sat/sonde auto: plan vazio; decide só olha o job
    monkeypatch.setattr(schedule.store, "load_config", lambda: {
        "sat_auto": False, "sonde_auto": False, "sonde_windows": [], "sat_min_el": 20,
    })
    asyncio.run(schedule.tick())
    return calls


def test_tick_captura_que_termina_sozinha_devolve_modo(monkeypatch):
    calls = _run_tick(monkeypatch, "idle")
    assert calls == [("adsb", "agenda: fim")]
    assert not schedule.job
    assert "sat" not in schedule.suppressed


def test_tick_troca_manual_suprime(monkeypatch):
    calls = _run_tick(monkeypatch, "fm")
    assert calls == []
    assert not schedule.job
    assert "sat" in schedule.suppressed


def test_crud_entries_e_skip(tmp_path, monkeypatch):
    monkeypatch.setattr(schedule, "SCHEDULE_PATH", tmp_path / "schedule.json")
    monkeypatch.setattr(schedule.store, "DATA", tmp_path)
    e = schedule.add_entry({"label": "teste", "mode": "fm", "repeat": "daily",
                            "start": "08:00", "end": "08:30"})
    assert e["id"] and schedule.get_entry(e["id"])
    schedule.update_entry(e["id"], {"enabled": False})
    assert schedule.get_entry(e["id"])["enabled"] is False
    sk = schedule.add_skip(f"entry:{e['id']}", "2026-11-16")
    assert sk in schedule.list_skips()
    assert schedule.delete_entry(e["id"])
    assert schedule.get_entry(e["id"]) is None


def test_action_dataclass():
    a = Action(op="noop", reason="x")
    assert a.segment is None
