"""Resource limits, direct process execution and complete MPI-family cancellation."""

from concurrent.futures import ThreadPoolExecutor
import json
import time
from types import SimpleNamespace

import psutil
import pytest

from easycfd import local_solver, runner, storage


def test_health_checks_bundled_tools_without_docker(monkeypatch):
    monkeypatch.setenv("EASYCFD_SOLVER_MODE", "local")
    monkeypatch.setenv("WM_PROJECT_VERSION", "v2412")
    monkeypatch.setattr(local_solver.shutil, "which", lambda tool: "/bundled/" + tool)
    monkeypatch.setattr(runner, "docker", lambda *_: pytest.fail("Local runtime contacted Docker"))
    assert runner.health()["ready"]
    monkeypatch.setattr(local_solver.shutil, "which", lambda tool: None if tool == "mpirun" else "/bundled/" + tool)
    assert not runner.health()["ready"]
    assert "mpirun" in runner.health()["message"]
    monkeypatch.setenv("WM_PROJECT_VERSION", "v2512")
    monkeypatch.setattr(local_solver.shutil, "which", lambda tool: "/bundled/" + tool)
    assert not runner.health()["ready"]


def test_resources_respect_container_memory_and_cpu_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(local_solver, "CGROUP", tmp_path)
    monkeypatch.setattr(local_solver.psutil, "virtual_memory", lambda: SimpleNamespace(total=16 * 1024**3, available=12 * 1024**3))
    (tmp_path / "memory.max").write_text(str(4 * 1024**3))
    (tmp_path / "memory.current").write_text(str(3 * 1024**3))
    assert local_solver.memory() == (4 * 1024**3, 1024**3)
    (tmp_path / "cpu.max").write_text("100000 100000")
    assert local_solver.cpus() == 1
    (tmp_path / "memory.max").write_text("max")
    assert local_solver.memory() == (16 * 1024**3, 12 * 1024**3)


def test_mpi_keeps_the_jobs_cpu_allocation():
    args = local_solver.command(["mpirun", "-np", "4", "simpleFoam", "-parallel"], 2)
    assert args[:3] == ["taskset", "-c", ",".join(map(str, psutil.Process().cpu_affinity()[:2]))]
    assert args[3:6] == ["mpirun", "--bind-to", "none"]


@pytest.mark.parametrize("pressure", [False, True])
def test_stage_stops_entire_process_family_on_cancel_or_memory_pressure(tmp_path, monkeypatch, pressure):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setenv("EASYCFD_SOLVER_MODE", "local")
    monkeypatch.setattr(runner, "docker", lambda *_args, **_kwargs: pytest.fail("Local stage contacted Docker"))
    key = storage.identifier()
    storage.save("runs", dict(id=key, created=storage.now(), status="running"))
    case = tmp_path / "case"
    case.mkdir()
    script = (
        "import json, os, subprocess, time; from pathlib import Path; "
        "child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(120)'], start_new_session=True); "
        "Path('pids.json').write_text(json.dumps([os.getpid(), child.pid])); time.sleep(120)"
    )
    if pressure:
        monkeypatch.setattr(local_solver, "rss", lambda _: 4 * 1024**3)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(runner.stage, key, case, ["python3", "-c", script], "testing MPI family", 3, 1)
        deadline = time.monotonic() + 5
        while not (case / "pids.json").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (case / "pids.json").exists()
        pids = json.loads((case / "pids.json").read_text())
        if not pressure:
            storage.update("runs", key, cancel_requested=True)
        with pytest.raises(RuntimeError if pressure else InterruptedError):
            future.result(timeout=12)
    for pid in pids:
        assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    assert runner.ACTIVE is None
