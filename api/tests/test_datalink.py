# Autor: Matheus C. Pestana
from app import datalink


def test_check_freqs_aceita_canais_dentro_de_1_8_mhz():
    assert datalink.check_freqs("acars", [131.550, 131.725, 130.450]) == ""


def test_check_freqs_recusa_faixa_larga_e_fora_da_banda():
    assert "1.8" in datalink.check_freqs("acars", [129.125, 131.550])
    assert "fora da faixa" in datalink.check_freqs("vdl2", [118.0])
    assert datalink.check_freqs("acars", []) != ""


def test_parse_acarsdec_bloco_numerico_e_downlink():
    m = datalink.parse_acarsdec({
        "timestamp": 1794600000.5, "freq": 131.55, "level": -28.4, "block_id": "5", "tail": ".PR-XYZ",
        "flight": "TAM3957", "label": "H1", "msgno": "M01A", "text": "POS -15.8 -47.9",
    })
    assert m["source"] == "acars"
    assert m["uplink"] == 0  # bloco numérico: aeronave → solo
    assert m["reg"] == "PR-XYZ"
    assert m["freq_mhz"] == 131.55
    assert m["kind"] == "acars"


def test_parse_acarsdec_uplink_e_cpdlc():
    m = datalink.parse_acarsdec({"block_id": "A", "libacars": {"arinc622": {"cpdlc": {"msg": 1}}}})
    assert m["uplink"] == 1
    assert m["kind"] == "cpdlc"


def test_parse_vdl2_acars_de_aeronave():
    m = datalink.parse_vdl2({"vdl2": {
        "t": {"sec": 1794600000, "usec": 500000}, "freq": 136975000, "sig_level": -20.1, "noise_level": -45.0,
        "avlc": {"src": {"addr": "E48B80", "type": "Aircraft"}, "dst": {"addr": "10E3A4", "type": "Ground station"},
                 "acars": {"reg": "PR-AXE", "flight": "AZU2669", "label": "Q0", "blk_id": "2", "msg_text": ""}},
    }})
    assert m["hex"] == "e48b80"
    assert m["uplink"] == 0
    assert m["freq_mhz"] == 136.975
    assert m["reg"] == "PR-AXE"
    assert m["ts"] == 1794600000.5


def test_parse_vdl2_xid_vira_controle():
    m = datalink.parse_vdl2({"vdl2": {"freq": 136975000, "avlc": {
        "src": {"addr": "10E3A4", "type": "Ground station"}, "dst": {"addr": "FFFFFF", "type": "All stations"},
        "xid": {"type_descr": "Ground Station Information Frame"}}}})
    assert m["kind"] == "xid"
    assert m["hex"] is None


def test_ingest_line_grava_e_ignora_lixo():
    datalink.init()
    assert datalink.ingest_line("acars", "Decoding 8 channels") is None
    msg = datalink.ingest_line("acars", '{"timestamp": 1794600000, "freq": 131.725, "block_id": "3", "text": "TESTE"}')
    assert msg and msg["id"] > 0
    rows = datalink.query(source="acars", q="TESTE")
    assert any(r["text"] == "TESTE" for r in rows)
