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


def test_suavizacao_desligada_devolve_o_bruto():
    base = [20.0] * 360
    base[90] = 80.0
    out = _study(base).smoothed_km(median_half=0, sigma=0, gap_max=0)
    assert out[90] == 80.0 and out[10] == 20.0


def test_mediana_maior_derruba_lobulo_mais_largo():
    base = [20.0] * 360
    for i in range(100, 108):  # 8° de largura
        base[i] = 60.0
    fino = _study(base).smoothed_km(median_half=2, sigma=0, gap_max=45)
    grosso = _study(base).smoothed_km(median_half=8, sigma=0, gap_max=45)
    assert fino[103] == 60.0
    assert grosso[103] == 20.0


def test_gap_zero_nao_interpola():
    base = [0.0] * 360
    base[0] = base[10] = 30.0
    out = _study(base).smoothed_km(median_half=0, sigma=0, gap_max=0)
    assert out[5] is None


def test_parametros_da_suavizacao_sao_limitados():
    p = range_study.RangeStudy.smoothing_params(
        {"range_median_deg": 99, "range_sigma_deg": -3, "range_gap_deg": "x", "range_view": "tudo"})
    assert p == {"median_deg": 20, "sigma_deg": 0.0, "gap_deg": 45, "view": "smooth"}
    p = range_study.RangeStudy.smoothing_params({"range_view": "both"})
    assert p["view"] == "both" and p["median_deg"] == 4 and p["sigma_deg"] == 2.0
