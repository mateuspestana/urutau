# Autor: Matheus C. Pestana
"""Checagem de versão: semver, ETag/304, desligado = sem pedido."""
from __future__ import annotations

import asyncio

import httpx

from app import store, update_check


def test_semver_mais_nova():
    assert update_check.is_newer("0.4.0", "0.3.0")
    assert update_check.is_newer("v1.0.0", "0.9.9")
    assert not update_check.is_newer("0.3.0", "0.3.0")
    assert not update_check.is_newer("0.2.9", "0.3.0")
    assert update_check.parse_version("v0.4.0") == (0, 4, 0)
    assert update_check.parse_version("nope") is None


def test_desligado_nao_requisita():
    store.save_config({"update_check": False})
    called = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)

    async def run() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            out = await update_check.check_once(client)
        assert called["n"] == 0
        assert out["enabled"] is False
        assert out["current"]

    asyncio.run(run())


def test_etag_304():
    store.save_config({"update_check": True})
    update_check._save_cache({
        "latest": "0.9.0",
        "url": "https://example.test/r",
        "notes_excerpt": "oi",
        "etag": '"abc"',
        "checked_at": 1.0,
    })
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("if-none-match"))
        assert request.headers.get("user-agent") == update_check.USER_AGENT
        return httpx.Response(304)

    transport = httpx.MockTransport(handler)

    async def run() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            out = await update_check.check_once(client)
        assert seen == ['"abc"']
        assert out["latest"] == "0.9.0"
        assert out["checked_at"] and out["checked_at"] > 1.0

    asyncio.run(run())


def test_atualiza_cache_200():
    store.save_config({"update_check": True})
    update_check._save_cache({})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"ETag": '"xyz"'},
            json={
                "tag_name": "v0.4.0",
                "html_url": "https://github.com/mateuspestana/urutau/releases/tag/v0.4.0",
                "body": "Notas da 0.4.0",
            },
        )

    transport = httpx.MockTransport(handler)

    async def run() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            out = await update_check.check_once(client)
        assert out["latest"] == "0.4.0"
        assert out["url"] and "releases" in out["url"]
        assert out["notes_excerpt"] == "Notas da 0.4.0"
        cache = update_check._load_cache()
        assert cache.get("etag") == '"xyz"'

    asyncio.run(run())
