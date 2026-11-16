# Autor: Matheus C. Pestana
"""Exportação CSV/JSONL e retenção (corte, simulação, lotes)."""
from __future__ import annotations

import csv
import io
import json
import time

import pytest

from app import alerts, datalink, export, flightlog, obs, retention


@pytest.fixture(autouse=True)
def _dbs():
    flightlog.init()
    datalink.init()
    obs.init()
    alerts.init()
    with flightlog._lock:
        flightlog._db().executescript(
            "DELETE FROM positions; DELETE FROM sightings; DELETE FROM station_events;"
        )
        flightlog._db().commit()
    with datalink._lock:
        datalink._db().execute("DELETE FROM messages")
        datalink._db().commit()
    with obs._lock:
        obs._db().executescript("DELETE FROM tracks; DELETE FROM messages; DELETE FROM objects;")
        obs._db().commit()
    with alerts._lock:
        alerts._db().execute("DELETE FROM alerts")
        alerts._db().commit()
    yield
    flightlog.close()
    datalink.close()
    obs.close()
    alerts.close()


def _insert_sighting(ts: float, hex_id: str = "abc123") -> int:
    with flightlog._lock:
        db = flightlog._db()
        cur = db.execute(
            "INSERT INTO sightings(hex, first_ts, last_ts, messages, samples, pos_samples) "
            "VALUES (?,?,?,1,1,0)",
            (hex_id, ts, ts + 10),
        )
        db.commit()
        return int(cur.lastrowid)


def test_retention_so_apaga_antes_do_corte():
    now = time.time()
    old_id = _insert_sighting(now - 10 * 86400, "old001")
    new_id = _insert_sighting(now - 1 * 86400, "new001")
    cfg = {**retention.DEFAULT_RETENTION, "sightings": 5, "positions": None, "events": None}
    sim = retention.simulate(cfg)
    assert sim["sightings"] == 1
    result = retention.run(cfg, vacuum=False)
    assert result["deleted"]["sightings"] == 1
    with flightlog._lock:
        left = {r["id"] for r in flightlog._db().execute("SELECT id FROM sightings").fetchall()}
    assert old_id not in left
    assert new_id in left


def test_simulacao_bate_com_execucao():
    now = time.time()
    with datalink._lock:
        db = datalink._db()
        for age in (40, 10, 5):
            db.execute(
                "INSERT INTO messages(ts, source, kind, raw) VALUES (?,?,?,?)",
                (now - age * 86400, "acars", "acars", "{}"),
            )
        db.commit()
    cfg = {**retention.DEFAULT_RETENTION, "datalink": 30}
    sim = retention.simulate(cfg)
    assert sim["datalink"] == 1
    result = retention.run(cfg, vacuum=False)
    assert result["deleted"]["datalink"] == sim["datalink"]
    assert retention.simulate(cfg)["datalink"] == 0


def test_csv_cabecalho_e_linhas():
    now = time.time()
    _insert_sighting(now - 100, "cafefe")
    _insert_sighting(now - 50, "beef01")
    text = "".join(export.iter_csv("sightings"))
    rows = list(csv.DictReader(io.StringIO(text)))
    assert "hex" in (csv.DictReader(io.StringIO(text)).fieldnames or [])
    assert len(rows) == 2
    hexes = {r["hex"] for r in rows}
    assert hexes == {"cafefe", "beef01"}


def test_jsonl_obs_aninhado():
    obs.record("aprs", "PY1ABC", {"comment": "oi"}, lat=-15.8, lon=-47.9, text="PY1ABC>oi", keep_message=True)
    lines = list(export.iter_jsonl("aprs"))
    assert lines
    obj = json.loads(lines[0])
    assert obj["kind"] == "object"
    assert isinstance(obj["data"], dict)


def test_parquet_desligado():
    with pytest.raises(ValueError, match="parquet"):
        export.stream("sightings", "parquet")


def test_retention_nunca_por_padrao_sightings():
    cfg = retention.retention_cfg()
    assert cfg["sightings"] is None
    assert cfg["positions"] is None
    assert cfg["range"] is None
    assert cfg["sat_empty"] == 7
