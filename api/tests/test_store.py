# Autor: Matheus C. Pestana
from app import store


def test_sem_localizacao_por_padrao():
    assert store.receiver() is None


def test_localizacao_salva_e_valida():
    store.save_config({"lat": -15.8, "lon": -47.9})
    assert store.receiver() == (-15.8, -47.9)
    store.save_config({"lat": 0, "lon": 0})
    assert store.receiver() is None
    store.save_config({"lat": None, "lon": None})
    assert store.receiver() is None
