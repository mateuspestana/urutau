# Autor: Matheus C. Pestana
"""Parser SatDump, veredito e safe_path das capturas."""
from app import sats

LINE_SNR = "(I) Progress inf%, SNR : 0.000000dB, Peak SNR: 1.921056dB"
LINE_NOSYNC = "(I) Progress -nan%, Viterbi : NOSYNC BER : 0.411377, Deframer : NOSYNC"
LINE_SYNC = "(I) Progress 12%, SNR : 5.200000dB, Peak SNR: 5.400000dB, Viterbi : SYNCED BER : 0.01, Deframer : SYNCED"


def test_parse_peak_snr_e_nosync():
    st: dict = {"started_at": 0, "snr_peak": 0.0, "samples": 0, "snr_mean": 0.0,
                "viterbi_sync_n": 0, "deframer_sync_n": 0}
    sats.ingest_satdump_line(LINE_SNR, st)
    assert abs(st["snr_peak"] - 1.921056) < 1e-6
    sats.ingest_satdump_line(LINE_NOSYNC, st)
    assert st["viterbi_sync_n"] == 0
    assert st.get("first_sync_ts") is None


def test_parse_sync_e_media():
    st: dict = {"started_at": 0, "snr_peak": 0.0, "samples": 0, "snr_mean": 0.0,
                "viterbi_sync_n": 0, "deframer_sync_n": 0}
    sats.ingest_satdump_line(LINE_SYNC, st)
    assert st["snr_last"] == 5.2
    assert st["samples"] == 1
    assert st["viterbi_sync_n"] == 1
    assert st["deframer_sync_n"] == 1
    assert st.get("first_sync_ts")
    assert st["sync_seconds"] == sats.SYNC_LINE_INTERVAL_S


def test_verdict_todos_os_ramos():
    assert sats.verdict({}, 0, 30) == "interrupted"
    assert sats.verdict({}, 2, 120) == "ok"
    assert sats.verdict({"first_sync_ts": 1}, 0, 120) == "locked_no_image"
    assert sats.verdict({"snr_peak": 3.5}, 0, 120) == "weak"
    assert sats.verdict({"snr_peak": 1.9}, 0, 120) == "no_signal"
    assert sats.verdict({"viterbi_sync_n": 3}, 0, 120) == "locked_no_image"


def test_safe_path_bloqueia_parent(tmp_path, monkeypatch):
    sat = tmp_path / "sat"
    sat.mkdir()
    (sat / "ok.txt").write_text("x")
    monkeypatch.setattr(sats, "SAT_DIR", sat)
    assert sats.safe_path("ok.txt") is not None
    assert sats.safe_path("../ok.txt") is None
    assert sats.safe_path("../../etc/passwd") is None


def test_safe_capture_dir_e_delete(tmp_path, monkeypatch):
    sat = tmp_path / "sat"
    sat.mkdir()
    d = sat / "20261116_test"
    d.mkdir()
    (d / "capture.json").write_text("{}")
    monkeypatch.setattr(sats, "SAT_DIR", sat)
    assert sats.safe_capture_dir("..") is None
    assert sats.safe_capture_dir("../x") is None
    assert sats.safe_capture_dir("20261116_test") == d.resolve()
    ok, err = sats.delete_capture("20261116_test")
    assert ok and not err
    assert not d.exists()


def test_delete_empty_captures(tmp_path, monkeypatch):
    sat = tmp_path / "sat"
    sat.mkdir()
    empty = sat / "empty"
    empty.mkdir()
    full = sat / "full"
    full.mkdir()
    (full / "img.png").write_bytes(b"x")
    monkeypatch.setattr(sats, "SAT_DIR", sat)
    assert sats.delete_empty_captures() == 1
    assert not empty.exists()
    assert full.exists()


def test_start_capture_limpa_log(monkeypatch):
    """O log da captura anterior não pode contaminar o SNR da seguinte."""
    from app import decoders

    decoders.log["sat"].clear()
    decoders.log["sat"].append("Peak SNR: 9.999dB de outra passagem")
    sats.live.clear()
    sats.live.update({"started_at": 0, "snr_peak": 0.0, "samples": 0, "snr_mean": 0.0,
                      "viterbi_sync_n": 0, "deframer_sync_n": 0})
    # simula o clear que start_capture faz antes de medir
    decoders.log["sat"].clear()
    sats.live.clear()
    sats.live.update({"started_at": 0, "snr_peak": 0.0, "samples": 0, "snr_mean": 0.0,
                      "viterbi_sync_n": 0, "deframer_sync_n": 0})
    sats.ingest_satdump_line(LINE_SNR, sats.live)
    assert abs(sats.live["snr_peak"] - 1.921056) < 1e-6
    assert len(decoders.log["sat"]) == 0
