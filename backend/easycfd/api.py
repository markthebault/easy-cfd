from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
import shutil
import os
import math
import statistics
import tempfile
import zipfile
from fastapi import BackgroundTasks, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from . import geometry, runner, storage, results
from .models import ImportOptions, NewProject, Settings, PRESETS


@asynccontextmanager
async def lifespan(app):
    storage.ROOT.mkdir(parents=True, exist_ok=True)
    runner.start()
    yield
    runner.stop()


app = FastAPI(title="Easy CFD", lifespan=lifespan)


@app.middleware("http")
async def local_only(request: Request, call_next):
    host = request.headers.get("host", "").split(":")[0]
    tailnet_origin = os.environ.get("EASYCFD_TAILNET_ORIGIN", "").rstrip("/")
    allowed_hosts = {"localhost", "127.0.0.1", "testserver"}
    if tailnet_origin:
        allowed_hosts.add(urlparse(tailnet_origin).hostname)
    if host not in allowed_hosts:
        return JSONResponse({"detail": "This application accepts local connections only."}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin != tailnet_origin and urlparse(origin).hostname not in ("localhost", "127.0.0.1"):
        return JSONResponse({"detail": "External origins are not allowed."}, status_code=403)
    return await call_next(request)


@app.exception_handler(FileNotFoundError)
async def missing(request, error):
    return JSONResponse({"detail": "Project, run, or asset not found."}, status_code=404)


@app.exception_handler(ValueError)
async def invalid(request, error):
    return JSONResponse({"detail": str(error)}, status_code=400)


@app.get("/api/health")
def health():
    return {**runner.health(), "presets": PRESETS, "data_directory": str(storage.ROOT)}


@app.get("/api/projects")
def projects():
    return storage.all_records("projects")


@app.post("/api/projects", status_code=201)
def create(body: NewProject):
    key = storage.identifier()
    project = dict(
        id=key, name=body.name, created=storage.now(), settings=Settings().model_dump(), geometry=None
    )
    if body.sample:
        project["geometry_dir"] = "geometry-" + storage.identifier()
        project["geometry"] = geometry.sample(
            storage.directory("projects", key) / project["geometry_dir"], body.wing
        )
        project["sample"] = "wing" if body.wing else "baseline"
    storage.save("projects", project)
    return project


@app.get("/api/projects/{key}/estimate")
def estimate(key: str, quality: Literal["fast", "medium", "precise"] = "medium"):
    project = storage.get("projects", key)
    fingerprint = (project.get("geometry") or {}).get("fingerprint")
    measured = []
    for run in storage.all_records("runs"):
        if run["status"] != "completed" or run["settings"]["quality"] != quality:
            continue
        if run["geometry"]["fingerprint"] == fingerprint:
            result = run["result"]
            measured.append(
                sum(result.get("timings", {}).values()) + sum(result.get("medium_timings", {}).values())
            )
    return dict(
        quality=quality,
        memory_gb=PRESETS[quality]["memory_gb"],
        cell_limit=PRESETS[quality]["max_cells"],
        measured_runs=len(measured),
        previous_seconds=statistics.median(measured) if measured else None,
        message="Previous runs of this geometry; different conditions can change runtime."
        if measured
        else "No measured runtime for this geometry and preset yet.",
    )


@app.get("/api/projects/{key}")
def project(key: str):
    return storage.get("projects", key)


class ProjectName(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@app.put("/api/projects/{key}/name")
def rename_project(key: str, body: ProjectName):
    name = body.name.strip()
    if not name:
        raise ValueError("Enter a design name.")
    return storage.update("projects", key, name=name)


@app.put("/api/projects/{key}/settings")
def settings(key: str, body: Settings):
    current = storage.get("projects", key)
    reference = current.get("reference_case")
    if reference:
        from .benchmark import REFERENCE

        if (
            body.speed_kmh != REFERENCE["speed_kmh"]
            or body.reference_area != REFERENCE["reference_area"]
            or body.density != 1
            or body.moving_ground
            or body.wheels
            or body.yaw_deg != 0
        ):
            reference = None
    return storage.update("projects", key, settings=body.model_dump(), reference_case=reference)


@app.post("/api/projects/{key}/duplicate", status_code=201)
def duplicate(key: str):
    source = storage.get("projects", key)
    new = {
        **source,
        "id": storage.identifier(),
        "name": source["name"][:85] + " · variant",
        "created": storage.now(),
    }
    target = storage.directory("projects", new["id"])
    target.mkdir(parents=True)
    if source.get("geometry"):
        shutil.copytree(
            storage.directory("projects", key) / source["geometry_dir"], target / source["geometry_dir"]
        )
    storage.save("projects", new)
    return new


@app.post("/api/projects/{key}/sample")
def replace_sample(key: str, wing: bool = False):
    current = storage.get("projects", key)
    folder = "geometry-" + storage.identifier()
    data = geometry.sample(storage.directory("projects", key) / folder, wing)
    settings = {**current["settings"], "geometry_confirmed": False}
    return storage.update(
        "projects",
        key,
        geometry=data,
        geometry_dir=folder,
        settings=settings,
        sample="wing" if wing else "baseline",
        reference_case=None,
    )


@app.post("/api/projects/{key}/import")
def import_geometry(key: str, files: list[UploadFile] = File(...), options: str = Form("{}")):
    current = storage.get("projects", key)
    try:
        parsed = ImportOptions.model_validate_json(options)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    if not files or len(files) > 20:
        raise ValueError("Import between 1 and 20 files at once.")
    folder_name = "geometry-" + storage.identifier()
    folder = storage.directory("projects", key) / folder_name
    folder.mkdir(parents=True)
    try:
        paths, total = [], 0
        originals = folder / "originals"
        originals.mkdir()
        for i, upload in enumerate(files):
            name = Path(upload.filename or "model").name
            if Path(name).suffix.lower() not in (".stl", ".step", ".stp"):
                raise ValueError("Supported formats: STEP, STP, and STL.")
            path = originals / f"{i}-{name}"
            with path.open("wb") as destination:
                while chunk := upload.file.read(1024 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise ValueError("Upload limit is 100 MB per import.")
                    destination.write(chunk)
            paths.append(path)
        data = geometry.import_files(paths, folder, parsed)
        return storage.update(
            "projects",
            key,
            geometry=data,
            geometry_dir=folder_name,
            sample=None,
            reference_case=None,
            settings={**current["settings"], "geometry_confirmed": False},
        )
    except Exception:
        shutil.rmtree(folder)
        raise


class WheelRole(BaseModel):
    role: Literal["body", "wheel"]
    radius: float = Field(default=0.32, gt=0.01, le=2, allow_inf_nan=False)
    center: tuple[float, float, float] | None = None


@app.put("/api/projects/{key}/parts/{part_id}")
def set_role(key: str, part_id: str, body: WheelRole):
    project = storage.get("projects", key)
    for part in project["geometry"]["parts"]:
        if part["id"] == part_id:
            center = body.center or tuple((a + b) / 2 for a, b in zip(*part["bounds"]))
            if not all(math.isfinite(x) for x in center):
                raise ValueError("Wheel center must be finite.")
            part.update(
                role=body.role,
                wheel=dict(radius=body.radius, center=center) if body.role == "wheel" else None,
            )
            project["settings"]["geometry_confirmed"] = False
            storage.save("projects", project)
            return project
    raise FileNotFoundError()


@app.get("/api/projects/{key}/geometry/{part_id}.vtp")
def geometry_asset(key: str, part_id: str):
    project = storage.get("projects", key)
    if part_id not in [p["id"] for p in project["geometry"]["parts"]]:
        raise FileNotFoundError()
    return FileResponse(storage.directory("projects", key) / project["geometry_dir"] / f"{part_id}.vtp")


@app.get("/api/runs")
def runs():
    # The UI polls this list; per-iteration force history is most of each record,
    # so it is served only by the single-run endpoint.
    records = storage.all_records("runs")
    for record in records:
        if record.get("result"):
            record["result"] = {k: v for k, v in record["result"].items() if k != "history"}
    return records


@app.post("/api/projects/{key}/runs", status_code=202)
def start_run(key: str):
    return runner.enqueue(storage.get("projects", key))


@app.get("/api/runs/{key}")
def run(key: str):
    return storage.get("runs", key)


@app.post("/api/runs/{key}/cancel")
def cancel(key: str):
    with storage.LOCK:
        run = storage.get("runs", key)
        if run["status"] not in ("queued", "running"):
            raise ValueError("Only queued or running jobs can be cancelled.")
        if run["status"] == "queued":
            return storage.update(
                "runs", key, status="cancelled", stage="Cancelled", finished=storage.now()
            )
        return storage.update("runs", key, status="cancelled", stage="Cancelling")


@app.get("/api/runs/{key}/geometry/{part_id}.vtp")
def run_geometry(key: str, part_id: str):
    run = storage.get("runs", key)
    if part_id not in [p["id"] for p in run["geometry"]["parts"]]:
        raise FileNotFoundError()
    return FileResponse(storage.directory("runs", key) / "geometry" / f"{part_id}.vtp")


@app.get("/api/runs/{key}/assets/{name}")
def run_asset(key: str, name: Literal["surface.vtp", "streamlines.vtp"]):
    return FileResponse(storage.directory("runs", key) / "results" / name)


@app.get("/api/runs/{key}/slice")
def slice_asset(key: str, axis: Literal["x", "y", "z"] = "y", position: int = 50):
    if not 0 <= position <= 100:
        raise ValueError("Slice position must be between 0 and 100.")
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    with storage.LOCK:
        path = results.slice_field(
            storage.directory("runs", key) / "results", axis, position, run["result"]["slice_bounds"]
        )
    return FileResponse(path)


@app.get("/api/runs/{key}/logs")
def logs(key: str):
    root = storage.directory("runs", key)
    return {
        f"{p.parent.name}/{p.name}": p.read_text(errors="replace")[-20000:] for p in root.glob("case-*/log.*")
    }


@app.get("/api/runs/{key}/export")
def export(key: str, cleanup: BackgroundTasks):
    root = storage.directory("runs", key)
    run = storage.get("runs", key)
    if run["status"] in ("queued", "running"):
        raise ValueError("Wait for the run to finish or cancel it before exporting.")

    def included(path):
        if path.name in ("run.zip", "record.tmp"):
            return False
        # Completed runs were reconstructed, so per-rank folders only duplicate data.
        # A failed run may hold its only solver output there, so it keeps them.
        parts = path.relative_to(root).parts
        per_rank = len(parts) > 2 and parts[1].startswith("processor")
        return not (run["status"] == "completed" and per_rank)

    handle, name = tempfile.mkstemp(prefix="export-", suffix=".zip", dir=storage.ROOT)
    os.close(handle)
    target = Path(name)
    try:
        with storage.LOCK:
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path in root.rglob("*"):
                    if path.is_file() and included(path):
                        archive.write(path, path.relative_to(root))
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    cleanup.add_task(target.unlink, missing_ok=True)
    return FileResponse(target, filename=f"easycfd-{key[:8]}.zip")


@app.get("/api/compare")
def compare(baseline: str, variant: str):
    a, b = storage.get("runs", baseline), storage.get("runs", variant)
    if any(r["status"] != "completed" for r in (a, b)):
        raise ValueError("Choose two completed runs.")
    fields = ("speed_kmh", "yaw_deg", "reference_area", "density", "moving_ground", "wheels", "quality")
    mismatch = [field for field in fields if a["settings"][field] != b["settings"][field]]
    if a.get("pipeline_hash") != b.get("pipeline_hash"):
        mismatch.append("simulation template version")
    if a.get("reference_case") != b.get("reference_case"):
        mismatch.append("boundary configuration")
    if a["image"] != b["image"]:
        mismatch.append("solver image")
    changes = {}
    for metric in ("drag", "downforce", "cd", "cl"):
        old, new = a["result"][metric], b["result"][metric]
        changes[metric] = dict(
            baseline=old,
            variant=new,
            delta=new - old,
            percent=(new - old) / abs(old) * 100 if abs(old) > 0.01 else None,
        )
    # Attribute the drag change to body/wheels and pressure/viscous when both
    # runs recorded a reconciled breakdown.
    breakdown_keys = [
        (group, metric)
        for group in ("body", "wheels")
        for metric in ("drag", "downforce")
    ] + [(None, metric) for metric in ("pressure_drag", "viscous_drag")]
    for group, metric in breakdown_keys:
        old = a["result"].get("breakdown", {})
        new = b["result"].get("breakdown", {})
        if group is not None:
            old, new = old.get(group, {}).get(metric), new.get(group, {}).get(metric)
        else:
            old, new = old.get(metric), new.get(metric)
        if old is None or new is None:
            continue
        key = f"{group}_{metric}" if group else metric
        changes[key] = dict(
            baseline=old,
            variant=new,
            delta=new - old,
            percent=(new - old) / abs(old) * 100 if abs(old) > 0.01 else None,
        )
    warnings = []
    if mismatch:
        warnings.append("Conditions differ: " + ", ".join(mismatch) + ". Rerun with matching settings.")
    if not all(r["result"]["force_settled"] and r["result"]["residual_converged"] for r in (a, b)):
        warnings.append("At least one run has not settled. Differences may be numerical.")
    if any((r["result"].get("wall_target_fraction") or 0) < 0.8 for r in (a, b)):
        warnings.append("Near-wall resolution needs review before interpreting a force difference.")
    if a["settings"]["quality"] != "precise" or b["settings"]["quality"] != "precise":
        warnings.append("Run Precise on both designs to assess mesh sensitivity before choosing a design.")
    else:
        if not all(
            r["result"].get("refinement", {}).get("both_settled")
            and r["result"].get("refinement", {}).get("both_converged")
            for r in (a, b)
        ):
            warnings.append(
                "Both mesh levels must have settled forces and acceptable residuals; refinement evidence is currently inconclusive."
            )
        for metric, coefficient in [("drag", "cd"), ("downforce", "cl")]:
            sensitivity = sum(
                abs(r["result"].get("refinement", {}).get("delta_" + coefficient, 0)) for r in (a, b)
            )
            difference = abs(changes[coefficient]["delta"])
            if difference <= sensitivity:
                warnings.append(
                    f"The {metric} difference is no larger than combined mesh sensitivity. Ranking is inconclusive."
                )
    return dict(
        changes=changes,
        warnings=warnings,
        comparable=not mismatch,
        ranges={
            field: [
                min(a["result"]["ranges"][field][0], b["result"]["ranges"][field][0]),
                max(a["result"]["ranges"][field][1], b["result"]["ranges"][field][1]),
            ]
            for field in ("Pressure", "Speed", "Turbulence")
        },
    )


frontend = Path(__file__).resolve().parents[2] / "frontend/dist"
if frontend.exists():
    app.mount("/", StaticFiles(directory=frontend, html=True), name="ui")
