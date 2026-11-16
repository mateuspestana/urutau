# Autor: Matheus C. Pestana
"""Diagnóstico: árvore /sys falsa, mediana/p10 e deltas de ruído."""
from __future__ import annotations

from pathlib import Path

from app import health


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_list_rtl_dongles_fake_sys(tmp_path: Path):
    bus = tmp_path / "bus" / "usb" / "devices"
    # dongle RTL-SDR Blog V4
    d1 = bus / "1-1"
    _write(d1 / "idVendor", "0bda")
    _write(d1 / "idProduct", "2838")
    _write(d1 / "product", "RTL2838UHIDIR")
    _write(d1 / "serial", "00000001")
    # interface (deve ser ignorada)
    _write(bus / "1-1:1.0" / "idVendor", "0bda")
    # outro USB qualquer
    d2 = bus / "1-2"
    _write(d2 / "idVendor", "1d6b")
    _write(d2 / "idProduct", "0002")
    # RTL clássico 2832
    d3 = bus / "2-1"
    _write(d3 / "idVendor", "0bda")
    _write(d3 / "idProduct", "2832")
    _write(d3 / "product", "Bulk")
    _write(d3 / "serial", "abc")

    found = health.list_rtl_dongles(tmp_path)
    assert len(found) == 2
    serials = {d["serial"] for d in found}
    assert serials == {"00000001", "abc"}
    assert all(d["id_vendor"] == "0bda" for d in found)


def test_dvb_driver_loaded(tmp_path: Path):
    assert health.dvb_driver_loaded(tmp_path) is False
    (tmp_path / "module" / "dvb_usb_rtl28xxu").mkdir(parents=True)
    assert health.dvb_driver_loaded(tmp_path) is True


def test_median_and_p10():
    pts = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    assert health.median(pts) == 5.5
    assert health.median([3.0]) == 3.0
    assert health.median([]) is None
    # p10 de 1..10: índice 0.9 → entre 1 e 2
    p10 = health.percentile10(pts)
    assert p10 is not None
    assert 1.0 <= p10 <= 2.0
    assert health.percentile10([]) is None


def test_band_stats_from_sample_points():
    points = [
        {"mhz": 137.1, "db": -40.0},
        {"mhz": 137.2, "db": -38.0},
        {"mhz": 137.5, "db": -20.0},  # pico
        {"mhz": 137.8, "db": -39.0},
        {"mhz": 137.9, "db": -41.0},
    ]
    s = health.band_stats(points)
    assert s["peak_db"] == -20.0
    assert s["peak_mhz"] == 137.5
    dbs = [-40.0, -38.0, -20.0, -39.0, -41.0]
    assert s["noise_db"] == round(health.median(dbs), 2)  # type: ignore[arg-type]
    assert s["p10"] == round(health.percentile10(dbs), 2)  # type: ignore[arg-type]


def test_compare_bands_delta():
    current = [
        {"name": "meteor", "label": "Meteor", "start": 137, "end": 138, "noise_db": -42.0},
        {"name": "fm", "label": "FM", "start": 88, "end": 108, "noise_db": -50.0},
    ]
    baseline = [
        {"name": "meteor", "label": "Meteor", "start": 137, "end": 138, "noise_db": -38.0},
        {"name": "fm", "label": "FM", "start": 88, "end": 108, "noise_db": -50.0},
    ]
    deltas = health.compare_bands(current, baseline)
    by = {d["name"]: d for d in deltas}
    assert by["meteor"]["delta_db"] == -4.0  # 4 dB mais silencioso
    assert by["fm"]["delta_db"] == 0.0


def test_warnings_no_dongle_and_dvb(tmp_path: Path):
    warnings = health.build_warnings(tmp_path)
    codes = {w["code"] for w in warnings}
    assert "no_dongle" in codes
    (tmp_path / "module" / "dvb_usb_rtl28xxu").mkdir(parents=True)
    warnings2 = health.build_warnings(tmp_path)
    assert any(w["code"] == "dvb_driver" for w in warnings2)
    # críticos vêm primeiro
    assert warnings2[0]["level"] == "critical"


def test_noise_history_persist(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(health, "HEALTH_PATH", tmp_path / "health.json")
    monkeypatch.setattr(health.store, "DATA", tmp_path)
    assert health.load_noise_history() == []
    entry = {"ts": 1.0, "antenna_label": "estoque", "bands": [{"name": "fm", "noise_db": -50}]}
    items = health.append_noise_measurement(entry)
    assert len(items) == 1
    assert health.load_noise_history()[0]["antenna_label"] == "estoque"
    for i in range(55):
        health.append_noise_measurement({"ts": float(i), "antenna_label": f"a{i}", "bands": []})
    assert len(health.load_noise_history()) == 50
