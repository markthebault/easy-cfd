"""OpenFOAM/MPI processes inside the backend's own container, without Docker access."""

import math
import os
from pathlib import Path
import shutil
import signal
import subprocess

import psutil

from . import foam

TOOLS = ("blockMesh", "snappyHexMesh", "checkMesh", "decomposePar", "simpleFoam", "pimpleFoam", "reconstructPar", "mpirun", "taskset")
CGROUP = Path("/sys/fs/cgroup")


def enabled():
    return os.environ.get("EASYCFD_SOLVER_MODE") == "local"


def memory():
    """Effective total/available memory, including Docker's optional cgroup limit."""
    host = psutil.virtual_memory()
    total, available = host.total, host.available
    try:
        limit = int((CGROUP / "memory.max").read_text())
        current = int((CGROUP / "memory.current").read_text())
        total, available = min(total, limit), min(available, max(0, limit - current))
    except (OSError, ValueError):
        try:
            limit = int((CGROUP / "memory/memory.limit_in_bytes").read_text())
            current = int((CGROUP / "memory/memory.usage_in_bytes").read_text())
            total, available = min(total, limit), min(available, max(0, limit - current))
        except (OSError, ValueError):
            pass
    return total, available


def cpus():
    count = len(psutil.Process().cpu_affinity())
    try:
        quota, period = (CGROUP / "cpu.max").read_text().split()
        count = min(count, max(1, math.ceil(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return count


def health():
    missing = [tool for tool in TOOLS if not shutil.which(tool)]
    version = os.environ.get("WM_PROJECT_VERSION", "")
    ready = not missing and version == "v2412"
    message = "Bundled OpenFOAM v2412 and MPI are ready" if ready else (
        "Bundled OpenFOAM setup is incomplete: " + ", ".join(missing)
        if missing else "This backend requires its bundled OpenFOAM v2412 environment."
    )
    return dict(ready=ready, message=message, runtime="local", image=foam.IMAGE,
                architecture=os.uname().machine, memory_gb=round(memory()[0] / 1024**3, 1), cpus=cpus())


def command(args, cpu_count):
    # Affinity is established before MPI forks, so every rank inherits the job's
    # CPU allocation. Avoid preexec_fn in the multi-threaded API process.
    affinity = psutil.Process().cpu_affinity()[:max(1, int(cpu_count))]
    if args[0] == "mpirun":
        # Open MPI's automatic binding can otherwise widen the inherited mask.
        args = [args[0], "--bind-to", "none", *args[1:]]
    return ["taskset", "-c", ",".join(map(str, affinity)), *args]


def rss(process):
    try:
        parent = psutil.Process(process.pid)
        family = [parent, *parent.children(recursive=True)]
    except psutil.NoSuchProcess:
        return 0
    total = 0
    for member in family:
        try:
            total += member.memory_info().rss
        except psutil.NoSuchProcess:
            pass
    return total


def terminate(process):
    """Stop the solver and all MPI descendants, including separate rank groups."""
    try:
        descendants = psutil.Process(process.pid).children(recursive=True)
    except psutil.NoSuchProcess:
        descendants = []
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for child in descendants:
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(descendants, timeout=3)
    for child in alive:
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
