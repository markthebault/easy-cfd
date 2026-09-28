"""Endpoints for the web UI's OpenFOAM engine.

The web UI (web/) runs OpenFOAM through the existing project and run API and shows the results
with its own viewer. This module adds what that viewer needs, by resampling saved solver output
only: live force coefficients while a run solves, the finished flow on a uniform grid, surface
values at the UI's own vertices, and a run's geometry as STL. Like plane.py it is kept apart from
results.py so the pipeline hash that decides whether saved runs are comparable does not change.
"""

from pathlib import Path
import gzip
import hashlib
import json
import numpy as np
import vtk
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from scipy.spatial import cKDTree
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

from . import storage

router = APIRouter()

# Bump when sampling or encoding changes, so cached fields are rebuilt.
VERSION = 1
MAX_POINTS = 2_500_000
MAX_VERTICES = 6_000_000


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
    )


class FieldRequest(BaseModel):
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
def viz_field(key: str, request: FieldRequest):
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
        with storage.LOCK:
            payload = sample_field(results, request)
        temp = path.with_suffix(".tmp")
        temp.write_bytes(gzip.compress(payload, compresslevel=1))
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


@router.post("/api/runs/{key}/surface-samples")
async def surface_samples(key: str, request: Request):
    """Body: float32 triangle soup (x, y, z per vertex) in the run's frame. Returns float32 cp per
    vertex followed by float32 tangential velocity (3 per vertex)."""
    run = storage.get("runs", key)
    if run["status"] != "completed":
        raise ValueError("Results are not available yet.")
    body = await request.body()
    if len(body) % 36 or not body:
        raise ValueError("Surface samples need whole triangles of float32 coordinates.")
    positions = np.frombuffer(body, dtype="<f4").astype(np.float64)
    if len(positions) // 3 > MAX_VERTICES or not np.isfinite(positions).all():
        raise ValueError("Too many or invalid surface points.")
    results = storage.directory("runs", key) / "results"
    freestream = run["settings"]["speed_kmh"] / 3.6
    with storage.LOCK:
        payload = sample_surface(results, positions, freestream)
    return Response(gzip.compress(payload, compresslevel=1), media_type="application/octet-stream", headers={"Content-Encoding": "gzip"})


@router.get("/api/runs/{key}/geometry/{part_id}.stl")
def run_geometry_stl(key: str, part_id: str):
    """A run's part in its solved position (binary STL), for opening old runs in the web UI."""
    run = storage.get("runs", key)
    if part_id not in {p["id"] for p in run["geometry"]["parts"]}:
        raise FileNotFoundError()
    return FileResponse(storage.directory("runs", key) / "geometry" / f"{part_id}.stl", media_type="model/stl")
