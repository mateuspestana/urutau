# Autor: Matheus C. Pestana
import asyncio
from datetime import UTC, datetime

from app import sats, schedule, sdr

# TLEs reais de 13/11/2026 (época 26317); o cálculo começa perto da época para não depender da data de hoje
TLE = {
    "meteor-m2-3": ["METEOR-M2 3",
                    "1 57166U 23091A   26317.61610038 -.00000003  00000+0  17239-4 0  9993",
                    "2 57166  98.5897   9.3885 0005077  95.8099 264.3659 14.24056396175788"],
    "iss": ["ISS (ZARYA)",
            "1 25544U 98067A   26317.40012392  .00008768  00000+0  16503-3 0  9996",
            "2 25544  51.6324 281.7005 0007366  20.9423 339.1866 15.49350588594886"],
}
START = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


def test_passagens_brasilia_48h():
    items = sats._compute(TLE, -15.78, -47.93, 48.0, 0.0, start=START)
    meteor = [p for p in items if p["sat"] == "meteor-m2-3"]
    iss = [p for p in items if p["sat"] == "iss"]
    assert len(meteor) >= 4  # órbita polar: várias passagens por dia em qualquer latitude
    assert len(iss) >= 2
    for p in items:
        assert p["aos"] < p["tca"] < p["los"]
        assert 5 <= p["max_el"] <= 90
        assert 0 <= p["aos_az"] <= 360
    assert items == sorted(items, key=lambda p: p["aos"])


def test_elevacao_minima_filtra_lrpt_mas_nao_info():
    alto = sats._compute(TLE, -15.78, -47.93, 48.0, 60.0, start=START)
    assert all(p["max_el"] >= 60 for p in alto if p["kind"] == "lrpt")
    assert any(p["kind"] == "info" and p["max_el"] < 60 for p in alto)


def test_janela_de_sonda_cruza_meia_noite():
    cfg = {"sonde_windows": ["23:00-01:00", "lixo"]}
    noite = datetime(2026, 11, 13, 23, 30).timestamp()
    tarde = datetime(2026, 11, 13, 15, 0).timestamp()
    assert sats._sonde_window(noite, cfg) is not None
    assert sats._sonde_window(tarde, cfg) is None


def _run_tick(monkeypatch, mode):
    calls = []

    async def fake_apply(m, *a, **kw):
        calls.append((m, kw.get("origin")))
        return True, ""

    # a agenda mora em schedule; sats._tick só delega
    monkeypatch.setattr(schedule.modes, "apply", fake_apply)
    monkeypatch.setattr(schedule.store, "load_config", lambda: {
        "sat_auto": False, "sonde_auto": False, "sonde_windows": [], "sat_min_el": 20,
    })
    schedule.job.clear()
    schedule.suppressed.clear()
    schedule.job.update(mode="sat", until=9e12, prev="adsb", label="teste",
                        priority=1, seg_id="sat:x", kind="sat", params={})
    monkeypatch.setattr(sdr.state, "mode", mode)
    asyncio.run(sats._tick())
    return calls


def test_captura_que_termina_sozinha_devolve_o_modo_anterior(monkeypatch):
    # o SatDump sai com --timeout e a API põe o modo em idle: a agenda tem de voltar ao ADS-B
    calls = _run_tick(monkeypatch, "idle")
    assert calls == [("adsb", "agenda: fim")]
    assert not sats.job
    assert "sat" not in sats.suppressed


def test_troca_para_outro_modo_nao_e_desfeita(monkeypatch):
    calls = _run_tick(monkeypatch, "fm")
    assert calls == []
    assert not sats.job
    assert "sat" in sats.suppressed


def test_pass_id_estavel():
    assert sats.pass_id("meteor-m2-3", 1731400000.7) == "meteor-m2-3-1731400000"
    assert sats.parse_pass_id("meteor-m2-3-1731400000") == ("meteor-m2-3", 1731400000)
    assert sats.parse_pass_id("iss-99") == ("iss", 99)
    assert sats.parse_pass_id("nope-1") is None
    assert sats.parse_pass_id("meteor-m2-3") is None


def test_track_amostras_ordem_e_passo():
    items = sats._compute(TLE, -15.78, -47.93, 48.0, 0.0, start=START)
    meteor = next(p for p in items if p["sat"] == "meteor-m2-3")
    lines = TLE["meteor-m2-3"]
    pts = sats._sample_track(
        "meteor-m2-3", meteor["aos"], meteor["los"], -15.78, -47.93, lines, step=10.0,
    )
    assert len(pts) >= 2
    expected = int((meteor["los"] - meteor["aos"]) / 10.0) + 1
    # pode haver +1 se o último ponto de LOS for anexado
    assert expected <= len(pts) <= expected + 1
    times = [p["t"] for p in pts]
    assert times == sorted(times)
    assert abs(times[0] - meteor["aos"]) < 1.0
    assert times[-1] <= meteor["los"] + 1.0
    for i in range(1, len(pts) - 1):
        assert abs(pts[i]["t"] - pts[i - 1]["t"] - 10.0) < 0.2
    for p in pts:
        assert 0 <= p["az"] <= 360
        assert -5 <= p["el"] <= 90
    assert meteor["id"] == sats.pass_id(meteor["sat"], meteor["aos"])


def test_thumb_path_safety(tmp_path, monkeypatch):
    sat = tmp_path / "sat"
    sat.mkdir()
    monkeypatch.setattr(sats, "SAT_DIR", sat)
    monkeypatch.setattr(sats, "THUMB_DIR", sat / ".thumbs")
    # traversal
    assert sats.make_thumb("../etc/passwd") is None
    assert sats.make_thumb("../../secret.png") is None
    # arquivo inexistente
    assert sats.make_thumb("missing.png") is None
    # PNG válido → miniatura no cache
    try:
        from PIL import Image
    except ImportError:
        return  # ambiente sem Pillow: só a segurança de caminho acima conta
    src = sat / "cap" / "rgb_composite.png"
    src.parent.mkdir()
    Image.new("RGB", (200, 120), (40, 80, 120)).save(src)
    out = sats.make_thumb("cap/rgb_composite.png", w=64)
    assert out is not None
    assert out.is_file()
    assert sat / ".thumbs" in out.parents or out.parent == sat / ".thumbs"
    again = sats.make_thumb("cap/rgb_composite.png", w=64)
    assert again == out
