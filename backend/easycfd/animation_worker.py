"""Read every transient OpenFOAM frame in a supervised extraction subprocess."""

import gzip
import json
import math
import sys
from pathlib import Path
import vtk
from vtk.util.numpy_support import vtk_to_numpy
import numpy as np
from .animation import POINTS, FRAMES
from .results import add_fields, named_blocks


def extract(case, output, run, meta):
    output.mkdir(parents=True, exist_ok=True)
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
    origin = np.array([max(d[0], low[0] - .6 * length), max(d[2], low[1] - .25 * width - .25 * length), 0.0])
    end = np.array([min(d[1], high[0] + 2.2 * length), min(d[3], high[1] + .25 * width + .25 * length), min(d[5], high[2] + .45 * length)])
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
        arrays = [velocity[:, c].copy() for c in range(3)] + [vtk_to_numpy(data.GetArray(n)).astype("<f4") for n in ("p", "k")]
        speed = vtk_to_numpy(data.GetArray("Speed"))
        valid &= np.linalg.norm(velocity, axis=1) <= speed * 1.001 + .05
        for a in arrays:
            if not np.isfinite(a[valid]).all():
                raise RuntimeError("Non-finite transient solver data.")
            a[~valid] = 0
        payload = b"".join([a.tobytes() for a in arrays] + [valid.astype("u1").tobytes()])
        (output / f"frame-{i}.bin.gz").write_bytes(gzip.compress(payload, compresslevel=1))
        frames.append(dict(time=float(time)))
    manifest = dict(version=1, engine="openfoam", timeUnit="s", model="URANS · k–ω SST", frames=frames,
                    origin=origin.tolist(), spacing=spacing.tolist(), dims=dims.tolist(), length=float(length),
                    inlet=meta["velocity"], freestream=meta["freestream"])
    (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))
    return dict(frames=len(frames), duration=float(times[-1]), model=manifest["model"])


if __name__ == "__main__":
    case, output, run_file, meta_file = map(Path, sys.argv[1:])
    result = extract(case, output, json.loads(run_file.read_text()), json.loads(meta_file.read_text()))
    (output / ".extracted.json").write_text(json.dumps(result, allow_nan=False))
