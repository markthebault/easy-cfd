"""One persistent queue, one solver container at a time. Run uvicorn with one worker."""

import datetime
import json
import sys
import psutil
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
from . import storage, foam, compute_lease
from .models import Axles, Settings, resolved_preset
from .aerodynamics import detected_axles

JOBS = queue.Queue()
STOP = threading.Event()
THREAD = None
ACTIVE = None
DEADLINES = {}
INSTANCE_LOCK = None
# Capture source identity once, so edits on disk cannot relabel a running server's templates.
PIPELINE_HASH = hashlib.sha256(
    b"".join(
        Path(__file__).with_name(name).read_bytes()
        for name in (
            "foam.py",
            "models.py",
            "results.py",
            "benchmark.py",
            "runner.py",
            "aerodynamics.py",
            "extract_worker.py",
            "sample_worker.py",
        )
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
    if time.monotonic() > DEADLINES.get(key, float("inf")):
        raise TimeoutError(
            "Whole-job elapsed-time limit reached. Completed mesh-level results remain saved; the qualification is incomplete."
        )
    record = storage.get("runs", key)
    if STOP.is_set() or record["status"] == "cancelled" or record.get("cancel_requested"):
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
    record = storage.get("runs", key)
    reserve = min(120, 0.2 * record.get("deadline_seconds", 600))
    checkpoint_requested = False
    resource_sample_at = start
    resource_peak = 0
    with log_path.open("w") as log:
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
        ACTIVE = process
        try:
            while process.poll() is None:
                check_cancelled(key)
                if time.monotonic() - start > 24 * 3600:
                    raise RuntimeError("Stage exceeded 24 hours. Refine the geometry or reduce quality.")
                now = time.monotonic()
                if now - resource_sample_at >= 5:
                    resource_sample_at = now
                    try:
                        stats = docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", name], timeout=3)
                    except subprocess.TimeoutExpired:
                        stats = subprocess.CompletedProcess([], 1, "", "")
                    match = re.match(r"([\d.]+)([KMG]i?B)", stats.stdout)
                    if match:
                        units = {
                            "KiB": 1024,
                            "MiB": 1024**2,
                            "GiB": 1024**3,
                            "KB": 1000,
                            "MB": 1000**2,
                            "GB": 1000**3,
                        }
                        rss = float(match[1]) * units[match[2]]
                        resource_peak = max(resource_peak, rss)
                        record = storage.get("runs", key)
                        patch(
                            key,
                            container_peak_bytes=max(record.get("container_peak_bytes", 0), resource_peak),
                            host_available_bytes=psutil.virtual_memory().available,
                        )
                        if (
                            rss + psutil.Process().memory_info().rss > 8 * 1024**3
                            or psutil.virtual_memory().available < 512 * 1024**2
                        ):
                            raise RuntimeError(
                                "Resource pressure exceeded the combined 8 GiB job budget or left less than 512 MiB available on the host. Saved checkpoints and logs remain available."
                            )
                if tool == "simpleFoam":
                    if (
                        not checkpoint_requested
                        and DEADLINES.get(key, float("inf")) - time.monotonic() <= reserve
                    ):
                        control = case / "system/controlDict"
                        content = re.sub(r"stopAt\s+endTime;", "stopAt writeNow;", control.read_text())
                        temporary = control.with_suffix(".checkpoint")
                        temporary.write_text(content)
                        temporary.replace(control)
                        checkpoint_requested = True
                        patch(
                            key,
                            termination_reason="deadline-checkpoint",
                            stage=f"{stage_name}: writing provisional checkpoint",
                        )
                    tail = log_path.read_text(errors="replace")[-24000:]
                    iterations = re.findall(r"^Time = (\d+)", tail, re.MULTILINE)
                    if iterations:
                        patch(key, iteration=int(iterations[-1]))
                time.sleep(0.5)
        except BaseException:
            docker(["rm", "-f", name], timeout=3)
            process.wait(timeout=2)
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


def extract_case(key, case, output, run):
    output.mkdir(exist_ok=True)
    input_record = output / ".run-input.json"
    input_record.write_text(json.dumps(run))
    with (case / "log.extract").open("w") as extract_log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "easycfd.extract_worker",
                str(case),
                str(output),
                str(input_record),
                str(case / "metadata.json"),
            ],
            stdout=extract_log,
            stderr=subprocess.STDOUT,
        )
        try:
            while process.poll() is None:
                check_cancelled(key)
                try:
                    memory = (
                        psutil.Process(process.pid).memory_info().rss + psutil.Process().memory_info().rss
                    )
                except psutil.NoSuchProcess:
                    continue
                record = storage.get("runs", key)
                if memory > record.get("extraction_peak_bytes", 0):
                    patch(key, extraction_peak_bytes=memory)
                if memory > 8 * 1024**3:
                    raise RuntimeError(
                        "Native extraction exceeded the 8 GiB combined process memory ceiling."
                    )
                time.sleep(0.2)
            if process.returncode:
                raise RuntimeError(
                    "Native field extraction failed: " + (case / "log.extract").read_text()[-3000:]
                )
        except BaseException:
            process.kill()
            process.wait(timeout=5)
            raise
    return json.loads((output / ".extracted.json").read_text())


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
    count = re.search(r"^\s*cells:\s*(\d+)", check, re.MULTILINE)
    if count and int(count[1]) > preset["max_cells"]:
        raise RuntimeError(
            f"Mesh has {count[1]} cells, above this preset's hard ceiling {preset['max_cells']}."
        )
    if "Mesh OK." not in check:
        details = "\n".join(
            line.strip().lstrip("*").strip()
            for line in check.splitlines()
            if line.strip().startswith(("***", "Failed "))
        )
        raise RuntimeError(
            "Generated mesh failed quality checks; the airflow solver was not started. "
            "Box dimensions and mesh resolution affect cell quality even with unchanged geometry. "
            "Review the mesh settings and log.checkMesh." + (f"\n{details}" if details else "")
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
    output = root / (
        "results" if (tier == run["settings"]["quality"] or tier == "advanced1") else f"results-{tier}"
    )
    data = extract_case(key, case, output, run)
    data.update(
        timings=timings,
        mesh_ok=True,
        preset=tier,
        layer_coverage=layer_coverage,
        resource_mode="Keep Mac responsive"
        if run["settings"].get("profile") in ("advanced1", "advanced2")
        else "Legacy CPU quota",
        resources=dict(
            processes=ranks,
            cpus=cpus,
            container_memory_gib=preset["memory_gb"],
            combined_limit_gib=8,
            deadline_seconds=storage.get("runs", key).get("deadline_seconds"),
            container_peak_bytes=storage.get("runs", key).get("container_peak_bytes"),
            extraction_peak_bytes=storage.get("runs", key).get("extraction_peak_bytes"),
        ),
        mesh_recipe=meta,
    )
    if data.get("provenance"):
        mesh_hash = hashlib.sha256()
        for field in ("points", "faces", "owner", "neighbour", "boundary"):
            file = case / "constant/polyMesh" / field
            if file.exists():
                with file.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        mesh_hash.update(block)
        data["provenance"].update(
            pipeline=run["pipeline_hash"],
            geometry=run["geometry"].get("fingerprint"),
            mesh=mesh_hash.hexdigest(),
        )
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
        ceiling = run["settings"].get("max_seconds") or {
            "basic": 300,
            "regular": 600,
            "advanced1": 10800,
            "advanced2": 43200,
        }.get(run["settings"].get("profile"), 10800)
        DEADLINES[key] = time.monotonic() + ceiling
        patch(
            key,
            status="running",
            started=storage.now(),
            deadline_seconds=ceiling,
            deadline_at=(
                datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=ceiling)
            ).isoformat(),
            stage="Preparing",
        )
    try:
        if run["settings"].get("profile") == "advanced2":
            levels = []
            for tier in ("advanced2_1", "advanced2_2", "advanced2_3"):
                level = solve(key, tier)
                levels.append(level)
                patch(
                    key,
                    completed_levels=[
                        dict(
                            preset=level_result["preset"],
                            cells=level_result["cells"],
                            cd=level_result["cd"],
                            cl=level_result["cl"],
                            aero=level_result.get("aero"),
                            force_settled=level_result["force_settled"],
                            residual_converged=level_result["residual_converged"],
                            drag=level_result["drag"],
                            downforce=level_result["downforce"],
                            part_forces=level_result.get("part_forces"),
                            reconciliation=level_result.get("reconciliation"),
                            balance_bands=level_result.get("balance_bands"),
                            wall_stress=level_result.get("wall_stress"),
                            wall_target_fraction=level_result.get("wall_target_fraction"),
                            layer_coverage=level_result.get("layer_coverage"),
                            resources=level_result.get("resources"),
                            mesh_recipe=level_result.get("mesh_recipe"),
                            timings=level_result.get("timings"),
                            provenance=level_result.get("provenance"),
                            warnings=level_result["warnings"],
                        )
                        for level_result in levels
                    ],
                )
                if (
                    storage.get("runs", key).get("termination_reason")
                    or not level["force_settled"]
                    or not level["residual_converged"]
                ):
                    level["warnings"].append(
                        "Advanced 2 stopped after an unstable mesh level. The refinement study is inconclusive; subsequent levels were not run."
                    )
                    break
            result = levels[-1]
            result["refinement_levels"] = storage.get("runs", key)["completed_levels"]
            result["refinement_complete"] = (
                len(levels) == 3
                and all(level["force_settled"] and level["residual_converged"] for level in levels)
                and not storage.get("runs", key).get("termination_reason")
            )
            shutil.copytree(
                storage.directory("runs", key) / f"results-{levels[-1]['preset']}",
                storage.directory("runs", key) / "results",
                dirs_exist_ok=True,
            )
        elif run["settings"]["quality"] == "precise" and not (
            run["settings"].get("profile") or ""
        ).startswith("advanced"):
            medium = solve(key, "medium")
        skipped_fine = (
            run["settings"]["quality"] == "precise"
            and not (run["settings"].get("profile") or "").startswith("advanced")
            and storage.get("runs", key).get("termination_reason")
        )
        if skipped_fine:
            result = medium
            result["refinement_levels"] = [{**medium}]
            shutil.copytree(
                storage.directory("runs", key) / "results-medium",
                storage.directory("runs", key) / "results",
                dirs_exist_ok=True,
            )
        elif run["settings"].get("profile") != "advanced2":
            result = solve(
                key,
                "advanced1" if run["settings"].get("profile") == "advanced1" else run["settings"]["quality"],
            )
        if run["settings"]["quality"] == "precise" and not (run["settings"].get("profile") or "").startswith(
            "advanced"
        ):
            if not skipped_fine:
                result["refinement_levels"] = [{**medium}, {**result}]
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
        if storage.get("runs", key).get("termination_reason"):
            result["force_settled"] = False
            result["incomplete"] = True
            result["termination_reason"] = "deadline-checkpoint"
            result["warnings"].append(
                "The whole-job time limit stopped the solve early. This completed checkpoint is provisional; the requested study is incomplete."
            )
        (storage.directory("runs", key) / "results/summary.json").write_text(
            json.dumps(result, indent=2, allow_nan=False)
        )
        with storage.LOCK:
            check_cancelled(key)
            patch(
                key,
                status="completed",
                stage="Provisional checkpoint" if result.get("incomplete") else "Complete",
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
            while not compute_lease.start_server(key):
                check_cancelled(key)
                time.sleep(0.2)
            execute(key)
        except InterruptedError:
            patch(key, status="cancelled", stage="Cancelled", finished=storage.now())
        finally:
            compute_lease.finish_server()
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
    if settings.axles is None or settings.axles.source == "wheels":
        inferred = detected_axles(geometry["parts"])
        settings.axles = Axles(**inferred) if inferred else None
    foam.mesh_layout(geometry, settings, reference_case=project.get("reference_case"))
    required = resolved_preset(settings)["memory_gb"]
    if status.get("memory_gb", 0) < required + 0.5:
        raise ValueError(
            f"This preset needs at least {required + 0.5} GB allocated to the container runtime."
        )
    disk_gb = 16 if settings.profile == "advanced2" else 8
    if shutil.disk_usage(storage.ROOT).free < disk_gb * 1024**3:
        raise ValueError(f"Keep at least {disk_gb} GB free for this mesh and its results files.")
    ranks = 2 if settings.profile in ("advanced1", "advanced2") else processes()
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
