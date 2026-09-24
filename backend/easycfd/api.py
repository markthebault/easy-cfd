from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
import shutil
import hashlib
import json
import re
import threading
import os
import math
import statistics
import tempfile
import zipfile
from fastapi import BackgroundTasks, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from . import geometry, plane, runner, storage, results, repair, seal, transform, wake
from .models import ImportOptions, NewProject, Settings, PRESETS, resolved_preset


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
def estimate(key: str, quality: Literal["fast", "medium", "precise", "custom"] = "medium"):
    project = storage.get("projects", key)
    effective = Settings(**{**project["settings"], "quality": quality})
    preset = resolved_preset(effective)
    fingerprint = (project.get("geometry") or {}).get("fingerprint")
    measured = []
    for run in storage.all_records("runs"):
        if run["status"] != "completed" or run["settings"]["quality"] != quality:
            continue
        saved = Settings(**run["settings"])
        if saved.simulation_box != effective.simulation_box or (quality == "custom" and (saved.custom_mesh != effective.custom_mesh or saved.custom_iterations != effective.custom_iterations)):
            continue
        if run["geometry"]["fingerprint"] == fingerprint:
            result = run["result"]
            measured.append(
                sum(result.get("timings", {}).values()) + sum(result.get("medium_timings", {}).values())
            )
    return dict(
        quality=quality,
        memory_gb=preset["memory_gb"],
        cell_limit=preset["max_cells"],
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


@app.delete("/api/projects/{key}")
def delete_project(key: str):
    with storage.LOCK:
        project = storage.get("projects", key)
        related = [run for run in storage.all_records("runs") if run["project_id"] == key]
        active = [run for run in related if run["status"] in ("queued", "running")]
        if active:
            raise ValueError("Cancel the active simulation before deleting this design.")
        for run in related:
            shutil.rmtree(storage.directory("runs", run["id"]))
        shutil.rmtree(storage.directory("projects", key))
    return {"id": project["id"], "deleted_runs": len(related)}


def settings_reference(project, body):
    reference = project.get("reference_case")
    if reference:
        from .benchmark import REFERENCE

        if (
            body.speed_kmh != REFERENCE["speed_kmh"]
            or body.reference_area != REFERENCE["reference_area"]
            or body.density != 1
            or body.moving_ground
            or body.wheels
            or body.yaw_deg != 0
            or body.simulation_box is not None
        ):
            reference = None
    return reference


@app.put("/api/projects/{key}/settings")
def settings(key: str, body: Settings):
    current = storage.get("projects", key)
    reference = settings_reference(current, body)
    if current.get("geometry") and not current["geometry"]["errors"]:
        from .foam import mesh_layout

        mesh_layout(current["geometry"], body, reference_case=reference)
    return storage.update("projects", key, settings=body.model_dump(), reference_case=reference)


@app.post("/api/projects/{key}/domain-preview")
def domain_preview(key: str, body: Settings):
    from .foam import domain_bounds, mesh_layout

    project = storage.get("projects", key)
    geometry = project.get("geometry")
    if not geometry:
        raise ValueError("Import a model before sizing the simulation box.")
    reference = settings_reference(project, body)
    bounds = domain_bounds(geometry, body, reference)
    try:
        _, counts, _ = mesh_layout(geometry, body, reference_case=reference)
        error = None
    except ValueError as exc:
        counts, error = None, str(exc)
    return dict(bounds=bounds, counts=counts, error=error)


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


def save_uploads(files, originals, first):
    if not files or len(files) > 20:
        raise ValueError("Import between 1 and 20 files at once.")
    sources, total = [], 0
    for i, upload in enumerate(files):
        name = Path(upload.filename or "model").name
        if Path(name).suffix.lower() not in (".stl", ".step", ".stp"):
            raise ValueError("Supported formats: STEP, STP, and STL.")
        file = f"{first + i}-{name}"
        with (originals / file).open("wb") as destination:
            while chunk := upload.file.read(1024 * 1024):
                total += len(chunk)
                if total > 100 * 1024 * 1024:
                    raise ValueError("Upload limit is 100 MB per import.")
                destination.write(chunk)
        sources.append(dict(file=file, name=name))
    return sources


def rebuild(key, current, options, keep=(), uploads=(), base=True, carry=True):
    """Rebuild project geometry from kept originals plus uploads in a fresh folder.

    The previous folder is removed only after the record points at the new one;
    runs hold their own copies, so nothing else refers to it.
    """
    if keep and any((current.get("geometry") or {}).get(flag) for flag in ("repaired", "transformed")):
        raise ValueError(
            "This design has geometry edits. Use Rotate & scale to change the current geometry. Export the STLs and import them to change source files. Originals are still preserved."
        )
    root = storage.directory("projects", key)
    old = current.get("geometry") or {}
    folder_name = "geometry-" + storage.identifier()
    folder = root / folder_name
    originals = folder / "originals"
    originals.mkdir(parents=True)
    try:
        for source in keep:
            shutil.copy2(root / current["geometry_dir"] / "originals" / source["file"], originals)
        first = 1 + max([int(s["file"].split("-", 1)[0]) for s in keep], default=-1)
        added = save_uploads(uploads, originals, first) if uploads else []
        sources = list(keep) + [dict(s, base=base) for s in added]
        previous = {}
        if carry:
            for part in old.get("parts", []):
                if "source" in part:
                    previous[(old["sources"][part["source"]]["file"], part["component"])] = part
        data = geometry.import_files(
            [originals / s["file"] for s in sources],
            folder,
            options,
            base=[s["base"] for s in sources],
            previous=previous,
        )
        for i, source in enumerate(sources):
            source["components"] = sum(part["source"] == i for part in data["parts"])
        data.update(sources=sources, import_options=options.model_dump())
        project = storage.update(
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
    if current.get("geometry_dir") and current["geometry_dir"] != folder_name:
        shutil.rmtree(root / current["geometry_dir"], ignore_errors=True)
    return project


def imported(project):
    data = project.get("geometry") or {}
    if not data.get("import_options"):
        raise ValueError("Import the model again to adjust its orientation or add parts to it.")
    return data, ImportOptions(**data["import_options"])


@app.post("/api/projects/{key}/import")
def import_geometry(key: str, files: list[UploadFile] = File(...), options: str = Form("{}")):
    current = storage.get("projects", key)
    try:
        parsed = ImportOptions.model_validate_json(options)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return rebuild(key, current, parsed, uploads=files, carry=False)


@app.put("/api/projects/{key}/import-options")
def reorient(key: str, body: ImportOptions):
    current = storage.get("projects", key)
    data, _ = imported(current)
    return rebuild(key, current, body, keep=data["sources"])


@app.post("/api/projects/{key}/parts", status_code=201)
def add_parts(key: str, files: list[UploadFile] = File(...)):
    """Add optional parts exported in the same frame and units as the base model."""
    current = storage.get("projects", key)
    data, options = imported(current)
    return rebuild(key, current, options, keep=data["sources"], uploads=files, base=False)


@app.delete("/api/projects/{key}/sources/{file}")
def remove_source(key: str, file: str):
    current = storage.get("projects", key)
    data, options = imported(current)
    source = next((s for s in data["sources"] if s["file"] == file), None)
    if not source:
        raise FileNotFoundError()
    if source["base"]:
        raise ValueError("Base model files define the car's position. Import a new model to replace them.")
    return rebuild(key, current, options, keep=[s for s in data["sources"] if s is not source])


class PartsEnabled(BaseModel):
    part_ids: list[str] = Field(min_length=1, max_length=100)
    enabled: bool


@app.put("/api/projects/{key}/parts-enabled")
def enable_parts(key: str, body: PartsEnabled):
    with storage.LOCK:
        project = storage.get("projects", key)
        data = project.get("geometry")
        if not data or not set(body.part_ids) <= {p["id"] for p in data["parts"]}:
            raise FileNotFoundError()
        for part in data["parts"]:
            if part["id"] in body.part_ids:
                part["enabled"] = body.enabled
        folder = storage.directory("projects", key) / project["geometry_dir"]
        data.update(geometry.summarize(folder, data["parts"]))
        project["settings"]["geometry_confirmed"] = False
        storage.save("projects", project)
        return project


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


def repair_revision(project):
    if not project.get("geometry"):
        raise ValueError("Import a model first.")
    return hashlib.sha256(json.dumps(project["geometry"], sort_keys=True).encode()).hexdigest()


class RepairSelection(BaseModel):
    revision: str
    selected: list[str] = Field(default_factory=list, max_length=500)


@app.get("/api/projects/{key}/repair")
def repair_report(key: str):
    current = storage.get("projects", key)
    if not current.get("geometry"):
        raise ValueError("Import a model first.")
    report, _ = repair.analyze(
        storage.directory("projects", key) / current["geometry_dir"], current["geometry"]
    )
    return dict(report, revision=repair_revision(current))


@app.post("/api/projects/{key}/repair/preview")
def repair_preview(key: str, body: RepairSelection):
    current = storage.get("projects", key)
    if repair_revision(current) != body.revision:
        raise ValueError("The model changed. Close and reopen the repair view.")
    report, _ = repair.analyze(
        storage.directory("projects", key) / current["geometry_dir"], current["geometry"], body.selected
    )
    return dict(report, revision=body.revision)


@app.post("/api/projects/{key}/repair/apply")
def repair_apply(key: str, body: RepairSelection):
    with storage.LOCK:
        current = storage.get("projects", key)
        if repair_revision(current) != body.revision:
            raise ValueError("The model changed. Close and reopen the repair view.")
        if not body.selected:
            raise ValueError("Select at least one opening.")
        root = storage.directory("projects", key)
        old = root / current["geometry_dir"]
        report, meshes = repair.analyze(old, current["geometry"], body.selected)
        folder_name = "geometry-" + storage.identifier()
        folder = root / folder_name
        folder.mkdir()
        try:
            if (old / "originals").exists():
                shutil.copytree(old / "originals", folder / "originals")
            pieces = []
            for part, mesh in zip(current["geometry"]["parts"], meshes):
                extra = {k: part[k] for k in ("source", "component", "enabled", "grouped_components") if k in part}
                pieces.append((part["name"], mesh, part["role"], part.get("wheel"), extra))
            data = geometry.persist_parts(folder, pieces)
            for field in ("sources", "import_options"):
                if field in current["geometry"]:
                    data[field] = current["geometry"][field]
            data["repaired"] = True
            data["repair_summary"] = dict(added_triangles=report["added_triangles"], moved_vertices=0)
            updated = storage.update(
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
        # Retain the prior geometry as a recoverable snapshot, including originals.
        return updated


@app.get("/api/projects/{key}/repair/export")
def repair_export(key: str, background_tasks: BackgroundTasks):
    current = storage.get("projects", key)
    repair_revision(current)
    folder = storage.directory("projects", key) / current["geometry_dir"]
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as temp:
        path = Path(temp.name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for part in current["geometry"]["parts"]:
            archive.write(folder / f"{part['id']}.stl", f"{part['id']}.stl")
        archive.writestr(
            "README.txt",
            "STLs in metres, nose -X, up +Z. Import all files together. Reassign wheel roles after importing. Includes disabled parts.\n",
        )
    background_tasks.add_task(path.unlink, missing_ok=True)
    return FileResponse(path, filename="repaired-model.zip", background=background_tasks)


class SealSelection(BaseModel):
    revision: str
    part_ids: list[str] = Field(min_length=1, max_length=100)
    pitch_mm: float = Field(default=20, ge=5, le=100, allow_inf_nan=False)
    gap_mm: float = Field(default=40, ge=0, le=200, allow_inf_nan=False)


class SealApply(BaseModel):
    token: str = Field(pattern=r"^[a-f0-9]{32}$")


SEAL_LOCK = threading.Lock()


def seal_folder(key, token):
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise FileNotFoundError()
    return storage.directory("projects", key) / "seal-previews" / token


@app.get("/api/projects/{key}/seal")
def seal_revision(key: str):
    return {"revision": repair_revision(storage.get("projects", key))}


@app.post("/api/projects/{key}/seal/preview")
def seal_preview(key: str, body: SealSelection):
    current = storage.get("projects", key)
    if repair_revision(current) != body.revision:
        raise ValueError("The model changed. Close and reopen Merge & seal.")
    parts = current["geometry"]["parts"]
    selected = set(body.part_ids)
    chosen = [p for p in parts if p["id"] in selected]
    if len(chosen) != len(selected):
        raise ValueError("Unknown part selected.")
    if any(p["role"] == "wheel" or not p.get("enabled", True) for p in chosen):
        raise ValueError("Select enabled body parts. Keep wheels separate.")
    if sum(p["triangles"] for p in chosen) > 1500000:
        raise ValueError("Select at most 1.5 million source triangles for sealing.")
    root = storage.directory("projects", key)
    old = root / current["geometry_dir"]
    if not SEAL_LOCK.acquire(blocking=False):
        raise ValueError("Another sealing preview is running. Try again when it finishes.")
    try:
        import trimesh
        meshes = {p["id"]: trimesh.load_mesh(old / f"{p['id']}.stl") for p in parts}
        combined = trimesh.util.concatenate([meshes[p["id"]] for p in chosen])
        result, report = seal.reconstruct(combined, body.pitch_mm, body.gap_mm)
        token = storage.identifier()
        folder = seal_folder(key, token)
        target = folder / "geometry"
        target.mkdir(parents=True)
        try:
            pieces = []
            inserted = False
            for part in parts:
                if part["id"] in selected:
                    if not inserted:
                        pieces.append(("Merged body", result, "body", None))
                        inserted = True
                    continue
                extra = {k: part[k] for k in ("source", "component", "enabled", "grouped_components") if k in part}
                pieces.append((part["name"], meshes[part["id"]], part["role"], part.get("wheel"), extra))
            data = geometry.persist_parts(target, pieces)
            data["repaired"] = True
            data["seal_summary"] = report
            preview = dict(token=token, revision=body.revision, geometry=data, report=report)
            (folder / "preview.json").write_text(json.dumps(preview, allow_nan=False))
            return preview
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
    finally:
        SEAL_LOCK.release()


@app.get("/api/projects/{key}/seal-previews/{token}/geometry/{part_id}.vtp")
def seal_asset(key: str, token: str, part_id: str):
    folder = seal_folder(key, token)
    preview = json.loads((folder / "preview.json").read_text())
    if part_id not in [p["id"] for p in preview["geometry"]["parts"]]:
        raise FileNotFoundError()
    return FileResponse(folder / "geometry" / f"{part_id}.vtp")


@app.delete("/api/projects/{key}/seal-previews/{token}")
def discard_seal_preview(key: str, token: str):
    with storage.LOCK:
        shutil.rmtree(seal_folder(key, token), ignore_errors=True)
    return {"discarded": True}


@app.post("/api/projects/{key}/seal/apply")
def seal_apply(key: str, body: SealApply):
    with storage.LOCK:
        current = storage.get("projects", key)
        folder = seal_folder(key, body.token)
        preview = json.loads((folder / "preview.json").read_text())
        if repair_revision(current) != preview["revision"]:
            raise ValueError("The model changed. Close and reopen Merge & seal.")
        if not preview["report"]["can_apply"]:
            raise ValueError("The preview is not one watertight body. Adjust the settings or repair manually.")
        root = storage.directory("projects", key)
        old = root / current["geometry_dir"]
        folder_name = "geometry-" + storage.identifier()
        target = root / folder_name
        shutil.copytree(folder / "geometry", target)
        try:
            if (old / "originals").exists():
                shutil.copytree(old / "originals", target / "originals")
            updated = storage.update("projects", key, geometry=preview["geometry"], geometry_dir=folder_name,
                                     sample=None, reference_case=None,
                                     settings={**current["settings"], "geometry_confirmed": False})
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise
        shutil.rmtree(folder, ignore_errors=True)
        return updated


def transform_folder(key, token):
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise FileNotFoundError()
    return storage.directory("projects", key) / "transform-previews" / token


@app.get("/api/projects/{key}/transform")
def transform_revision(key: str):
    return {"revision": repair_revision(storage.get("projects", key))}


@app.post("/api/projects/{key}/transform/preview")
def transform_preview(key: str, body: transform.TransformOptions):
    current = storage.get("projects", key)
    if repair_revision(current) != body.revision:
        raise ValueError("The model changed. Close and reopen Rotate & scale.")
    root = storage.directory("projects", key)
    token = storage.identifier()
    folder = transform_folder(key, token)
    target = folder / "geometry"
    target.mkdir(parents=True)
    try:
        data = transform.prepare(root / current["geometry_dir"], target, current["geometry"], body)
        result = dict(token=token, revision=body.revision, geometry=data)
        (folder / "preview.json").write_text(json.dumps(result, allow_nan=False))
        return result
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@app.get("/api/projects/{key}/transform-previews/{token}/geometry/{part_id}.vtp")
def transform_asset(key: str, token: str, part_id: str):
    folder = transform_folder(key, token)
    data = json.loads((folder / "preview.json").read_text())
    if part_id not in [p["id"] for p in data["geometry"]["parts"]]:
        raise FileNotFoundError()
    return FileResponse(folder / "geometry" / f"{part_id}.vtp")


@app.delete("/api/projects/{key}/transform-previews/{token}")
def discard_transform(key: str, token: str):
    with storage.LOCK:
        shutil.rmtree(transform_folder(key, token), ignore_errors=True)
    return {"discarded": True}


@app.post("/api/projects/{key}/transform/apply")
def apply_transform(key: str, body: SealApply):
    with storage.LOCK:
        current = storage.get("projects", key)
        folder = transform_folder(key, body.token)
        preview = json.loads((folder / "preview.json").read_text())
        if repair_revision(current) != preview["revision"]:
            raise ValueError("The model changed. Close and reopen Rotate & scale.")
        root = storage.directory("projects", key)
        old = root / current["geometry_dir"]
        folder_name = "geometry-" + storage.identifier()
        target = root / folder_name
        try:
            shutil.copytree(folder / "geometry", target)
            if (old / "originals").exists():
                shutil.copytree(old / "originals", target / "originals")
            updated = storage.update("projects", key, geometry=preview["geometry"], geometry_dir=folder_name,
                                     sample=None, reference_case=None,
                                     settings={**current["settings"], "geometry_confirmed": False})
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise
        shutil.rmtree(folder, ignore_errors=True)
        return updated


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
    project = storage.get("projects", key)
    data = project.get("geometry")
    if not data:
        return runner.enqueue(project)
    # A run simulates only the parts enabled when it was queued. Filtering here
    # rather than in the runner keeps the pipeline hash, so earlier runs stay comparable.
    enabled = [p for p in data["parts"] if p.get("enabled", True)]
    run = runner.enqueue({**project, "geometry": {**data, "parts": enabled}})
    return storage.update("runs", run["id"], configuration=geometry.configuration(data))


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


@app.get("/api/runs/{key}/wake")
def wake_asset(key: str):
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    with storage.LOCK:
        path = wake.tubes(storage.directory("runs", key) / "results", run["geometry"])
    return FileResponse(path)


@app.get("/api/runs/{key}/plane")
def plane_asset(key: str, axis: Literal["x", "y", "z"] = "y", position: int = 50):
    """Velocity and scalar fields resampled on a regular grid for the animated plane view."""
    if not 0 <= position <= 100:
        raise ValueError("Plane position must be between 0 and 100.")
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    with storage.LOCK:
        path = plane.plane_field(
            storage.directory("runs", key) / "results",
            axis,
            position,
            run["result"]["slice_bounds"],
            run["settings"]["speed_kmh"] / 3.6,
        )
    # Stored gzipped; the browser decompresses it transparently.
    return FileResponse(
        path, media_type="application/octet-stream", headers={"Content-Encoding": "gzip"}
    )


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

    # Per-rank folders are left out only where they duplicate the reconstructed
    # case; otherwise, as in failed runs, they may hold the only solver output.
    duplicates = {folder for case in root.glob("case-*") for folder in runner.redundant_processor_copies(case)}

    def included(path):
        if path.name in ("run.zip", "record.tmp"):
            return False
        return not any(folder in path.parents for folder in duplicates)

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


def components(run):
    """Simulated parts keyed by (source file, component), with display names and file totals."""
    data = run["geometry"]
    sources = data.get("sources") or []
    names, totals = {}, {}
    for part in data["parts"]:
        if "source" in part:
            source = sources[part["source"]]
            names[(source["file"], part["component"])] = part["name"]
            totals[source["file"]] = (source["name"], source.get("components"))
        else:
            # Sample and older geometry: the part name is the identity.
            names[(part["name"], None)] = part["name"]
    return names, totals


def part_changes(a, b):
    """Parts simulated only in a, compared per component; a file is named once when all of it differs."""
    names, totals = components(a)
    other, other_totals = components(b)
    totals = {**other_totals, **totals}
    missing = [key for key in names if key not in other]
    out = []
    for file in sorted({key[0] for key in missing}):
        keys = [key for key in missing if key[0] == file]
        name, count = totals.get(file, (None, None))
        out.extend([name] if count == len(keys) else sorted(names[key] for key in keys))
    return out


@app.get("/api/compare")
def compare(baseline: str, variant: str):
    a, b = storage.get("runs", baseline), storage.get("runs", variant)
    if any(r["status"] != "completed" for r in (a, b)):
        raise ValueError("Choose two completed runs.")
    fields = ("speed_kmh", "yaw_deg", "reference_area", "density", "moving_ground", "wheels", "quality")
    mismatch = [field for field in fields if a["settings"][field] != b["settings"][field]]
    sa, sb = Settings(**a["settings"]), Settings(**b["settings"])
    if sa.simulation_box != sb.simulation_box:
        mismatch.append("simulation box")
    if sa.quality == "custom" and sb.quality == "custom":
        if sa.custom_mesh != sb.custom_mesh:
            mismatch.append("custom mesh resolution")
        if sa.custom_iterations != sb.custom_iterations:
            mismatch.append("iteration limit")
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
    parts = None
    if a.get("geometry") and b.get("geometry"):
        parts = dict(
            same=a["geometry"]["fingerprint"] == b["geometry"]["fingerprint"],
            only_baseline=part_changes(a, b),
            only_variant=part_changes(b, a),
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
        parts=parts,
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
