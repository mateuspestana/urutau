# Autor: Matheus C. Pestana
"""Dois dongles: device_args e lógica dual com env simulado (sem hardware)."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import sdr, store


@pytest.fixture(autouse=True)
def _clear_serial_env(monkeypatch):
    monkeypatch.delenv("URUTAU_ADSB_SERIAL", raising=False)
    monkeypatch.delenv("URUTAU_SDR_SERIAL", raising=False)
    store.save_config({"adsb_serial": "", "sdr_serial": ""})
    yield
    store.save_config({"adsb_serial": "", "sdr_serial": ""})


def test_device_args_single_defaults():
    assert sdr.device_args("rtl_fm") == []
    assert sdr.device_args("rtl_power") == []
    assert sdr.device_args("rtl_433") == ["-d", "0"]
    assert sdr.device_args("ais") == ["-d:0"]
    assert sdr.device_args("acarsdec") == ["-r", "0"]
    assert sdr.device_args("dumpvdl2") == ["--rtlsdr", "0"]
    assert sdr.device_args("satdump") == []
    assert sdr.device_args("sonde") == ["0"]


def test_device_args_with_sdr_serial(monkeypatch):
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "00000002")
    assert sdr.device_args("rtl_fm") == ["-d", "00000002"]
    assert sdr.device_args("rtl_power") == ["-d", "00000002"]
    assert sdr.device_args("rtl_433") == ["-d", ":00000002"]
    # AIS-catcher: -d SERIAL (espaço) = serial; -d:0 = índice
    assert sdr.device_args("ais") == ["-d", "00000002"]
    assert sdr.device_args("acarsdec") == ["-r", "00000002"]
    assert sdr.device_args("dumpvdl2") == ["--rtlsdr", "00000002"]
    assert sdr.device_args("satdump") == ["--source_id", "00000002"]
    assert sdr.device_args("sonde") == ["00000002"]


def test_device_args_ais_serial_zero_uses_space_form(monkeypatch):
    """Serial literal '0' não pode virar -d:0 (índice)."""
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "0")
    assert sdr.device_args("ais") == ["-d", "0"]


def test_device_args_unknown_tool():
    with pytest.raises(ValueError, match="desconhecida"):
        sdr.device_args("gqrx")


def test_dual_requires_both_different(monkeypatch):
    assert sdr.dual() is False
    monkeypatch.setenv("URUTAU_ADSB_SERIAL", "00000001")
    assert sdr.dual() is False
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "00000001")
    assert sdr.dual() is False
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "00000002")
    assert sdr.dual() is True


def test_dual_from_config_overrides_env(monkeypatch):
    monkeypatch.setenv("URUTAU_ADSB_SERIAL", "envA")
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "envB")
    assert sdr.dual() is True
    store.save_config({"adsb_serial": "cfgA", "sdr_serial": "cfgA"})
    assert sdr.dual() is False
    assert sdr.adsb_serial() == "cfgA"
    store.save_config({"adsb_serial": "cfgA", "sdr_serial": "cfgB"})
    assert sdr.dual() is True
    assert sdr.sdr_serial() == "cfgB"


def test_set_ultrafeeder_false_noop_when_dual(monkeypatch):
    monkeypatch.setenv("URUTAU_ADSB_SERIAL", "A")
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "B")
    with patch.object(sdr, "_docker") as docker:
        asyncio.run(sdr.set_ultrafeeder(False))
        docker.assert_not_called()


def test_set_ultrafeeder_false_stops_when_single(monkeypatch):
    cont = MagicMock()
    cont.status = "running"
    cont.stop = MagicMock()
    client = MagicMock()
    client.containers.get.return_value = cont
    with patch.object(sdr, "_docker", return_value=client):
        asyncio.run(sdr.set_ultrafeeder(False))
    cont.stop.assert_called_once()


def test_status_reports_dual(monkeypatch):
    monkeypatch.setenv("URUTAU_ADSB_SERIAL", "A")
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "B")
    with patch.object(sdr, "ultrafeeder_status", return_value={"running": True, "status": "running"}):
        st = sdr.status()
    assert st["dual"] is True
    assert st["adsb_serial"] == "A"
    assert st["sdr_serial"] == "B"
    assert "Dois dongles" in st["dongle_hint"]


def test_status_single_hint():
    with patch.object(sdr, "ultrafeeder_status", return_value={"running": False, "status": "exited"}):
        st = sdr.status()
    assert st["dual"] is False
    assert "um modo por vez" in st["dongle_hint"]


def test_guard_skips_ultrafeeder_kill_when_dual(monkeypatch):
    monkeypatch.setenv("URUTAU_ADSB_SERIAL", "A")
    monkeypatch.setenv("URUTAU_SDR_SERIAL", "B")
    sdr.state.mode = "fm"
    # um ciclo do laço: sleep → checa → sleep (cancelamos no 2º)
    sleeps = 0

    async def fake_sleep(_n):
        nonlocal sleeps
        sleeps += 1
        if sleeps >= 2:
            raise asyncio.CancelledError()

    with (
        patch.object(sdr.asyncio, "sleep", side_effect=fake_sleep),
        patch.object(sdr, "ultrafeeder_status", return_value={"running": True}) as uf,
        patch.object(sdr, "set_ultrafeeder", new_callable=AsyncMock) as set_uf,
    ):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(sdr.guard_loop())
    uf.assert_not_called()
    set_uf.assert_not_called()
    sdr.state.mode = "idle"
