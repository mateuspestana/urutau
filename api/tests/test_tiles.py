# Autor: Matheus C. Pestana
"""Sanitização de caminhos, descarte LRU do cache de tiles e Range de PMTiles."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from starlette.testclient import TestClient

from app import store, tiles


@pytest.fixture(autouse=True)
def _tiles_root(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path)
    monkeypatch.setattr(store, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(store, "MARKERS_PATH", tmp_path / "markers.json")
    store.save_config({"tiles_max_mb": 0.001})  # ~1 KiB para forçar descarte fácil
    yield


def test_validate_bloqueia_provedor_e_traversal():
    assert tiles.validate_tile("esri-dark", 1, 0, 0) is None
    assert tiles.validate_tile("../etc", 1, 0, 0) is not None
    assert tiles.validate_tile("esri-dark/../x", 1, 0, 0) is not None
    assert tiles.validate_tile("desconhecido", 1, 0, 0) is not None
    assert tiles.validate_tile("esri-dark", 99, 0, 0) is not None
    assert tiles.validate_tile("esri-dark", 1, 99, 0) is not None
    assert tiles.tile_cache_path("nope", 0, 0, 0) is None
    assert tiles.upstream_url("esri-dark", 1, 0, 1) is not None
    # Esri: ordem z/y/x no upstream
    url = tiles.upstream_url("esri-dark", 2, 1, 3)
    assert url is not None and url.endswith("/2/3/1")


def test_safe_pmtiles_name():
    assert tiles.safe_pmtiles_name("regiao") == "regiao"
    assert tiles.safe_pmtiles_name("regiao.pmtiles") == "regiao"
    assert tiles.safe_pmtiles_name("../etc") is None
    assert tiles.safe_pmtiles_name("a/b") is None
    assert tiles.safe_pmtiles_name("") is None
    assert tiles.safe_pmtiles_name(".hidden") is None


def test_pmtiles_path_bloqueia_fora_do_dir(tmp_path):
    maps = tmp_path / "maps"
    maps.mkdir()
    (maps / "ok.pmtiles").write_bytes(b"PMTiles")
    (tmp_path / "fora.pmtiles").write_bytes(b"x")
    assert tiles.pmtiles_path("ok") is not None
    assert tiles.pmtiles_path("../fora") is None
    assert tiles.pmtiles_path("missing") is None


def test_enforce_quota_apaga_mais_antigos(tmp_path):
    root = tmp_path / "tiles" / "esri-dark" / "0" / "0"
    root.mkdir(parents=True)
    a = root / "0.png"
    b = root / "1.png"
    a.write_bytes(b"a" * 800)
    b.write_bytes(b"b" * 800)
    # mtime: a mais antigo
    import os

    os.utime(a, (1_000_000, 1_000_000))
    os.utime(b, (2_000_000, 2_000_000))
    removed = tiles.enforce_quota(root=tmp_path / "tiles", limit=900)
    assert removed >= 1
    assert not a.exists()
    assert b.exists()


def test_parse_range_spec():
    assert tiles.parse_range_spec("bytes=0-9", 100) == (0, 9)
    assert tiles.parse_range_spec("bytes=10-", 100) == (10, 99)
    assert tiles.parse_range_spec("bytes=-5", 100) == (95, 99)
    assert tiles.parse_range_spec("bytes=50-40", 100) is None
    assert tiles.parse_range_spec("bytes=100-110", 100) is None
    assert tiles.parse_range_spec("lixo", 100) is None


def test_pmtiles_range_response(tmp_path):
    maps = tmp_path / "maps"
    maps.mkdir()
    payload = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"  # 26 bytes
    path = maps / "demo.pmtiles"
    path.write_bytes(payload)

    app = FastAPI()

    @app.get("/api/maps/{name}.pmtiles")
    def get_map(name: str, request: Request):
        p = tiles.pmtiles_path(name)
        assert p is not None
        return tiles.pmtiles_response(p, request)

    client = TestClient(app)
    full = client.get("/api/maps/demo.pmtiles")
    assert full.status_code == 200
    assert full.content == payload
    assert full.headers.get("accept-ranges") == "bytes"

    part = client.get("/api/maps/demo.pmtiles", headers={"Range": "bytes=0-4"})
    assert part.status_code == 206
    assert part.content == b"ABCDE"
    assert part.headers["content-range"] == "bytes 0-4/26"

    tail = client.get("/api/maps/demo.pmtiles", headers={"Range": "bytes=20-"})
    assert tail.status_code == 206
    assert tail.content == b"UVWXYZ"

    bad = client.get("/api/maps/demo.pmtiles", headers={"Range": "bytes=100-200"})
    assert bad.status_code == 416


def test_list_pmtiles(tmp_path):
    maps = tmp_path / "maps"
    maps.mkdir()
    (maps / "sul.pmtiles").write_bytes(b"x")
    (maps / "norte.pmtiles").write_bytes(b"yy")
    (maps / "ignore.txt").write_text("no")
    names = {m["name"] for m in tiles.list_pmtiles()}
    assert names == {"sul", "norte"}


def test_tiles_max_mb_default():
    # save_config acima setou 0.001; confere conversão
    assert tiles.tiles_max_bytes() == max(1, int(0.001 * 1024 * 1024))
    store.save_config({"tiles_max_mb": 512})
    assert tiles.tiles_max_bytes() == 512 * 1024 * 1024


def test_report_html_embute_leaflet_sem_unpkg():
    from app import report_html

    html = report_html.build_range_html(
        {
            "receiver": {"lat": -15.8, "lon": -47.9, "address": ""},
            "max_km": 0,
            "avg_max_km": 0,
            "p50_km": 0,
            "sectors_hit": 0,
            "active_now": 0,
            "stats": {},
            "outline": [],
            "first_contacts": [],
            "last_contacts": [],
        }
    )
    assert "unpkg.com" not in html
    assert "L.map" in html
    assert "leaflet" in html.lower() or "L.map" in html
