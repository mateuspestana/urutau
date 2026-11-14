# Autor: Matheus C. Pestana
from app import range_study


def _study(values):
    s = range_study.RangeStudy.__new__(range_study.RangeStudy)
    s.polar_max_km = list(values)
    return s


def test_pico_isolado_some():
    base = [20.0] * 360
    base[90] = 80.0  # uma aeronave só, num setor de 1°
    out = _study(base).smoothed_km()
    assert out[90] is not None and out[90] < 25


def test_lobulo_largo_permanece():
    base = [20.0] * 360
    for i in range(80, 121):  # 40° de alcance maior: é cobertura de verdade
        base[i] = 60.0
    out = _study(base).smoothed_km()
    assert out[100] > 55


def test_buraco_curto_e_interpolado_e_longo_fica_vazio():
    base = [0.0] * 360
    for i in range(0, 90):
        base[i] = 30.0
    base[100] = 30.0  # buraco de 10° entre 89 e 100
    out = _study(base).smoothed_km()
    assert out[95] is not None and abs(out[95] - 30) < 1
    assert out[200] is None  # sem dado a menos de 45°: não inventa cobertura


def test_sem_dados():
    assert all(v is None for v in _study([0.0] * 360).smoothed_km())
