"""Real API coverage for remote authentication, preflights and local access restrictions."""

import stat
import logging

import pytest
from fastapi.testclient import TestClient

from easycfd import runner, storage
from easycfd.api import app
from easycfd.access import connection_url


@pytest.fixture
def remote(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "start", lambda: None)
    monkeypatch.setattr(runner, "stop", lambda: None)
    monkeypatch.setattr(runner, "health", lambda: {"ready": True})
    monkeypatch.setenv("EASYCFD_REMOTE", "true")
    monkeypatch.setenv("EASYCFD_API_TOKEN", "test-secret-✓")
    monkeypatch.setenv("EASYCFD_CORS_ORIGINS", "https://easy-cfd.mthracelab.com")
    app.middleware_stack = None
    with TestClient(app, base_url="https://backend.example") as client:
        yield client
    app.middleware_stack = None


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/health"), ("GET", "/api/runs"), ("POST", "/api/projects"),
    ("GET", "/api/runs/" + "a" * 32 + "/geometry/part0.stl"),
    ("POST", "/api/runs/" + "a" * 32 + "/cancel"),
    ("POST", "/api/compute-lease"),
])
def test_every_api_requires_token(remote, method, path):
    assert remote.request(method, path).status_code == 401
    assert remote.request(method, path, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_query_token_and_cors_on_errors(remote):
    origin = {"Origin": "https://easy-cfd.mthracelab.com"}
    assert remote.get("/api/health", params={"token": "test-secret-✓"}, headers=origin).status_code == 200
    bad = remote.get("/api/health", headers=origin)
    assert bad.status_code == 401
    assert bad.headers["access-control-allow-origin"] == origin["Origin"]
    assert bad.headers["cache-control"] == "no-store"
    assert remote.get("/?token=test-secret").status_code == 404


def test_preflight_requires_no_token_but_actual_request_does(remote):
    headers = {
        "Origin": "https://easy-cfd.mthracelab.com", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,ngrok-skip-browser-warning",
    }
    response = remote.options("/api/projects", headers=headers)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == headers["Origin"]
    assert "access-control-allow-credentials" not in response.headers
    headers["Origin"] = "https://untrusted.example"
    assert remote.options("/api/projects", headers=headers).status_code == 400


@pytest.mark.parametrize("origins", [None, "", "*"])
def test_default_cors_allows_any_frontend_origin_and_backend_hostname(remote, monkeypatch, origins):
    if origins is None:
        monkeypatch.delenv("EASYCFD_CORS_ORIGINS")
    else:
        monkeypatch.setenv("EASYCFD_CORS_ORIGINS", origins)
    app.middleware_stack = None
    with TestClient(app) as client:
        for origin, host in [
            ("https://easy-cfd.mthracelab.com", "arbitrary.ngrok-free.dev"),
            ("https://my-frontend.example:9443", "cfd.some-other-domain.example:8443"),
            ("http://localhost:5173", "127.0.0.1:8000"),
        ]:
            headers = {"Origin": origin, "Host": host}
            preflight = client.options("/api/projects", headers={
                **headers, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type,ngrok-skip-browser-warning",
            })
            assert preflight.status_code == 200
            assert preflight.headers["access-control-allow-origin"] == "*"
            response = client.get("/api/health", params={"token": "test-secret-✓"}, headers=headers)
            assert response.status_code == 200
            assert response.headers["access-control-allow-origin"] == "*"
            unauthenticated = client.get("/api/health", headers=headers)
            assert unauthenticated.status_code == 401
            assert unauthenticated.headers["access-control-allow-origin"] == "*"


def test_startup_prints_a_copyable_public_url(remote, monkeypatch, caplog):
    monkeypatch.setenv("EASYCFD_PUBLIC_URL", "https://my-cfd.example/proxy/api/")
    app.middleware_stack = None
    with caplog.at_level(logging.INFO, logger="uvicorn.error"), TestClient(app):
        assert "https://my-cfd.example/proxy/api?token=test-secret-%E2%9C%93" in caplog.text
        assert "Paste this URL into the frontend" in caplog.text


def test_startup_url_encoding_and_validation():
    assert connection_url("http://localhost:9000/", "a+b=c &") == "http://localhost:9000?token=a%2Bb%3Dc%20%26"
    for bad in ["http://internet.example", "https://user:pass@example.com", "https://example.com?token=x", "https://example.com#x"]:
        with pytest.raises(ValueError):
            connection_url(bad, "secret")


def test_random_token_persists_and_bearer_protects_real_project(remote, monkeypatch, tmp_path):
    monkeypatch.delenv("EASYCFD_API_TOKEN")
    app.middleware_stack = None
    with TestClient(app, base_url="https://backend.example") as client:
        token_file = tmp_path / ".api-token"
        token = token_file.read_text().strip()
        assert len(token) >= 32
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
        headers = {"Authorization": f"Bearer {token}"}
        project = client.post("/api/projects", json={"name": "Remote test", "sample": False}, headers=headers)
        assert project.status_code == 201
        key = project.json()["id"]
        assert client.get(f"/api/projects/{key}").status_code == 401
        assert client.get(f"/api/projects/{key}", headers=headers).status_code == 200
    app.middleware_stack = None
    with TestClient(app, base_url="https://backend.example") as client:
        assert client.get("/api/health", headers=headers).status_code == 200
        assert token_file.read_text().strip() == token


def test_default_mode_remains_local(remote, monkeypatch):
    monkeypatch.delenv("EASYCFD_REMOTE")
    app.middleware_stack = None
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/health", headers={"Host": "internet.example"}).status_code == 403
        assert client.get("/api/health", headers={"Origin": "https://internet.example"}).status_code == 403


def test_container_maps_case_path_to_docker_host(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setenv("EASYCFD_HOST_DATA", "/host/cfd-data")
    case = tmp_path / "runs" / ("a" * 32) / "case-fast"
    args = runner.container("test", case, ["simpleFoam"], 2, 4)
    assert args[args.index("--mount") + 1] == f"type=bind,source=/host/cfd-data/runs/{'a' * 32}/case-fast,target=/case"
