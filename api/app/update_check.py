# Autor: Matheus C. Pestana
"""Aviso de nova versão (desligado por padrão).

Se `update_check` estiver ligado, consulta o GitHub uma vez por dia
(`User-Agent: urutau-update-check`). Nunca atualiza sozinho.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timedelta
from typing import Any

import httpx

from . import __version__, store

UPDATE_URL = "https://api.github.com/repos/mateuspestana/urutau/releases/latest"
UPDATE_PATH = store.DATA / "update.json"
USER_AGENT = "urutau-update-check"
_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def parse_version(s: str) -> tuple[int, int, int] | None:
    m = _SEMVER.match((s or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    if not a or not b:
        return False
    return a > b


def _load_cache() -> dict[str, Any]:
    if not UPDATE_PATH.exists():
        return {}
    try:
        return json.loads(UPDATE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def _save_cache(data: dict[str, Any]) -> None:
    store.DATA.mkdir(parents=True, exist_ok=True)
    UPDATE_PATH.write_text(json.dumps(data, indent=2))


def status() -> dict[str, Any]:
    cfg = store.load_config()
    enabled = bool(cfg.get("update_check"))
    cache = _load_cache()
    current = __version__
    latest = cache.get("latest")
    return {
        "enabled": enabled,
        "current": current,
        "latest": latest,
        "newer": bool(latest and is_newer(str(latest), current)),
        "url": cache.get("url"),
        "notes_excerpt": cache.get("notes_excerpt"),
        "checked_at": cache.get("checked_at"),
    }


async def check_once(client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """Consulta releases/latest com If-None-Match. Só faz pedido se update_check=True."""
    if not store.load_config().get("update_check"):
        return status()
    cache = _load_cache()
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    etag = cache.get("etag")
    if etag:
        headers["If-None-Match"] = etag
    own = client is None
    if own:
        client = httpx.AsyncClient(timeout=20.0)
    try:
        r = await client.get(UPDATE_URL, headers=headers)
        now = time.time()
        if r.status_code == 304:
            cache["checked_at"] = now
            _save_cache(cache)
            return status()
        r.raise_for_status()
        data = r.json()
        tag = str(data.get("tag_name") or "")
        body = str(data.get("body") or "")
        excerpt = body.strip().replace("\r\n", "\n")
        if len(excerpt) > 400:
            excerpt = excerpt[:397] + "…"
        cache = {
            "latest": tag.lstrip("v"),
            "url": data.get("html_url") or f"https://github.com/mateuspestana/urutau/releases/tag/{tag}",
            "notes_excerpt": excerpt,
            "etag": r.headers.get("ETag") or cache.get("etag"),
            "checked_at": now,
        }
        _save_cache(cache)
        return status()
    finally:
        if own:
            await client.aclose()


async def update_loop() -> None:
    """Checagem diária (e uma vez ~1 min após subir, se ligado)."""
    await asyncio.sleep(60)
    while True:
        try:
            if store.load_config().get("update_check"):
                await check_once()
        except Exception:
            pass
        now = datetime.now()
        target = now.replace(hour=4, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        await asyncio.sleep(max(60.0, (target - now).total_seconds()))
