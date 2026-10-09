"""Endpoints for the web UI's OpenFOAM engine.

The web UI (web/) runs OpenFOAM through the existing project and run API and shows the results
with its own viewer. This module adds what that viewer needs, by resampling saved solver output
only: live force coefficients while a run solves, the finished flow on a uniform grid, surface
values at the UI's own vertices, and a run's geometry as STL. Like plane.py it is kept apart from
results.py so the pipeline hash that decides whether saved runs are comparable does not change.
"""

from pathlib import Path
import asyncio
import subprocess
import sys
import tempfile
import threading
import time
import psutil
import hashlib
import json
import numpy as np
import vtk
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from scipy.spatial import cKDTree
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

from . import storage

router = APIRouter()

# Bump when sampling or encoding changes, so cached fields are rebuilt.
VERSION = 2
MAX_POINTS = 2_500_000
MAX_VERTICES = 6_000_000
STRESS_QUERY_CHUNK = 65_536
SAMPLING_LOCK = threading.Lock()


async def bounded_sample(request: Request, args, body=None):
    """Serialize native sampling outside the API, with disconnect, time and RSS guards."""
    start = time.monotonic()
    while not SAMPLING_LOCK.acquire(blocking=False):
        if await request.is_disconnected() or time.monotonic() - start > 120:
            raise ValueError("Field sampling was cancelled or its queue exceeded two minutes.")
        await asyncio.sleep(0.1)
    try:
        with tempfile.TemporaryDirectory(prefix="easycfd-sample-") as temp:
            folder = Path(temp)
            (folder / "request.json").write_text(json.dumps(args))
            if body is not None:
                (folder / "positions.bin").write_bytes(body)
            with (folder / "log.txt").open("w") as log:
                process = subprocess.Popen(
                    [sys.executable, "-m", "easycfd.sample_worker", temp],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                try:
                    while process.poll() is None:
                        if await request.is_disconnected():
                            raise ValueError("Field sampling cancelled because the viewer disconnected.")
                        if time.monotonic() - start > 120:
                            raise ValueError(
                                "Field sampling exceeded its two-minute limit. Request fewer points."
                            )
                        try:
                            rss = psutil.Process(process.pid).memory_info().rss
                        except psutil.NoSuchProcess:
                            continue
                        if rss > 3 * 1024**3 or rss + psutil.Process().memory_info().rss > 8 * 1024**3:
                            raise ValueError(
                                "Field sampling exceeded its memory ceiling. Request fewer points."
                            )
                        await asyncio.sleep(0.1)
                    if process.returncode:
                        raise ValueError("Field sampling failed: " + (folder / "log.txt").read_text()[-2000:])
                    return (folder / "response.bin.gz").read_bytes()
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
    finally:
        SAMPLING_LOCK.release()


def coefficient_rows(case: Path):
    """(iteration, Cd, Cl) rows of a force-coefficient file that may still be written."""
    candidates = sorted((case / "postProcessing/coefficients").glob("*/coefficient.dat"))
    if not candidates:
        return []
    header, rows = None, []
    for line in candidates[0].read_text(errors="replace").splitlines():
        if line.startswith("# Time"):
            header = line.lstrip("# ").split()
        elif line and not line.startswith("#") and header:
            parts = line.split()
            if len(parts) != len(header):
                continue  # the last line may be half written
            try:
                values = [float(x) for x in parts]
            except ValueError:
                continue
            rows.append((values[0], values[header.index("Cd")], values[header.index("Cl")]))
    return [r for r in rows if all(np.isfinite(r))]


def active_case(root: Path):
    """The case folder being solved: the most recently written one (Precise runs two tiers)."""
    cases = [p for p in root.glob("case-*") if p.is_dir()]
    return max(cases, key=lambda p: p.stat().st_mtime) if cases else None


@router.get("/api/runs/{key}/live")
def live(key: str, every: int = 1):
    """Stage, iteration and the force history so far, for the live panel."""
    run = storage.get("runs", key)
    case = active_case(storage.directory("runs", key))
    rows = coefficient_rows(case) if case else []
    step = max(1, int(every))
    history = [dict(iteration=i, cd=cd, cl=cl) for i, cd, cl in rows[::step]]
    if rows and (not history or history[-1]["iteration"] != rows[-1][0]):
        history.append(dict(iteration=rows[-1][0], cd=rows[-1][1], cl=rows[-1][2]))
    return dict(
        status=run["status"],
        stage=run.get("stage"),
        iteration=run.get("iteration", 0),
        case=case.name if case else None,
        error=run.get("error"),
        history=history,
        recording_time_seconds=run.get("recording_time_seconds"),
        recording_duration_seconds=run.get("recording_duration_seconds"),
    )


class FieldRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    origin: tuple[float, float, float]
    spacing: tuple[float, float, float] = Field(description="Positive grid spacing per axis (m)")
    dims: tuple[int, int, int]


def volume_reader(results: Path):
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(results / "volume.vtu"))
    return reader


def sample_field(results: Path, request: FieldRequest) -> bytes:
    """Little-endian float32 u, v, w, p (kinematic), k and a uint8 valid mask, x fastest."""
    nx, ny, nz = request.dims
    grid = vtk.vtkImageData()
    grid.SetDimensions(nx, ny, nz)
    grid.SetOrigin(request.origin)
    grid.SetSpacing(request.spacing)
    reader = volume_reader(results)  # keep a reference: the probe only holds its output port
    probe = vtk.vtkProbeFilter()
    probe.SetInputData(grid)
    probe.SetSourceConnection(reader.GetOutputPort())
    probe.Update()
    data = probe.GetOutput().GetPointData()
    valid = vtk_to_numpy(data.GetArray("vtkValidPointMask")).astype(bool)
    velocity = vtk_to_numpy(data.GetArray("U")).astype(np.float32).reshape(-1, 3)
    pressure = vtk_to_numpy(data.GetArray("p")).astype(np.float32)
    k = vtk_to_numpy(data.GetArray("k")).astype(np.float32)
    # Points probed across a wall can extrapolate; the speed field bounds a convex interpolation.
    speed_array = data.GetArray("Speed")
    if speed_array is not None:
        speed = vtk_to_numpy(speed_array).astype(np.float32)
        valid &= np.linalg.norm(velocity, axis=1) <= speed * 1.001 + 0.05
    for a in (velocity, pressure, k):
        a[~valid] = 0
    return b"".join(
        [np.ascontiguousarray(velocity[:, c]).tobytes() for c in range(3)]
        + [pressure.tobytes(), k.tobytes(), valid.astype(np.uint8).tobytes()]
    )


@router.post("/api/runs/{key}/viz-field")
async def viz_field(key: str, request: FieldRequest, connection: Request):
    """The finished flow on a uniform grid given in the run's geometry frame (gzipped binary)."""
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    nx, ny, nz = request.dims
    if min(request.dims) < 2 or nx * ny * nz > MAX_POINTS or min(request.spacing) <= 0:
        raise ValueError("Requested flow grid is empty or too large.")
    results = storage.directory("runs", key) / "results"
    tag = hashlib.sha256(json.dumps([VERSION, request.model_dump()]).encode()).hexdigest()[:16]
    path = results / f"vizfield-{tag}.bin.gz"
    if not path.exists():
        payload = await bounded_sample(
            connection, {"kind": "field", "results": str(results), "grid": request.model_dump()}
        )
        temp = path.with_suffix(".tmp")
        temp.write_bytes(payload)
        temp.replace(path)
    return FileResponse(path, media_type="application/octet-stream", headers={"Content-Encoding": "gzip"})


def sample_surface(results: Path, positions: np.ndarray, freestream: float) -> bytes:
    """Pressure coefficient and near-wall flow direction at soup vertices (9 floats per triangle).

    The pressure comes from the nearest point of the solved wall surface, looked up a little inside
    each triangle (a quarter of the way to its centroid) so a vertex on a sharp edge takes its
    face's value rather than the edge's suction peak: the viewer interpolates across triangles, and
    coarse faces (the sample car's nose is two triangles) would otherwise show only edge values. On
    finely meshed cars the shift is a few millimetres.
    The flow direction is the tangential velocity a little off the wall along each triangle's
    normal, as in the web solver.
    """
    tri = positions.reshape(-1, 3, 3)
    vertices = positions.reshape(-1, 3)
    surface_reader = vtk.vtkXMLPolyDataReader()
    surface_reader.SetFileName(str(results / "surface.vtp"))
    surface_reader.Update()
    surface = surface_reader.GetOutput()
    wall_points = vtk_to_numpy(surface.GetPoints().GetData()).astype(np.float64)
    wall_p = vtk_to_numpy(surface.GetPointData().GetArray("p")).astype(np.float64)
    centroid = np.repeat(tri.mean(axis=1), 3, axis=0)
    _, nearest = cKDTree(wall_points).query(vertices + 0.25 * (centroid - vertices))
    q = 0.5 * freestream * freestream
    cp = (wall_p[nearest] / q).astype(np.float32)

    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-30)
    normal_per_vertex = np.repeat(normals, 3, axis=0)
    offset_points = vertices + 0.02 * normal_per_vertex
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(offset_points.astype(np.float64), deep=True))
    probe_input = vtk.vtkPolyData()
    probe_input.SetPoints(points)
    reader = volume_reader(results)
    probe = vtk.vtkProbeFilter()
    probe.SetInputData(probe_input)
    probe.SetSourceConnection(reader.GetOutputPort())
    probe.Update()
    data = probe.GetOutput().GetPointData()
    velocity = vtk_to_numpy(data.GetArray("U")).astype(np.float64).reshape(-1, 3)
    valid = vtk_to_numpy(data.GetArray("vtkValidPointMask")).astype(bool)
    tangential = velocity - np.sum(velocity * normal_per_vertex, axis=1, keepdims=True) * normal_per_vertex
    tangential[~valid] = 0
    return cp.tobytes() + tangential.astype(np.float32).tobytes()


def sample_stress(results: Path, positions: np.ndarray, part_id: str):
    """Nearest native wall cell on this part and this side; never across a thin wing."""
    n = len(positions) // 3
    stress = np.full((n, 3), np.nan, dtype="<f4")
    valid = np.zeros(n, dtype=np.uint8)
    file = results / f"{part_id}.vtp"
    if not file.exists():
        return stress, valid
    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(file))
    reader.Update()
    poly = reader.GetOutput()
    tau = poly.GetCellData().GetArray("WallStressPa")
    if tau is None:
        return stress, valid
    normals_filter = vtk.vtkPolyDataNormals()
    normals_filter.SetInputData(poly)
    normals_filter.ComputeCellNormalsOn()
    normals_filter.ComputePointNormalsOff()
    normals_filter.SplittingOff()
    normals_filter.ConsistencyOff()
    normals_filter.AutoOrientNormalsOff()
    normals_filter.Update()
    normals = vtk_to_numpy(normals_filter.GetOutput().GetCellData().GetNormals())
    centres = vtk.vtkCellCenters()
    centres.SetInputData(poly)
    centres.Update()
    points = vtk_to_numpy(centres.GetOutput().GetPoints().GetData())
    sizes = vtk.vtkCellSizeFilter()
    sizes.SetInputData(poly)
    sizes.ComputeAreaOn()
    sizes.Update()
    area = vtk_to_numpy(sizes.GetOutput().GetCellData().GetArray("Area"))
    values = vtk_to_numpy(tau)
    tri = positions.reshape(-1, 3, 3)
    outward = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    magnitude = np.linalg.norm(outward, axis=1)
    degenerate = np.repeat(magnitude <= 1e-30, 3)
    outward /= np.maximum(magnitude[:, None], 1e-30)
    outward = np.repeat(outward, 3, axis=0)
    # VTK boundary polygons preserve the fluid's outward normal (toward the solid).
    tree = cKDTree(points)
    valid.fill(2)
    # A large CAD assembly has millions of soup vertices. Gathering all 32 candidate
    # normals at once exhausts the worker's RSS limit; keep identical matches in batches.
    vertices = positions.reshape(-1, 3)
    for start in range(0, n, STRESS_QUERY_CHUNK):
        end = min(start + STRESS_QUERY_CHUNK, n)
        distance, index = tree.query(vertices[start:end], k=min(32, len(points)))
        distance = np.asarray(distance).reshape(end - start, -1)
        index = np.asarray(index).reshape(end - start, -1)
        aligned = np.sum(normals[index] * outward[start:end, None, :], axis=2) < -0.25
        nearby = distance <= 2 * np.sqrt(np.maximum(area[index], 1e-30))
        matches = aligned & nearby
        good = matches.any(axis=1)
        chosen = index[np.arange(end - start), matches.argmax(axis=1)]
        stress_chunk = stress[start:end]
        stress_chunk[good] = values[chosen[good]]
        valid[start:end][good] = np.where(np.isfinite(stress_chunk[good]).all(axis=1), 1, 3)
    valid[degenerate] = 3
    return stress, valid


@router.post("/api/runs/{key}/surface-samples")
async def surface_samples(key: str, request: Request, version: int = 1, part_id: str | None = None):
    """Body: float32 triangle soup (x, y, z per vertex) in the run's frame. Returns float32 cp per
    vertex followed by float32 tangential velocity (3 per vertex)."""
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_VERTICES * 12:
            raise ValueError("Too many surface points; request fewer parts or vertices.")
        body.extend(chunk)
    if len(body) % 36 or not body:
        raise ValueError("Surface samples need whole triangles of float32 coordinates.")
    positions = np.frombuffer(body, dtype="<f4")
    if len(positions) // 3 > MAX_VERTICES or not np.isfinite(positions).all():
        raise ValueError("Too many or invalid surface points.")
    results = storage.directory("runs", key) / "results"
    if version not in (1, 2):
        raise ValueError("Unsupported surface sample format.")
    if version == 2 and part_id not in {p["id"] for p in run["geometry"]["parts"]}:
        raise ValueError("Version 2 requires a part ID from this saved run.")
    freestream = run.get("result", {}).get("freestream") or run["settings"]["speed_kmh"] / 3.6 / np.cos(
        np.deg2rad(run["settings"].get("yaw_deg", 0))
    )
    payload = await bounded_sample(
        request,
        {
            "kind": "surface",
            "results": str(results),
            "freestream": float(freestream),
            "version": version,
            "part_id": part_id,
            "iteration": int(run.get("result", {}).get("iteration", 0)),
        },
        body,
    )
    return Response(
        payload,
        media_type="application/octet-stream",
        headers={"Content-Encoding": "gzip"},
    )


@router.get("/api/runs/{key}/geometry/{part_id}.stl")
def run_geometry_stl(key: str, part_id: str):
    """A run's part in its solved position (binary STL), for opening old runs in the web UI."""
    run = storage.get("runs", key)
    if part_id not in {p["id"] for p in run["geometry"]["parts"]}:
        raise FileNotFoundError()
    return FileResponse(
        storage.directory("runs", key) / "geometry" / f"{part_id}.stl", media_type="model/stl"
    )


@router.get("/api/runs/{key}/animation")
def animation_manifest(key: str, section: str | None = None):
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Flow animation is available when the run finishes.")
    path = storage.directory("runs", key) / "animation/manifest.json"
    if not path.exists():
        raise ValueError("This run has no flow animation. Enable Record flow animation and run again.")
    manifest = json.loads(path.read_text())
    if manifest.get("version") == 2:
        selected = section or manifest["section"]
        plane = next((p for p in manifest["sections"] if p["id"] == selected), None)
        if plane is None or selected not in ("top", "upper", "side", "wheels"):
            raise ValueError("Unknown recorded section.")
        manifest.update(section=selected, **{k: plane[k] for k in ("origin", "spacing", "dims")})
    elif section is not None:
        raise ValueError("This recording uses a volume field, not separate sections.")
    return manifest


@router.get("/api/runs/{key}/animation/{frame}")
def animation_frame(key: str, frame: int, section: str | None = None):
    manifest = animation_manifest(key, section)
    if not 0 <= frame < len(manifest["frames"]):
        raise ValueError("Unknown animation frame.")
    folder = storage.directory("runs", key) / "animation"
    if manifest.get("version") == 2:
        folder = folder / "sections" / manifest["section"]
    path = folder / f"frame-{frame}.bin.gz"
    return FileResponse(path, media_type="application/octet-stream", headers={"Content-Encoding": "gzip"})
