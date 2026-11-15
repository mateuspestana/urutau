# Autor: Matheus C. Pestana
import json

from app import decoders, obs


def setup_module():
    obs.init()


def _obj(source, key):
    return next((o for o in obs.objects(source) if o["key"] == key), None)


def test_ais_descarta_valores_indisponiveis():
    decoders.ais_line(json.dumps({
        "mmsi": 710000001, "type": 1, "lat": -23.98, "lon": -46.30, "speed": 102.3, "course": 360,
        "heading": 511, "shipname": "BARCA TESTE", "rxuxtime": 1794600000,
    }))
    o = _obj("ais", "710000001")
    assert o is not None
    assert o["lat"] == -23.98
    for campo in ("speed", "course", "heading"):
        assert campo not in o["data"]
    assert o["data"]["shipname"] == "BARCA TESTE"


def test_ais_sem_posicao_nao_vira_coordenada():
    decoders.ais_line(json.dumps({"mmsi": 710000002, "type": 5, "lat": 91, "lon": 181, "shipname": "SEM POS"}))
    o = _obj("ais", "710000002")
    assert o is not None and o["lat"] is None


def test_ism_chave_por_modelo_id_canal_e_guarda_mensagem():
    decoders.ism_line(json.dumps({
        "time": 1794600000, "model": "Acurite-Tower", "id": 1234, "channel": "A", "temperature_C": 24.5,
        "humidity": 70,
    }))
    assert _obj("ism", "Acurite-Tower:1234:A") is not None
    msgs = obs.messages("ism", key="Acurite-Tower:1234:A")
    assert msgs and "temperature_C=24.5" in msgs[0]["text"]


def test_ism_ignora_evento_de_hop():
    before = len(obs.messages("ism"))
    decoders.ism_line(json.dumps({
        "time": 1794600000, "center_frequency": 433920000,
        "frequencies": [315000000, 433920000], "hop_times": [60],
    }))
    assert _obj("ism", "?") is None
    assert len(obs.messages("ism")) == before


def test_aprs_posicao_e_pacote_invalido():
    decoders.aprs_line("APRS: PY1ABC-9>APRS,WIDE1-1:!1547.94S/04751.84W>Teste movel")
    o = _obj("aprs", "PY1ABC-9")
    assert o is not None
    assert round(o["lat"], 2) == -15.8
    decoders.aprs_line("APRS: PY1XYZ>APRS:lixo que o aprslib não entende")
    assert _obj("aprs", "PY1XYZ") is not None  # guardado mesmo assim, com o erro
    decoders.aprs_line("AFSK1200: ruído")  # ignorado sem quebrar


def test_rds_ignora_parcial_so_com_espacos():
    decoders.reset_rds()
    decoders.rds_line(json.dumps({"pi": "0xD498", "partial_ps": "        "}))
    assert decoders.rds["pi"] == "0xD498"
    assert "ps_partial" not in decoders.rds
    decoders.rds_line(json.dumps({"pi": "0xD498", "partial_ps": "RADIO   "}))
    assert decoders.rds["ps_partial"] == "RADIO   "
    decoders.rds_line(json.dumps({"pi": "0xD498", "ps": "RADIO 98"}))
    assert decoders.rds["ps"] == "RADIO 98"
    assert decoders.rds["groups"] == 3
