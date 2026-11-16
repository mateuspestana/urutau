# Autor: Matheus C. Pestana
"""Regras de alerta, deduplicação e banco — sem dongle/Docker/rede."""
from app import alerts, obs, store


def setup_function():
    alerts.reset_for_tests()
    # limpa localização e regras para não vazar para outros módulos (test_store etc.)
    store.save_config({"lat": None, "lon": None, "alerts": {}})


def teardown_function():
    store.save_config({"lat": None, "lon": None, "alerts": {}})


def test_squawk_emergencia():
    out = alerts.on_aircraft([
        {"hex": "abc123", "flight": "TAM1234", "squawk": "7700", "lat": -15.8, "lon": -47.9, "alt_baro": 5000},
        {"hex": "def456", "flight": "GLO99", "squawk": "1200", "lat": -15.8, "lon": -47.9, "alt_baro": 5000},
    ])
    assert len(out) == 1
    assert out[0]["kind"] == "squawk"
    assert out[0]["detail"]["squawk"] == "7700"
    items = alerts.list_alerts()
    assert len(items) == 1


def test_squawk_dedup_silencio_30min():
    a = {"hex": "abc123", "flight": "TAM1", "squawk": "7600", "lat": -15.8, "lon": -47.9}
    t0 = 1_700_000_000.0
    assert alerts.on_aircraft([a], now=t0)
    assert not alerts.on_aircraft([a], now=t0 + 60)  # ainda no silêncio
    assert alerts.on_aircraft([a], now=t0 + 1801)  # após 30 min


def test_military():
    out = alerts.on_aircraft([
        {"hex": "ae1234", "flight": "RCH001", "military": True, "lat": -15.8, "lon": -47.9},
        {"hex": "e48000", "flight": "TAM99", "military": False, "lat": -15.8, "lon": -47.9},
    ])
    assert len(out) == 1
    assert out[0]["kind"] == "military"
    assert out[0]["key"] == "ae1234"


def test_watchlist_hex_reg_flight():
    alerts.save_rules({
        "watchlist_hex": ["abc123"],
        "watchlist_reg": ["PR-ABC"],
        "watchlist_flight": ["TAM"],
    })
    out = alerts.on_aircraft([
        {"hex": "abc123", "flight": "XXX", "r": "PP-ZZZ"},
        {"hex": "111111", "flight": "YYY", "r": "PR-ABC"},
        {"hex": "222222", "flight": "TAM4567", "r": "PP-QQQ"},
        {"hex": "333333", "flight": "GLO1", "r": "PP-WWW"},
    ])
    kinds_keys = {(r["kind"], r["key"]) for r in out}
    assert ("watchlist", "abc123") in kinds_keys
    assert ("watchlist", "111111") in kinds_keys
    assert ("watchlist", "222222") in kinds_keys
    assert ("watchlist", "333333") not in kinds_keys


def test_low_near():
    store.save_config({"lat": -15.799, "lon": -47.864})
    # receptor em -15.799, -47.864; ponto ~1 km ao norte, baixo
    out = alerts.on_aircraft([{
        "hex": "low001", "flight": "LOW1",
        "lat": -15.790, "lon": -47.864, "alt_baro": 800,
    }])
    assert len(out) == 1
    assert out[0]["kind"] == "low_near"
    # alto demais
    assert not alerts.on_aircraft([{
        "hex": "high01", "flight": "HI1",
        "lat": -15.790, "lon": -47.864, "alt_baro": 10000,
    }])
    # longe
    assert not alerts.on_aircraft([{
        "hex": "far001", "flight": "FAR1",
        "lat": -16.5, "lon": -47.864, "alt_baro": 500,
    }])


def test_new_ship_via_obs():
    obs.init()
    out = alerts.on_obs("ais", "710000001", {"shipname": "BARCA"}, lat=-23.9, lon=-46.3, is_new=True)
    assert len(out) == 1
    assert out[0]["kind"] == "new_ship"
    # segunda vez (não novo) não alerta
    assert not alerts.on_obs("ais", "710000001", {"shipname": "BARCA"}, is_new=False)


def test_sonde_new_e_descending():
    store.save_config({"lat": -15.799, "lon": -47.864, "alerts": {}})
    near = {"model": "RS41", "vel_v": -3.2}
    out = alerts.on_obs(
        "sonde", "S123", near, lat=-15.80, lon=-47.87, alt=5000, is_new=True,
    )
    kinds = {r["kind"] for r in out}
    assert "sonde_new" in kinds
    assert "sonde_descending" in kinds
    # longe: nem nova nem descendo
    far = alerts.on_obs(
        "sonde", "S999", {"vel_v": -2.0}, lat=-10.0, lon=-40.0, alt=1000, is_new=True,
    )
    assert far == []


def test_sat_ok():
    row = alerts.on_sat_ok("2026-11-16_meteor", sat="meteor-m2-3", images=2)
    assert row and row["kind"] == "sat_ok"
    assert alerts.on_sat_ok("2026-11-16_meteor", sat="meteor-m2-3", images=2) is None  # dedup key=dir
    alerts.save_rules({"sat_ok": False})
    assert alerts.on_sat_ok("other_dir", images=1) is None


def test_mark_seen_e_list():
    alerts.emit("squawk", "a:7700", "t1", {})
    alerts.emit("military", "b", "t2", {})
    assert alerts.unseen_count() == 2
    items = alerts.list_alerts(limit=10)
    assert len(items) == 2
    first_id = items[-1]["id"]  # mais antigo (ORDER BY id DESC → último da lista invertida)
    # mark one
    alerts.mark_seen([items[0]["id"]])
    assert alerts.unseen_count() == 1
    alerts.mark_seen(all_unseen=True)
    assert alerts.unseen_count() == 0
    after = alerts.list_alerts(after_id=first_id)
    assert all(i["id"] > first_id for i in after)


def test_rules_persist():
    saved = alerts.save_rules({
        "emergency_squawk": False,
        "low_near_km": 12.5,
        "watchlist_hex": ["abcd"],
        "silence_s": {"squawk": 60},
    })
    assert saved["emergency_squawk"] is False
    assert saved["low_near_km"] == 12.5
    assert saved["watchlist_hex"] == ["ABCD"]
    assert saved["silence_s"]["squawk"] == 60
    # militar continua padrão
    assert saved["military"] is True
    again = alerts.rules()
    assert again["watchlist_hex"] == ["ABCD"]


def test_regra_desligada():
    alerts.save_rules({"emergency_squawk": False, "military": False})
    assert not alerts.on_aircraft([
        {"hex": "x", "squawk": "7500", "military": True, "flight": "X"},
    ])
