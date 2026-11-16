# Autor: Matheus C. Pestana
"""Assinatura, expiração, papéis, middleware, rate limit e WebSocket sem cookie."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth


@pytest.fixture(autouse=True)
def _clean_auth_env(tmp_path, monkeypatch):
    """Cada teste começa sem senhas e com secret novo; limpa o rate limit."""
    monkeypatch.setenv("URUTAU_DATA", str(tmp_path))
    # store.DATA já foi lido na importação do conftest; auth usa store.DATA
    monkeypatch.setattr(auth.store, "DATA", tmp_path)
    monkeypatch.delenv("URUTAU_PASSWORD", raising=False)
    monkeypatch.delenv("URUTAU_VIEW_PASSWORD", raising=False)
    auth.reset_rate_limits()
    yield
    auth.reset_rate_limits()
    monkeypatch.delenv("URUTAU_PASSWORD", raising=False)
    monkeypatch.delenv("URUTAU_VIEW_PASSWORD", raising=False)


def test_issue_e_verify_ok():
    tok = auth.issue_token("admin", now=1_000_000.0, ttl=3600)
    assert auth.verify(tok, now=1_000_100.0) == "admin"


def test_verify_expirado():
    tok = auth.issue_token("viewer", now=1_000.0, ttl=10)
    assert auth.verify(tok, now=1_020.0) is None


def test_verify_adulterado():
    tok = auth.issue_token("admin", now=1_000.0, ttl=3600)
    payload, sig = tok.rsplit(".", 1)
    # troca um nibble do HMAC
    bad = payload + "." + ("0" if sig[0] != "0" else "1") + sig[1:]
    assert auth.verify(bad, now=1_010.0) is None
    # troca o papel no payload sem resignar
    tampered = "YWRtaW58OTk5OTk5" + "." + sig  # lixo
    assert auth.verify(tampered, now=1_010.0) is None


def test_login_papeis(monkeypatch):
    monkeypatch.setenv("URUTAU_PASSWORD", "segredo-admin")
    monkeypatch.setenv("URUTAU_VIEW_PASSWORD", "so-ler")
    assert auth.login("segredo-admin") == "admin"
    assert auth.login("so-ler") == "viewer"
    assert auth.login("errada") is None
    assert auth.login("") is None


def test_auth_required_desligada():
    assert auth.auth_required() is False


def test_auth_required_ligada(monkeypatch):
    monkeypatch.setenv("URUTAU_VIEW_PASSWORD", "x")
    assert auth.auth_required() is True


def _mini_app() -> FastAPI:
    """FastAPI mínimo só com auth — não importa docker SDK / main."""
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(auth.router)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/status")
    def status():
        return {"mode": "idle"}

    @app.post("/api/mode")
    def mode():
        return {"ok": True}

    @app.websocket("/api/ws/audio")
    async def ws_audio(ws: WebSocket):
        if auth.auth_required():
            role = await auth.reject_ws_if_unauthorized(ws)
            if role is None:
                return
        await ws.accept()
        await ws.send_json({"type": "hello"})
        await ws.close()

    return app


def test_middleware_auth_desligada():
    client = TestClient(_mini_app())
    assert client.get("/api/status").status_code == 200
    assert client.post("/api/mode").status_code == 200
    assert client.get("/api/auth/check").status_code == 204
    me = client.get("/api/auth/me").json()
    assert me == {"auth_required": False, "role": None}


def test_middleware_matriz(monkeypatch):
    monkeypatch.setenv("URUTAU_PASSWORD", "admin-pw")
    monkeypatch.setenv("URUTAU_VIEW_PASSWORD", "view-pw")
    client = TestClient(_mini_app())

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/auth/me").json()["auth_required"] is True
    assert client.get("/api/auth/check").status_code == 401

    # login admin
    r = client.post("/api/auth/login", json={"password": "admin-pw"})
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    assert client.get("/api/status").status_code == 200
    assert client.post("/api/mode").status_code == 200
    assert client.get("/api/auth/check").status_code == 204

    client.post("/api/auth/logout")
    assert client.get("/api/status").status_code == 401

    # viewer: lê, não escreve
    r = client.post("/api/auth/login", json={"password": "view-pw"})
    assert r.json()["role"] == "viewer"
    assert client.get("/api/status").status_code == 200
    assert client.post("/api/mode").status_code == 403
    assert client.post("/api/auth/logout").status_code == 200


def test_rate_limit(monkeypatch):
    monkeypatch.setenv("URUTAU_PASSWORD", "certo")
    client = TestClient(_mini_app())
    # evita o sleep de 0,5 s × 5 nos testes
    async def _nosleep(_):
        return None

    monkeypatch.setattr(asyncio, "sleep", _nosleep)

    for _ in range(5):
        r = client.post(
            "/api/auth/login",
            json={"password": "errada"},
            headers={"X-Real-IP": "203.0.113.9"},
        )
        assert r.status_code == 401
    r = client.post(
        "/api/auth/login",
        json={"password": "errada"},
        headers={"X-Real-IP": "203.0.113.9"},
    )
    assert r.status_code == 429
    # outro IP ainda pode tentar
    r = client.post(
        "/api/auth/login",
        json={"password": "errada"},
        headers={"X-Real-IP": "203.0.113.10"},
    )
    assert r.status_code == 401


def test_ws_rejeita_sem_cookie(monkeypatch):
    monkeypatch.setenv("URUTAU_PASSWORD", "admin-pw")
    client = TestClient(_mini_app())
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/api/ws/audio") as ws:
            ws.receive_json()
    assert ei.value.code == auth.WS_CLOSE_UNAUTHORIZED


def test_ws_viewer_pode_ouvir(monkeypatch):
    monkeypatch.setenv("URUTAU_PASSWORD", "admin-pw")
    monkeypatch.setenv("URUTAU_VIEW_PASSWORD", "view-pw")
    client = TestClient(_mini_app())
    r = client.post("/api/auth/login", json={"password": "view-pw"})
    assert r.status_code == 200
    assert auth.COOKIE in client.cookies
    with client.websocket_connect("/api/ws/audio") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "hello"
