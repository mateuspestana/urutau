# Autor: Matheus C. Pestana
"""Gravação WAV: cabeçalho válido legível pelo módulo wave."""
from __future__ import annotations

import struct
import wave

from app import rec, store


def test_wav_cabecalho_valido(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "REC_DIR", tmp_path / "rec")
    monkeypatch.setattr(store, "DATA", tmp_path)
    rate = 48000
    # 0,5 s de silêncio s16le mono
    n = rate // 2
    pcm = struct.pack(f"<{n}h", *([0] * n))
    path = rec.write_pcm_file(tmp_path / "rec" / "teste.wav", pcm, sample_rate=rate)
    assert path.is_file()
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == rate
        assert w.getnframes() == n
        assert w.readframes(n) == pcm


def test_safe_path_bloqueia_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "REC_DIR", tmp_path / "rec")
    (tmp_path / "rec").mkdir(parents=True)
    (tmp_path / "rec" / "ok.wav").write_bytes(b"RIFF")
    assert rec.safe_path("ok.wav") is not None or True  # pode falhar wave; path existe
    # safe_path exige arquivo; RIFF curto ainda é arquivo
    p = rec.safe_path("ok.wav")
    assert p is not None and p.name == "ok.wav"
    assert rec.safe_path("../ok.wav") is None
    assert rec.safe_path("a/b.wav") is None
    assert rec.safe_path(".hidden.wav") is None


def test_enforce_quota_apaga_antigas(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "REC_DIR", tmp_path / "rec")
    monkeypatch.setattr(store, "DATA", tmp_path)
    d = tmp_path / "rec"
    d.mkdir(parents=True)
    # dois arquivos ~1 KiB; limite minúsculo força apagar o mais antigo
    a = d / "a_old.wav"
    b = d / "b_new.wav"
    rec.write_pcm_file(a, rec.silence_pcm(0.01, 8000), 8000)
    rec.write_pcm_file(b, rec.silence_pcm(0.01, 8000), 8000)
    # mtime: a mais antiga
    import os
    os.utime(a, (1_000_000, 1_000_000))
    os.utime(b, (2_000_000, 2_000_000))
    removed = rec.enforce_quota(max_gb=0)  # cota zero → apaga do mais antigo
    assert removed and removed[0] == "a_old.wav"
    assert not a.exists()


def test_list_e_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "REC_DIR", tmp_path / "rec")
    monkeypatch.setattr(store, "DATA", tmp_path)
    path = rec.write_pcm_file(tmp_path / "rec" / "x.wav", rec.silence_pcm(0.02), 12000)
    items = rec.list_recordings()
    assert any(i["name"] == "x.wav" for i in items)
    ok, err = rec.delete("x.wav")
    assert ok and not err
    assert not path.exists()
