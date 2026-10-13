"""The published server prepares its pinned solver before accepting connections."""

import subprocess

import pytest

from easycfd import docker_server, foam


@pytest.mark.parametrize("cached", [True, False])
def test_startup_uses_cached_solver_or_downloads_it_before_starting_api(monkeypatch, capsys, cached):
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "image":
            return subprocess.CompletedProcess(args, 0 if cached else 1)
        assert args == ["docker", "pull", foam.IMAGE]
        assert kwargs["check"] and kwargs["timeout"] == 1800
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(docker_server.subprocess, "run", run)
    monkeypatch.setattr(docker_server.os, "execvp", lambda executable, args: calls.append(args))
    docker_server.main()
    assert calls[0] == ["docker", "image", "inspect", foam.IMAGE]
    assert calls[-1] == ["uvicorn", "easycfd.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
    assert len(calls) == (2 if cached else 3)
    output = capsys.readouterr().out
    assert ("Downloading OpenFOAM" in output) is not cached
    assert "OpenFOAM is ready" in output


@pytest.mark.parametrize("error", [
    FileNotFoundError("docker"),
    subprocess.TimeoutExpired(["docker", "pull"], 1800),
    subprocess.CalledProcessError(1, ["docker", "pull"]),
])
def test_setup_failure_does_not_start_api_and_explains_retry(monkeypatch, capsys, error):
    def run(args, **kwargs):
        if args[1] == "image" and not isinstance(error, FileNotFoundError):
            return subprocess.CompletedProcess(args, 1)
        raise error

    monkeypatch.setattr(docker_server.subprocess, "run", run)
    monkeypatch.setattr(docker_server.os, "execvp", lambda *_: pytest.fail("Started without its solver"))
    assert docker_server.main() == 1
    assert "run the startup command again" in capsys.readouterr().err


def test_interrupting_download_does_not_start_api(monkeypatch):
    def run(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(docker_server.subprocess, "run", run)
    monkeypatch.setattr(docker_server.os, "execvp", lambda *_: pytest.fail("Started after cancellation"))
    assert docker_server.main() == 130
