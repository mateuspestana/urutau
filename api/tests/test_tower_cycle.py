# Autor: Matheus C. Pestana
"""Ciclo ADS-B/ACARS da torre com um dongle: decisão pura, sem rádio."""
from __future__ import annotations

from app import tower_cycle
from app.tower_cycle import Settings, decide, settings, strong_aircraft

ST = Settings(enabled=True, adsb_s=180.0, acars_s=60.0, min_rssi=-30.0)


def step(now, **kw):
    base = dict(mode="adsb", phase="adsb", started=0.0, dual=False, job_active=False, strong=1)
    base.update(kw)
    return decide(now, ST, **base)


def test_adsb_espera_o_tempo_e_o_sinal():
    assert step(100)[0] == "noop"  # ainda não deu 180 s
    assert step(181, strong=0)[0] == "noop"  # tempo ok, mas sem aeronave forte
    action, phase, started = step(181)
    assert (action, phase, started) == ("to_acars", "acars", 181)


def test_acars_volta_ao_fim_da_janela():
    assert decide(200, ST, mode="acars", phase="acars", started=181, dual=False, job_active=False, strong=0)[0] == "noop"
    action, phase, started = decide(242, ST, mode="acars", phase="acars", started=181, dual=False,
                                    job_active=False, strong=0)
    assert (action, phase, started) == ("to_adsb", "adsb", 242)


def test_acars_da_pessoa_nao_e_tocado():
    r = decide(999, ST, mode="acars", phase="adsb", started=0, dual=False, job_active=False, strong=0)
    assert r[0] == "noop" and r[1] is None


def test_troca_manual_no_meio_zera_a_fase():
    # estava no ACARS do ciclo e a pessoa foi para o FM
    assert decide(10, ST, mode="fm", phase="acars", started=0, dual=False, job_active=False, strong=0)[1] is None
    # voltou ao ADS-B sozinha: conta de novo a partir de agora
    assert decide(10, ST, mode="adsb", phase="acars", started=0, dual=False, job_active=False, strong=0) == ("noop", "adsb", 10)


def test_agenda_dual_e_desligado_pausam():
    assert step(500, job_active=True)[0] == "noop"
    assert step(500, dual=True)[0] == "noop"
    off = Settings(False, 180.0, 60.0, -30.0)
    assert decide(500, off, mode="adsb", phase="adsb", started=0, dual=False, job_active=False, strong=1)[0] == "noop"


def test_desligar_no_acars_do_ciclo_devolve_o_adsb():
    off = Settings(False, 180.0, 60.0, -30.0)
    assert decide(5, off, mode="acars", phase="acars", started=0, dual=False, job_active=False, strong=0)[0] == "to_adsb"
    # ACARS escolhido pela pessoa continua
    assert decide(5, off, mode="acars", phase=None, started=0, dual=False, job_active=False, strong=0)[0] == "noop"


def test_aeronave_forte_exige_sinal_e_presenca():
    ac = [
        {"rssi": -25.0, "seen": 2.0},
        {"rssi": -35.0, "seen": 1.0},  # fraca
        {"rssi": -20.0, "seen": 40.0},  # sumiu
        {"seen": 1.0},  # sem rssi
    ]
    assert strong_aircraft(ac, -30.0) == 1
    assert strong_aircraft(ac, -40.0) == 2


def test_limites_da_configuracao():
    s = settings({"tower_cycle": True, "tower_adsb_s": 5, "tower_acars_s": 99999, "tower_min_rssi": "x"})
    assert s.adsb_s == tower_cycle.ADS_MIN and s.acars_s == tower_cycle.ACARS_MAX and s.min_rssi == -30.0
    assert settings({}).enabled is False
