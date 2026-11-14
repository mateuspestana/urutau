# Autor: Matheus C. Pestana
"""Lookup de matrícula/tipo/operador usando o banco que o tar1090 já serve.

O readsb deste ultrafeeder não tem --db-file, então o aircraft.json não traz `r`/`t`.
O tar1090 resolve isso no navegador com arquivos gzip-JSON em /db-<versão>/:
  <PREFIXO>.js  → {resto_do_hex: [reg, type, flags, desc], "children": [prefixos mais longos]}
  icao_aircraft_types2.js → {type: [desc, classe (ex. L2J), wtc]}
  operators.js → {ICAO 3 letras: {n: nome, c: país, r: radiotelefonia}}
Aqui fazemos o mesmo no servidor, com cache em memória.
"""
from __future__ import annotations

import gzip
import json
import re
from typing import Any

import httpx

_base: str | None = None
_folder: str | None = None
_shards: dict[str, dict[str, Any]] = {}
_missing: set[str] = set()
_types: dict[str, list[Any]] | None = None
_operators: dict[str, dict[str, str]] | None = None
_hex_cache: dict[str, dict[str, Any] | None] = {}


async def _get_json(client: httpx.AsyncClient, path: str) -> dict[str, Any] | None:
    r = await client.get(f"{_base}/{_folder}/{path}")
    if r.status_code != 200:
        return None
    raw = r.content
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


async def _ensure_folder(client: httpx.AsyncClient, base: str) -> bool:
    global _base, _folder
    if _folder and _base == base:
        return True
    _base = base
    r = await client.get(f"{base}/")
    m = re.search(r'databaseFolder\s*=\s*"([^"]+)"', r.text)
    if not m:
        return False
    _folder = m.group(1)
    _shards.clear()
    _missing.clear()
    _hex_cache.clear()
    return True


async def _shard(client: httpx.AsyncClient, prefix: str) -> dict[str, Any] | None:
    if prefix in _shards:
        return _shards[prefix]
    if prefix in _missing:
        return None
    d = await _get_json(client, f"{prefix}.js")
    if d is None:
        _missing.add(prefix)
        return None
    _shards[prefix] = d
    return d


async def _lookup_hex(client: httpx.AsyncClient, hex_id: str) -> dict[str, Any] | None:
    h = hex_id.upper()
    if h in _hex_cache:
        return _hex_cache[h]
    result = None
    prefix = h[:1]
    d = await _shard(client, prefix)
    while d is not None:
        child = next((c for c in d.get("children") or [] if h.startswith(c)), None)
        if child is None:
            rec = d.get(h[len(prefix):])
            if rec:
                reg, typ, flags, desc = (list(rec) + [None] * 4)[:4]
                flags = flags or "00"
                result = {
                    "r": reg or None,
                    "t": typ or None,
                    "desc": desc or None,
                    "military": flags[:1] == "1",
                    "interesting": flags[1:2] == "1",
                }
            break
        prefix = child
        d = await _shard(client, prefix)
    _hex_cache[h] = result
    return result


async def enrich(aircraft: list[dict[str, Any]], base: str = "http://ultrafeeder") -> list[dict[str, Any]]:
    """Acrescenta r/t/desc/military/type_info/operator in-place. Falha silenciosa."""
    global _types, _operators
    if not aircraft:
        return aircraft
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if not await _ensure_folder(client, base):
                return aircraft
            if _types is None:
                _types = await _get_json(client, "icao_aircraft_types2.js") or {}
            if _operators is None:
                _operators = await _get_json(client, "operators.js") or {}
            for a in aircraft:
                hex_id = (a.get("hex") or "").lstrip("~")
                if not hex_id:
                    continue
                info = await _lookup_hex(client, hex_id)
                if info:
                    for k, v in info.items():
                        if v is not None:
                            a.setdefault(k, v)
                t = a.get("t")
                if t and t in _types:
                    desc, cls, wtc = (list(_types[t]) + [None] * 3)[:3]
                    a["type_info"] = {"desc": desc, "class": cls, "wtc": wtc}
                    a.setdefault("desc", desc)
                cs = (a.get("flight") or "").strip()
                if len(cs) >= 4 and cs[:3].isalpha() and cs[3:4].isdigit():
                    op = _operators.get(cs[:3].upper())
                    if op:
                        a["operator"] = {"icao": cs[:3].upper(), "name": op.get("n"),
                                         "country": op.get("c"), "callsign": op.get("r")}
    except Exception as e:  # banco é bônus; nunca derruba o proxy
        print(f"aircraftdb: {e}", flush=True)
    return aircraft


def status() -> dict[str, Any]:
    return {"folder": _folder, "shards": len(_shards), "cached_hex": len(_hex_cache)}
