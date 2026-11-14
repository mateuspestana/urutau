# Autor: Matheus C. Pestana
from datetime import UTC, datetime

from app import sats

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
