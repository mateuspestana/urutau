# Autor: Matheus C. Pestana
"""Autenticação do painel: cookie assinado, papéis admin/viewer, middleware e rotas.

Sem URUTAU_PASSWORD nem URUTAU_VIEW_PASSWORD a autenticação fica desligada (BIND local).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from . import store

COOKIE = "urutau_session"
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 dias
# HttpOnly · SameSite=Lax · Path=/ · sem Secure (painel em HTTP)
OPEN_PATHS = frozenset({"/api/health", "/api/auth/login", "/api/auth/me"})
# POST liberado para qualquer papel autenticado (viewer também sai)
LOGOUT_PATH = "/api/auth/logout"
WS_CLOSE_UNAUTHORIZED = 4401

Role = str  # "admin" | "viewer"


def _admin_pw() -> str:
    return os.environ.get("URUTAU_PASSWORD", "").strip()


def _view_pw() -> str:
    return os.environ.get("URUTAU_VIEW_PASSWORD", "").strip()


def auth_required() -> bool:
    """Ligado se qualquer senha estiver definida."""
    return bool(_admin_pw() or _view_pw())


def _secret_path():
    return store.DATA / "secret.key"


def secret_key() -> bytes:
    """32 bytes em /data/secret.key; cria na primeira chamada."""
    path = _secret_path()
    store.DATA.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        raw = path.read_bytes()
        if len(raw) >= 32:
            return raw[:32]
    key = secrets.token_bytes(32)
    path.write_bytes(key)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return key


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def issue_token(role: Role, now: float | None = None, ttl: int = COOKIE_MAX_AGE) -> str:
    """Token = base64url(role|exp) + '.' + HMAC-SHA256 (hex) do payload."""
    exp = int((now if now is not None else time.time()) + ttl)
    payload = _b64url(f"{role}|{exp}".encode())
    sig = hmac.new(secret_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify(token: str | None, now: float | None = None) -> Role | None:
    """Devolve o papel ou None se inválido/expirado/adulterado."""
    if not token or "." not in token:
        return None
    payload, sig = token.rsplit(".", 1)
    expect = hmac.new(secret_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        raw = _b64url_decode(payload).decode("utf-8")
        role, exp_s = raw.split("|", 1)
        exp = int(exp_s)
    except (ValueError, UnicodeDecodeError):
        return None
    if role not in ("admin", "viewer"):
        return None
    t = now if now is not None else time.time()
    if t >= exp:
        return None
    return role


def login(password: str) -> Role | None:
    """Compara com hmac.compare_digest; admin tem prioridade se as senhas coincidirem."""
    if not password:
        return None
    admin = _admin_pw()
    view = _view_pw()
    # compare_digest exige strings do mesmo comprimento — usa digest das senhas
    dig = hashlib.sha256(password.encode("utf-8")).digest()
    if admin and hmac.compare_digest(dig, hashlib.sha256(admin.encode("utf-8")).digest()):
        return "admin"
    if view and hmac.compare_digest(dig, hashlib.sha256(view.encode("utf-8")).digest()):
        return "viewer"
    return None


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
        secure=False,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def role_from_request(request: Request) -> Role | None:
    return verify(request.cookies.get(COOKIE))


def role_from_websocket(ws: WebSocket) -> Role | None:
    return verify(ws.cookies.get(COOKIE))


def client_ip(request: Request) -> str:
    """nginx envia X-Real-IP; fallback para o peer."""
    return (request.headers.get("x-real-ip") or "").strip() or (
        request.client.host if request.client else "unknown"
    )


# ---------- limite de tentativas (5 falhas/min por IP) ----------
_FAILS: dict[str, deque[float]] = defaultdict(deque)
_FAIL_WINDOW = 60.0
_FAIL_MAX = 5


def _prune_fails(ip: str, now: float) -> deque[float]:
    q = _FAILS[ip]
    while q and now - q[0] > _FAIL_WINDOW:
        q.popleft()
    return q


def rate_limited(ip: str, now: float | None = None) -> bool:
    t = now if now is not None else time.time()
    return len(_prune_fails(ip, t)) >= _FAIL_MAX


def record_fail(ip: str, now: float | None = None) -> None:
    t = now if now is not None else time.time()
    _prune_fails(ip, t).append(t)


def clear_fails(ip: str) -> None:
    _FAILS.pop(ip, None)


def reset_rate_limits() -> None:
    """Só para testes."""
    _FAILS.clear()


# ---------- middleware ----------
class AuthMiddleware(BaseHTTPMiddleware):
    """Se auth ligada: libera health/login/me; resto precisa de cookie; escrita = admin."""

    def __init__(self, app: ASGIApp):
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        if not auth_required():
            return await call_next(request)
        method = request.method.upper()
        if method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if path in OPEN_PATHS:
            return await call_next(request)
        role = role_from_request(request)
        if role is None:
            return JSONResponse({"detail": "não autenticado"}, status_code=401)
        if method not in ("GET", "HEAD") and path != LOGOUT_PATH and role != "admin":
            return JSONResponse({"detail": "somente leitura"}, status_code=403)
        return await call_next(request)


# ---------- rotas ----------
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    password: str = ""


@router.post("/login")
async def auth_login(body: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    if not auth_required():
        return {"ok": True, "auth_required": False, "role": None}
    ip = client_ip(request)
    if rate_limited(ip):
        raise HTTPException(429, "muitas tentativas; aguarde um minuto")
    role = login(body.password)
    if role is None:
        record_fail(ip)
        await asyncio.sleep(0.5)
        raise HTTPException(401, "senha incorreta")
    clear_fails(ip)
    set_session_cookie(response, issue_token(role))
    return {"ok": True, "auth_required": True, "role": role}


@router.post("/logout")
async def auth_logout(response: Response) -> dict[str, Any]:
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
async def auth_me(request: Request) -> dict[str, Any]:
    required = auth_required()
    role = role_from_request(request) if required else None
    if not required:
        return {"auth_required": False, "role": None}
    return {"auth_required": True, "role": role}


@router.get("/check")
async def auth_check(request: Request) -> Response:
    """204 se pode ler (ou auth desligada); 401 caso contrário. Usado pelo auth_request do nginx."""
    if not auth_required():
        return Response(status_code=204)
    if role_from_request(request) is None:
        return Response(status_code=401)
    return Response(status_code=204)


async def reject_ws_if_unauthorized(ws: WebSocket) -> Role | None:
    """Valida o cookie antes do accept. Fecha com 4401 se auth ligada e sem sessão.
    Devolve o papel (ou None se auth desligada)."""
    if not auth_required():
        return None
    role = role_from_websocket(ws)
    if role is None:
        # close antes do accept: Starlette envia o código de rejeição
        await ws.close(code=WS_CLOSE_UNAUTHORIZED)
        return None
    return role
