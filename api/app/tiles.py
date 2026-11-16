# Autor: Matheus C. Pestana
"""Cache de blocos de mapa (/data/tiles) e servir PMTiles locais (/data/maps).

O navegador só fala com a API; a API busca no provedor se o bloco ainda não estiver
em disco. Limite: config `tiles_max_mb` (descarte do mais antigo por mtime).

PMTiles offline: coloque `*.pmtiles` em /data/maps/. Gerar um recorte (docs no README):
  pmtiles extract https://build.protomaps.com/<AAAAMMDD>.pmtiles regiao.pmtiles \\
    --bbox=<oeste>,<sul>,<leste>,<norte>
Licença dos dados: ODbL (OpenStreetMap) + atribuição Protomaps.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response

from . import store

# provedores = os mesmos de web/src/mapBase.ts (whitelist; nada de path traversal)
# Esri usa {z}/{y}/{x}; OSM usa {z}/{x}/{y}. A rota da API é sempre z/x/y.
PROVIDERS: dict[str, dict[str, Any]] = {
    "osm-hot": {
        "url": "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
        "max_zoom": 19,
    },
    "esri-dark": {
        "url": (
            "https://server.arcgisonline.com/ArcGIS/rest/services/"
            "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        ),
        "max_zoom": 16,
    },
    "esri-light": {
        "url": (
            "https://server.arcgisonline.com/ArcGIS/rest/services/"
            "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        ),
        "max_zoom": 16,
    },
    "esri-sat": {
        "url": (
            "https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ),
        "max_zoom": 19,
    },
}

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_UA = "Urutau/0.3 (RTL-SDR station; tile cache; +https://github.com/mateuspestana/urutau)"


def tiles_dir() -> Path:
    return store.DATA / "tiles"


def maps_dir() -> Path:
    return store.DATA / "maps"


def tiles_max_bytes() -> int:
    cfg = store.load_config()
    try:
        mb = float(cfg.get("tiles_max_mb") or 512)
    except (TypeError, ValueError):
        mb = 512.0
    return max(1, int(mb * 1024 * 1024))


def validate_tile(provider: str, z: int, x: int, y: int) -> str | None:
    """Devolve mensagem de erro ou None se ok. Bloqueia `..` e provedor desconhecido."""
    if not provider or ".." in provider or "/" in provider or "\\" in provider:
        return "provedor inválido"
    if provider not in PROVIDERS:
        return "provedor desconhecido"
    meta = PROVIDERS[provider]
    max_z = int(meta["max_zoom"])
    if not isinstance(z, int) or not isinstance(x, int) or not isinstance(y, int):
        return "coordenadas inválidas"
    if z < 0 or z > max_z:
        return "zoom fora do intervalo"
    lim = 1 << z
    if x < 0 or y < 0 or x >= lim or y >= lim:
        return "bloco fora do intervalo"
    return None


def tile_cache_path(provider: str, z: int, x: int, y: int) -> Path | None:
    if validate_tile(provider, z, x, y):
        return None
    return tiles_dir() / provider / str(z) / str(x) / f"{y}.png"


def upstream_url(provider: str, z: int, x: int, y: int) -> str | None:
    if validate_tile(provider, z, x, y):
        return None
    return PROVIDERS[provider]["url"].format(z=z, x=x, y=y)


def cache_size_bytes(root: Path | None = None) -> int:
    base = root or tiles_dir()
    if not base.is_dir():
        return 0
    total = 0
    for p in base.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def enforce_quota(root: Path | None = None, limit: int | None = None) -> int:
    """Apaga os arquivos mais antigos (mtime) até caber em `limit`. Devolve quantos apagou."""
    base = root or tiles_dir()
    cap = limit if limit is not None else tiles_max_bytes()
    if not base.is_dir():
        return 0
    files: list[tuple[float, int, Path]] = []
    for p in base.rglob("*"):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        files.append((st.st_mtime, st.st_size, p))
    total = sum(sz for _, sz, _ in files)
    if total <= cap:
        return 0
    files.sort(key=lambda t: t[0])  # mais antigo primeiro
    removed = 0
    for _, sz, p in files:
        if total <= cap:
            break
        try:
            p.unlink()
            total -= sz
            removed += 1
        except OSError:
            pass
    return removed


async def fetch_and_cache(provider: str, z: int, x: int, y: int) -> bytes:
    """Serve do disco se existir; senão busca no provedor, grava e devolve."""
    err = validate_tile(provider, z, x, y)
    if err:
        raise HTTPException(400, err)
    path = tile_cache_path(provider, z, x, y)
    assert path is not None
    if path.is_file():
        try:
            path.touch()  # LRU aproximado via mtime
        except OSError:
            pass
        return path.read_bytes()

    url = upstream_url(provider, z, x, y)
    assert url is not None
    try:
        async with httpx.AsyncClient(timeout=20.0, headers={"User-Agent": _UA}) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"falha ao buscar bloco: {e}") from e
    if r.status_code != 200:
        raise HTTPException(502, f"provedor respondeu {r.status_code}")
    body = r.content
    if not body:
        raise HTTPException(502, "bloco vazio")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".png.part")
    try:
        tmp.write_bytes(body)
        tmp.replace(path)
    except OSError:
        # se não gravar, ainda serve esta resposta
        pass
    else:
        enforce_quota()
    return body


def safe_pmtiles_name(name: str) -> str | None:
    """Nome sem sufixo .pmtiles; bloqueia `..` e caracteres estranhos."""
    raw = name.strip()
    if raw.lower().endswith(".pmtiles"):
        raw = raw[: -len(".pmtiles")]
    if not raw or ".." in raw or "/" in raw or "\\" in raw:
        return None
    if not _NAME_RE.match(raw):
        return None
    return raw


def pmtiles_path(name: str) -> Path | None:
    safe = safe_pmtiles_name(name)
    if not safe:
        return None
    try:
        base = maps_dir().resolve()
        p = (maps_dir() / f"{safe}.pmtiles").resolve()
    except OSError:
        return None
    if p.parent != base or not p.is_file():
        return None
    return p


def list_pmtiles() -> list[dict[str, Any]]:
    d = maps_dir()
    if not d.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(d.glob("*.pmtiles")):
        safe = safe_pmtiles_name(p.stem)
        if not safe:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": safe, "bytes": st.st_size, "mtime": int(st.st_mtime)})
    return out


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def pmtiles_response(path: Path, request: Request) -> Response:
    """GET com suporte a Range (necessário para a biblioteca pmtiles)."""
    try:
        size = path.stat().st_size
    except OSError as e:
        raise HTTPException(404, "arquivo ausente") from e

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": "application/vnd.pmtiles",
        "Cache-Control": "public, max-age=3600",
    }
    range_hdr = request.headers.get("range") or request.headers.get("Range")
    if not range_hdr:
        return FileResponse(
            path,
            media_type="application/vnd.pmtiles",
            headers=headers,
            filename=path.name,
        )

    parsed = parse_range_spec(range_hdr, size)
    if parsed is None:
        raise HTTPException(
            status_code=416,
            detail="Range inválido",
            headers={"Content-Range": f"bytes */{size}"},
        )
    start, end = parsed
    length = end - start + 1
    try:
        with path.open("rb") as f:
            f.seek(start)
            chunk = f.read(length)
    except OSError as e:
        raise HTTPException(404, "arquivo ausente") from e
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(len(chunk))
    return Response(
        content=chunk,
        status_code=206,
        media_type="application/vnd.pmtiles",
        headers=headers,
    )


def parse_range_spec(range_hdr: str, size: int) -> tuple[int, int] | None:
    """Utilitário testável: (start, end) inclusivo, ou None se inválido."""
    m = _RANGE_RE.fullmatch(range_hdr.strip())
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        length = int(end_s)
        if length <= 0:
            return None
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s != "" else size - 1
    if start < 0 or end < start or start >= size:
        return None
    return start, min(end, size - 1)
