"""Read every transient OpenFOAM frame in a supervised extraction subprocess."""

import gzip
import json
import math
import sys
from pathlib import Path
import vtk
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy
import numpy as np
from .animation import POINTS, FRAMES
from .results import add_fields, named_blocks


def extract(case, output, run, meta):
    output.mkdir(parents=True, exist_ok=True)
    if run["settings"].get("flow_detail") == "fine":
        return extract_sections(case, output, run, meta)
    reader = vtk.vtkOpenFOAMReader()
    reader.SetFileName(str(case / "case.foam"))
    reader.CreateCellToPointOn()
    reader.EnableAllCellArrays()
    reader.UpdateInformation()
    reader.EnableAllPatchArrays()
    times = [reader.GetTimeValues().GetValue(i) for i in range(reader.GetTimeValues().GetNumberOfTuples())]
    if len(times) < 2 or len(times) > FRAMES + 2 or times[0] != 0 or np.any(np.diff(times) <= 0):
        raise RuntimeError("Transient flow timestamps are missing, unordered or exceed the frame budget.")
    low, high = np.array(run["geometry"]["bounds"])
    length, width = high[0] - low[0], high[1] - low[1]
    d = meta["domain"]
    origin = np.array(
        [max(d[0], low[0] - 0.6 * length), max(d[2], low[1] - 0.25 * width - 0.25 * length), 0.0]
    )
    end = np.array(
        [
            min(d[1], high[0] + 2.2 * length),
            min(d[3], high[1] + 0.25 * width + 0.25 * length),
            min(d[5], high[2] + 0.45 * length),
        ]
    )
    h = math.cbrt(float(np.prod(end - origin)) / POINTS)
    dims = np.maximum(8, np.rint((end - origin) / h).astype(int))
    spacing = (end - origin) / (dims - 1)
    grid = vtk.vtkImageData()
    grid.SetDimensions(*map(int, dims))
    grid.SetOrigin(*origin)
    grid.SetSpacing(*spacing)
    frames = []
    for i, time in enumerate(times):
        reader.UpdateTimeStep(time)
        reader.Update()
        volume = next((b for name, b in named_blocks(reader.GetOutput()) if name == "internalMesh"), None)
        if volume is None:
            raise RuntimeError("Transient frame has no fluid mesh.")
        probe = vtk.vtkProbeFilter()
        probe.SetInputData(grid)
        probe.SetSourceData(add_fields(volume, run["settings"]["density"]))
        probe.Update()
        data = probe.GetOutput().GetPointData()
        valid = vtk_to_numpy(data.GetArray("vtkValidPointMask")).astype(bool)
        velocity = vtk_to_numpy(data.GetArray("U")).astype("<f4")
        arrays = [velocity[:, c].copy() for c in range(3)] + [
            vtk_to_numpy(data.GetArray(n)).astype("<f4") for n in ("p", "k")
        ]
        speed = vtk_to_numpy(data.GetArray("Speed"))
        valid &= np.linalg.norm(velocity, axis=1) <= speed * 1.001 + 0.05
        for a in arrays:
            if not np.isfinite(a[valid]).all():
                raise RuntimeError("Non-finite transient solver data.")
            a[~valid] = 0
        payload = b"".join([a.tobytes() for a in arrays] + [valid.astype("u1").tobytes()])
        (output / f"frame-{i}.bin.gz").write_bytes(gzip.compress(payload, compresslevel=1))
        frames.append(dict(time=float(time)))
    manifest = dict(
        version=1,
        engine="openfoam",
        timeUnit="s",
        model="URANS · k–ω SST",
        frames=frames,
        origin=origin.tolist(),
        spacing=spacing.tolist(),
        dims=dims.tolist(),
        length=float(length),
        inlet=meta["velocity"],
        freestream=meta["freestream"],
    )
    (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))
    return dict(frames=len(frames), duration=float(times[-1]), model=manifest["model"])


def section_source(folder, name):
    """Read either VTK writer format; older writers split fields into separate files."""
    files = sorted(
        p
        for p in folder.iterdir()
        if p.suffix in (".vtk", ".vtp") and (p.stem == name or p.stem.endswith("_" + name))
    )
    if not files:
        raise RuntimeError(f"Native section {name} is missing at {folder.name}.")
    combined = None
    for file in files:
        reader = vtk.vtkXMLPolyDataReader() if file.suffix == ".vtp" else vtk.vtkPolyDataReader()
        reader.SetFileName(str(file))
        if file.suffix == ".vtk":
            reader.ReadAllScalarsOn()
            reader.ReadAllVectorsOn()
        reader.Update()
        data = reader.GetOutput()
        if combined is None:
            combined = vtk.vtkPolyData()
            combined.DeepCopy(data)
        else:
            for getter in ("GetPointData", "GetCellData"):
                arrays, target = getattr(data, getter)(), getattr(combined, getter)()
                for i in range(arrays.GetNumberOfArrays()):
                    target.AddArray(arrays.GetArray(i))
    if combined.GetPointData().GetArray("U") is None:
        convert = vtk.vtkCellDataToPointData()
        convert.SetInputData(combined)
        convert.Update()
        result = vtk.vtkPolyData()
        result.DeepCopy(convert.GetOutput())
        combined = result
    return combined


def sample_section(source, section):
    grid = vtk.vtkImageData()
    grid.SetDimensions(*section["dims"])
    # Project writer roundoff onto the exact cutting plane. Near y=0, independent
    # intersection calculations can otherwise leave infinitesimal non-coplanar faces.
    # Only the normal coordinate changes; mesh connectivity and field values stay intact.
    axis = section["axis"]
    projected = vtk.vtkPolyData()
    projected.ShallowCopy(source)
    xyz = vtk_to_numpy(source.GetPoints().GetData()).astype(np.float64)
    xyz[:, axis] = section["origin"][axis]
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(xyz, deep=True))
    projected.SetPoints(points)
    triangles = vtk.vtkTriangleFilter()
    triangles.SetInputData(projected)
    triangles.PassLinesOff()
    triangles.PassVertsOff()
    triangles.Update()
    grid.SetOrigin(*section["origin"])
    grid.SetSpacing(*section["spacing"])
    probe = vtk.vtkProbeFilter()
    probe.SetInputData(grid)
    probe.SetSourceData(triangles.GetOutput())
    probe.SetCellLocatorPrototype(vtk.vtkStaticCellLocator())
    probe.Update()
    data = probe.GetOutput().GetPointData()
    valid = vtk_to_numpy(data.GetArray("vtkValidPointMask")).astype(bool)
    if not valid.any():
        raise RuntimeError("Native section did not contain any fluid samples.")
    velocity = vtk_to_numpy(data.GetArray("U")).astype("<f4")
    arrays = [velocity[:, c].copy() for c in range(3)]
    arrays += [vtk_to_numpy(data.GetArray(n)).astype("<f4") for n in ("p", "k")]
    for a in arrays:
        if not np.isfinite(a[valid]).all():
            raise RuntimeError("Non-finite detailed flow data.")
        a[~valid] = 0
    return b"".join([a.tobytes() for a in arrays] + [valid.astype("u1").tobytes()])


def extract_sections(case, output, run, meta):
    from .fineflow import FRAMES, MODEL

    plan = json.loads((case / "recording.json").read_text())
    root = case / "postProcessing/fineSections"
    folders = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: float(p.name))
    if not FRAMES - 3 <= len(folders) <= FRAMES + 3:
        raise RuntimeError(f"Detailed recording has {len(folders)} native frames; expected about {FRAMES}.")
    start = float(folders[0].name)
    frames = [dict(time=float(p.name) - start) for p in folders]
    if not np.all(np.diff([f["time"] for f in frames]) > 0):
        raise RuntimeError("Detailed timestamps are not increasing.")
    for section in plan["sections"]:
        dest = output / "sections" / section["id"]
        dest.mkdir(parents=True, exist_ok=True)
        for i, folder in enumerate(folders):
            payload = sample_section(section_source(folder, section["id"]), section)
            (dest / f"frame-{i}.bin.gz").write_bytes(gzip.compress(payload, compresslevel=1))
    first = plan["sections"][0]
    manifest = dict(
        version=2,
        engine="openfoam",
        timeUnit="s",
        model=MODEL,
        frames=frames,
        sections=plan["sections"],
        section=first["id"],
        origin=first["origin"],
        spacing=first["spacing"],
        dims=first["dims"],
        length=float(run["geometry"]["bounds"][1][0] - run["geometry"]["bounds"][0][0]),
        inlet=meta["velocity"],
        freestream=meta["freestream"],
        source_sha256=plan.get("source_sha256"),
        dictionaries_sha256=plan.get("dictionaries_sha256"),
        continuation=plan.get("continuation"),
        integration=plan.get("integration"),
        warmupSeconds=start,
        warmupPasses=plan["warmup"]
        * meta["freestream"]
        / (run["geometry"]["bounds"][1][0] - run["geometry"]["bounds"][0][0]),
    )
    (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))
    return dict(
        frames=len(frames),
        duration=frames[-1]["time"],
        model=MODEL,
        detail="fine",
        sections=len(plan["sections"]),
        warmup_seconds=start,
    )


if __name__ == "__main__":
    case, output, run_file, meta_file = map(Path, sys.argv[1:])
    result = extract(case, output, json.loads(run_file.read_text()), json.loads(meta_file.read_text()))
    (output / ".extracted.json").write_text(json.dumps(result, allow_nan=False))
