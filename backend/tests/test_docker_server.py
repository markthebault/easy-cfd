"""The self-contained image starts with its bundled tools and no Docker commands."""

import pytest

from easycfd import docker_server


def test_bundled_runtime_starts_api(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(docker_server.local_solver, "health", lambda: dict(ready=True))
    monkeypatch.setattr(docker_server.os, "execvp", lambda executable, args: calls.append(args))
    docker_server.main()
    assert calls == [["uvicorn", "easycfd.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]]
    assert "Bundled OpenFOAM v2412 and MPI are ready" in capsys.readouterr().out


def test_missing_bundled_tools_does_not_start_api(monkeypatch, capsys):
    monkeypatch.setattr(docker_server.local_solver, "health", lambda: dict(ready=False, message="Missing bundled MPI"))
    monkeypatch.setattr(docker_server.os, "execvp", lambda *_: pytest.fail("Started without its solver"))
    assert docker_server.main() == 1
    assert "Missing bundled MPI" in capsys.readouterr().err
