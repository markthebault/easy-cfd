"""One persistent queue, one solver container at a time. Run uvicorn with one worker."""

import json
import hashlib
import fcntl
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from . import storage, foam, results
from .models import Settings, resolved_preset

JOBS = queue.Queue()
STOP = threading.Event()
THREAD = None
ACTIVE = None
INSTANCE_LOCK = None
# Capture source identity once, so edits on disk cannot relabel a running server's templates.
PIPELINE_HASH = hashlib.sha256(
    b"".join(
        Path(__file__).with_name(name).read_bytes()
        for name in ("foam.py", "models.py", "results.py", "benchmark.py", "runner.py")
    )
).hexdigest()


def docker(args, **kwargs):
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=kwargs.pop("timeout", 15), **kwargs
    )


def health():
    try:
        info = docker(["info", "--format", "{{json .}}"])
        if info.returncode:
            return dict(ready=False, message="Start your Docker-compatible runtime, then retry.")
        parsed = json.loads(info.stdout)
        image = docker(["image", "inspect", foam.IMAGE])
        return dict(
            ready=image.returncode == 0,
            architecture=parsed.get("Architecture"),
            memory_gb=round(parsed.get("MemTotal", 0) / 1024**3, 1),
            cpus=parsed.get("NCPU"),
            message="Solver ready"
            if image.returncode == 0
            else "Run ./scripts/setup.sh to download the pinned solver image.",
            image=foam.IMAGE,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return dict(ready=False, message="Docker is unavailable. See the local setup instructions.")


def processes():
    """MPI ranks for the solver. Four unless EASYCFD_PROCESSES says otherwise.

    More ranks were slower on the tested Apple M1: the 194k-cell Medium sample
    took 45.6 s for 200 iterations on 4 ranks, 55.0 s on 6 and 61.7 s on 8. The
    cause was not isolated (efficiency cores, MPI communication and memory
    bandwidth are all candidates). Two is the floor because the case is always
    decomposed and run with -parallel.
    """
    return min(max(int(os.environ.get("EASYCFD_PROCESSES", 4)), 2), 16)


def patch(key, **changes):
    return storage.update("runs", key, **changes)


def check_cancelled(key):
    if STOP.is_set() or storage.get("runs", key)["status"] == "cancelled":
        raise InterruptedError("Run cancelled")


def container(name, case, command, memory, cpus):
    """Arguments for one isolated, network-less solver container on a case folder."""
    return [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--memory",
        f"{memory}g",
        "--memory-swap",
        f"{memory}g",
        "--cpus",
        str(cpus),
        "--pids-limit",
        "256",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-e",
        "HOME=/tmp",
        "--mount",
        f"type=bind,source={case},target=/case",
        "-w",
        "/case",
        "--entrypoint",
        "/bin/bash",
        foam.IMAGE,
        "-lc",
        'exec "$@"',
        "easycfd",
        *command,
    ]


def redundant_processor_copies(case):
    """The case's processor* folders, if every time they hold was reconstructed.

    purgeWrite keeps more than one time, so a processor folder can hold the only
    copy of an earlier time. Its folders are returned only when each processor
    time directory also exists in the case root with every field it contains;
    otherwise nothing is returned and the copies must be kept.
    """
    folders = sorted(path for path in case.glob("processor*") if path.is_dir())
    for folder in folders:
        for time_dir in folder.iterdir():
            if time_dir.name == "constant" or not time_dir.is_dir():
                continue
            reconstructed = case / time_dir.name
            if not reconstructed.is_dir():
                return []
            if {f.name for f in time_dir.iterdir()} - {f.name for f in reconstructed.iterdir()}:
                return []
    return folders


def stage(key, case, command, stage_name, memory, cpus=4):
    global ACTIVE
    check_cancelled(key)
    name = f"easycfd-{key}"
    patch(key, stage=stage_name)
    tool = "simpleFoam" if "simpleFoam" in command else command[0]
    log_path = case / f"log.{tool}"
    args = container(name, case, command, memory, cpus)
    start = time.monotonic()
    with log_path.open("w") as log:
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
        ACTIVE = process
        try:
            while process.poll() is None:
                check_cancelled(key)
                if time.monotonic() - start > 24 * 3600:
                    raise RuntimeError("Stage exceeded 24 hours. Refine the geometry or reduce quality.")
                if tool == "simpleFoam":
                    tail = log_path.read_text(errors="replace")[-24000:]
                    iterations = re.findall(r"^Time = (\d+)", tail, re.MULTILINE)
                    if iterations:
                        patch(key, iteration=int(iterations[-1]))
                time.sleep(0.5)
        except BaseException:
            docker(["rm", "-f", name])
            process.wait(timeout=15)
            raise
        finally:
            ACTIVE = None
    if process.returncode:
        tail = log_path.read_text(errors="replace")[-4000:]
        reason = (
            "Container was killed, possibly by a memory limit or an external stop."
            if process.returncode == 137
            else f"{command[0]} failed."
        )
        raise RuntimeError(f"{reason} Inspect the log for the geometry or solver error.\n{tail}")
    return time.monotonic() - start


def solve(key, tier):
    run = storage.get("runs", key)
    root = storage.directory("runs", key)
    case = root / f"case-{tier}"
    # Runs queued before CPU detection keep the original fixed layout.
    ranks, cpus = run.get("processes", 4), run.get("cpus", 4)
    meta = foam.generate(
        case,
        root / "geometry",
        run["geometry"],
        Settings(**run["settings"]),
        tier,
        run.get("reference_case"),
        processes=ranks,
    )
    if run.get("reference_case") == "ahmedml-run-1":
        from .benchmark import apply_boundaries

        meta = apply_boundaries(case, meta)
    (case / "metadata.json").write_text(json.dumps(meta, indent=2))
    preset = meta["preset"]
    timings = {}
    for command, label in [
        (["blockMesh"], "Building tunnel"),
        (["snappyHexMesh", "-overwrite"], "Meshing car"),
        (["checkMesh", "-meshQuality", "-allTopology"], "Checking mesh"),
    ]:
        timings[command[0]] = stage(key, case, command, f"{tier}: {label}", preset["memory_gb"], cpus)
    check = (case / "log.checkMesh").read_text()
    if "Mesh OK." not in check:
        details = "\n".join(
            line.strip().lstrip("*").strip()
            for line in check.splitlines()
            if line.strip().startswith(("***", "Failed "))
        )
        raise RuntimeError(
            "Generated mesh failed quality checks; the airflow solver was not started. "
            "Box dimensions and mesh resolution affect cell quality even with unchanged geometry. "
            "Review the mesh settings and log.checkMesh."
            + (f"\n{details}" if details else "")
        )
    meshlog = (case / "log.snappyHexMesh").read_text()
    if re.search(r"reached.*(?:limit|maxGlobalCells)|maximum number of cells", meshlog, re.I):
        raise RuntimeError(
            "Meshing reached its cell budget. Simplify the model; quality was not silently reduced."
        )
    boundary = (case / "constant/polyMesh/boundary").read_text(errors="replace")
    for part in run["geometry"]["parts"]:
        match = re.search(r"\b" + re.escape(part["id"]) + r"\s*\{[^}]*?nFaces\s+(\d+)", boundary)
        if not match or int(match.group(1)) < 6:
            raise RuntimeError(
                f"Part {part['name']} disappeared or has too few mesh faces. Use a finer preset or simplify the part."
            )
    cells = re.search(r"cells:\s+(\d+)", check)
    if cells and int(cells.group(1)) > preset["max_cells"]:
        raise RuntimeError("The final mesh exceeds the preset cell budget. Simplify the model.")
    layer_coverage = None
    if preset["layers"]:
        matches = re.findall(r"Extruding (\d+) out of (\d+) faces", meshlog)
        if matches:
            added, total = map(int, matches[-1])
            layer_coverage = added / max(total, 1)
        if layer_coverage is None or layer_coverage < 0.2:
            raise RuntimeError(
                "Fewer than 20% of surface faces received boundary layers. Mesh quality was not silently reduced; review small gaps and sharp features."
            )
    timings["decomposePar"] = stage(
        key, case, ["decomposePar", "-force"], f"{tier}: Partitioning mesh", preset["memory_gb"], cpus
    )
    timings["simpleFoam"] = stage(
        key,
        case,
        ["mpirun", "--allow-run-as-root", "--oversubscribe", "-np", str(ranks), "simpleFoam", "-parallel"],
        f"{tier}: Solving airflow",
        preset["memory_gb"],
        cpus,
    )
    # Reconstruct every time purgeWrite retained, not only the latest, so the
    # processor copies below hold nothing unique.
    timings["reconstructPar"] = stage(
        key,
        case,
        ["reconstructPar", "-newTimes"],
        f"{tier}: Reassembling results",
        preset["memory_gb"],
        cpus,
    )
    # Per-rank copies duplicate the reconstructed case and roughly double its size.
    for folder in redundant_processor_copies(case):
        shutil.rmtree(folder)
    check_cancelled(key)
    patch(key, stage=f"{tier}: Preparing visualization")
    output = root / ("results" if tier == run["settings"]["quality"] else f"results-{tier}")
    data = results.process(case, output, run, meta)
    data.update(timings=timings, mesh_ok=True, preset=tier, layer_coverage=layer_coverage)
    if layer_coverage is not None and layer_coverage < 0.8:
        data["warnings"].append(
            f"Boundary layers cover {layer_coverage:.0%} of requested surface faces. Inspect near-wall resolution before comparing forces."
        )
    if run.get("reference_case") == "ahmedml-run-1":
        from .benchmark import REFERENCE

        data["reference_comparison"] = {
            "reference": REFERENCE,
            "delta_cd": data["cd"] - REFERENCE["cd"],
            "delta_cl": data["cl"] - REFERENCE["cl"],
            "cd_error_percent": (data["cd"] - REFERENCE["cd"]) / REFERENCE["cd"] * 100,
        }
        data["warnings"].append(
            "Computational reference comparison: matched Reynolds number, geometry, tunnel boundaries and coefficient area; different mesh and turbulence method. This is not experimental validation."
        )
    (output / "summary.json").write_text(json.dumps(data, indent=2, allow_nan=False))
    return data


def execute(key):
    with storage.LOCK:
        run = storage.get("runs", key)
        if run["status"] == "cancelled":
            return
        patch(key, status="running", started=storage.now(), stage="Preparing")
    try:
        if run["settings"]["quality"] == "precise":
            medium = solve(key, "medium")
        result = solve(key, run["settings"]["quality"])
        if run["settings"]["quality"] == "precise":
            result["medium_timings"] = medium["timings"]
            result["refinement"] = dict(
                medium_cd=medium["cd"],
                medium_cl=medium["cl"],
                delta_cd=result["cd"] - medium["cd"],
                delta_cl=result["cl"] - medium["cl"],
                both_settled=medium["force_settled"] and result["force_settled"],
                both_converged=medium["residual_converged"] and result["residual_converged"],
            )
            result["warnings"].append(
                "Two mesh levels measure sensitivity, not a formal numerical uncertainty bound."
            )
            if not result["refinement"]["both_settled"] or not result["refinement"]["both_converged"]:
                result["warnings"].append(
                    "At least one mesh level did not settle or reach its residual target. The refinement comparison is inconclusive."
                )
        (storage.directory("runs", key) / "results/summary.json").write_text(
            json.dumps(result, indent=2, allow_nan=False)
        )
        with storage.LOCK:
            check_cancelled(key)
            patch(
                key,
                status="completed",
                stage="Complete",
                finished=storage.now(),
                iteration=int(result["iteration"]),
                result=result,
                disk_bytes=disk_bytes(storage.directory("runs", key)),
            )
    except InterruptedError:
        patch(key, status="cancelled", stage="Cancelled", finished=storage.now())
    except Exception as error:
        if storage.get("runs", key)["status"] == "cancelled":
            patch(key, status="cancelled", stage="Cancelled", finished=storage.now())
        else:
            patch(key, status="failed", stage="Failed", error=str(error), finished=storage.now())


def disk_bytes(folder):
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())


def worker():
    while not STOP.is_set():
        try:
            key = JOBS.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            execute(key)
        finally:
            JOBS.task_done()


def start():
    global THREAD, INSTANCE_LOCK
    INSTANCE_LOCK = (storage.ROOT / "worker.lock").open("w")
    try:
        fcntl.flock(INSTANCE_LOCK, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        INSTANCE_LOCK.close()
        raise RuntimeError(
            "Easy CFD is already running for this data directory. Use one server process."
        ) from error
    STOP.clear()
    for run in reversed(storage.all_records("runs")):
        if run["status"] == "running":
            try:
                docker(["rm", "-f", f"easycfd-{run['id']}"])
            except (OSError, subprocess.SubprocessError):
                pass
            patch(
                run["id"],
                status="failed",
                stage="Interrupted",
                error="Application stopped during this run. Start a new run; saved logs are available.",
            )
        elif run["status"] == "queued":
            JOBS.put(run["id"])
    THREAD = threading.Thread(target=worker, daemon=True)
    THREAD.start()


def stop():
    global INSTANCE_LOCK
    STOP.set()
    if THREAD:
        THREAD.join(timeout=20)
    if INSTANCE_LOCK:
        INSTANCE_LOCK.close()
        INSTANCE_LOCK = None


def enqueue(project):
    status = health()
    if not status["ready"]:
        raise ValueError(status["message"])
    settings = Settings(**project["settings"])
    if not settings.geometry_confirmed:
        raise ValueError("Confirm model dimensions, orientation, and ground clearance before running.")
    geometry = project.get("geometry")
    if not geometry or geometry["errors"]:
        raise ValueError("Import valid closed geometry before running.")
    foam.mesh_layout(geometry, settings, reference_case=project.get("reference_case"))
    required = resolved_preset(settings)["memory_gb"]
    if status.get("memory_gb", 0) < required + 0.5:
        raise ValueError(
            f"This preset needs at least {required + 0.5} GB allocated to the container runtime."
        )
    if shutil.disk_usage(storage.ROOT).free < 8 * 1024**3:
        raise ValueError("Keep at least 8 GB free for mesh and results files.")
    ranks = processes()
    key = storage.identifier()
    run = dict(
        id=key,
        project_id=project["id"],
        name=project["name"],
        created=storage.now(),
        status="queued",
        stage="Queued",
        settings=settings.model_dump(),
        geometry=geometry,
        domain=foam.domain_bounds(geometry, settings, project.get("reference_case")),
        image=foam.IMAGE,
        pipeline_hash=PIPELINE_HASH,
        processes=ranks,
        # Docker refuses --cpus above the runtime's count (Colima defaults to 2).
        cpus=min(ranks, int(status.get("cpus") or ranks)),
        reference_case=project.get("reference_case"),
        iteration=0,
        assumptions=dict(
            inlet_turbulence_percent=0.6 if project.get("reference_case") == "ahmedml-run-1" else 1,
            kinematic_viscosity=1.5e-5,
            drag_axis="+X",
            lift_axis="+Z",
            downforce="negative lift",
        ),
    )
    folder = storage.directory("runs", key)
    folder.mkdir(parents=True)
    shutil.copytree(
        storage.directory("projects", project["id"]) / project["geometry_dir"], folder / "geometry"
    )
    storage.save("runs", run)
    JOBS.put(key)
    return run
