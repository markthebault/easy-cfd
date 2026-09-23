"""Regular 2D grids of calculated fields on a plane, for the animated flow view.

A separate module from results.py, so adding this view does not change the
pipeline hash that decides whether saved runs are comparable. It only
resamples saved solver output; nothing is extrapolated or filled in.
"""

from pathlib import Path
import gzip
import json
import struct
import numpy as np
import vtk
from vtk.util.numpy_support import vtk_to_numpy

LONG_SIDE = 640
# Cross-sections are much smaller than the flow window; this keeps them sharp.
MIN_LONG_SIDE = 320
MAGIC = b"ECFP"
# Part of the cache file name: bump when sampling or encoding changes, so
# planes cached by an older version are rebuilt instead of served.
VERSION = 2
FIELDS = ("Speed", "Pressure", "Turbulence")
# Screen axes per plane: (world axis index, sign) for right and up. Cross-sections
# look downstream from the nose, like the Front camera, so +Y is on the left.
SCREEN = {"y": ((0, 1), (2, 1)), "z": ((0, 1), (1, 1)), "x": ((1, -1), (2, 1))}


def quantize(values, low, high):
    span = high - low or 1.0
    return np.round((values - low) / span * 65534 - 32767).astype("<i2")


def interpolated(velocity, speed):
    """True where probe weights were convex, so the value lies within its cell's data.

    Convex interpolation keeps |interpolated U| at or below the interpolated speed.
    Where it exceeds it, the probe extrapolated, which happens rarely in
    polyhedral cells at the wall; those points are masked rather than shown.
    """
    magnitude = np.linalg.norm(velocity, axis=-1)
    return (speed >= 0) & (magnitude <= speed * 1.001 + 0.05)


def plane_field(output: Path, axis: str, fraction: int, bounds, reference_speed: float):
    """Gzipped binary grid: magic, header length, JSON header, int16 fields, uint8 mask.

    Rows run bottom to top and columns left to right as drawn on screen. Points
    outside the fluid mesh (inside the car) are masked, never interpolated.
    """
    path = output / f"plane-v{VERSION}-{axis}-{fraction}.bin.gz"
    if path.exists():
        return path
    normal = "xyz".index(axis)
    (right, right_sign), (up, up_sign) = SCREEN[axis]
    extent = [(bounds[2 * k], bounds[2 * k + 1]) for k in range(3)]
    width, height = (extent[right][1] - extent[right][0]), (extent[up][1] - extent[up][0])
    # One spacing for every plane of a run (the flow window's length over
    # LONG_SIDE points), refined only where a plane would otherwise be coarse.
    step = min((extent[0][1] - extent[0][0]) / (LONG_SIDE - 1), max(width, height) / (MIN_LONG_SIDE - 1))
    nx, ny = max(48, round(width / step) + 1), max(48, round(height / step) + 1)
    counts = [1, 1, 1]
    counts[right], counts[up] = nx, ny
    origin = [lo for lo, _ in extent]
    origin[normal] = extent[normal][0] + fraction / 100 * (extent[normal][1] - extent[normal][0])
    spacing = [1.0, 1.0, 1.0]
    spacing[right], spacing[up] = width / (nx - 1), height / (ny - 1)
    grid = vtk.vtkImageData()
    grid.SetDimensions(counts)
    grid.SetOrigin(origin)
    grid.SetSpacing(spacing)
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(output / "volume.vtu"))
    probe = vtk.vtkProbeFilter()
    probe.SetInputData(grid)
    probe.SetSourceConnection(reader.GetOutputPort())
    probe.Update()
    data = probe.GetOutput().GetPointData()

    def layout(values):
        # vtkImageData varies the lower world axis fastest, and every SCREEN
        # entry puts that axis to the right, so points reshape straight into
        # bottom-to-top rows; columns flip where the screen axis is negated.
        values = values.reshape((ny, nx) + values.shape[1:])
        return values[:, ::-1] if right_sign < 0 else values

    valid = layout(vtk_to_numpy(data.GetArray("vtkValidPointMask")).astype(bool))
    velocity = layout(vtk_to_numpy(data.GetArray("U")).astype(float))
    arrays = {
        "u": velocity[..., right] * right_sign,
        "v": velocity[..., up] * up_sign,
    }
    for name in FIELDS:
        array = data.GetArray(name)
        if array is not None:
            arrays[name] = layout(vtk_to_numpy(array).astype(float))
    if "Speed" in arrays:
        valid &= interpolated(velocity, arrays["Speed"])
    fields, blobs = [], []
    reach = max(
        float(np.abs(arrays["u"][valid]).max(initial=0)), float(np.abs(arrays["v"][valid]).max(initial=0))
    )
    for name, values in arrays.items():
        chosen = values[valid]
        if name in ("u", "v"):
            low, high = -reach, reach
        else:
            low, high = (float(chosen.min()), float(chosen.max())) if chosen.size else (0.0, 0.0)
        fields.append(dict(name=name, min=low, max=high))
        blobs.append(quantize(np.where(valid, values, low), low, high).tobytes())
    left_edge, right_edge = extent[right] if right_sign > 0 else extent[right][::-1]
    header = dict(
        axis=axis,
        nx=nx,
        ny=ny,
        position=origin[normal],
        horizontal="XYZ"[right],
        vertical="XYZ"[up],
        left=left_edge,
        right=right_edge,
        bottom=extent[up][0],
        top=extent[up][1],
        width=width,
        height=height,
        reference_speed=reference_speed,
        valid_fraction=float(valid.mean()),
        fields=fields,
    )
    text = json.dumps(header).encode()
    text += b" " * (-len(text) % 4)
    payload = MAGIC + struct.pack("<I", len(text)) + text + b"".join(blobs) + valid.astype(np.uint8).tobytes()
    temp = path.with_suffix(".tmp")
    temp.write_bytes(gzip.compress(payload, compresslevel=6))
    temp.replace(path)
    return path


def read(path: Path):
    """Decode a plane file; the inverse of plane_field, used by tests and tools."""
    payload = gzip.decompress(path.read_bytes())
    if payload[:4] != MAGIC:
        raise ValueError("Not a plane field file.")
    (size,) = struct.unpack("<I", payload[4:8])
    header = json.loads(payload[8 : 8 + size])
    offset, count, out = 8 + size, header["nx"] * header["ny"], {}
    for field in header["fields"]:
        raw = np.frombuffer(payload, "<i2", count, offset).astype(float)
        out[field["name"]] = ((raw + 32767) / 65534 * (field["max"] - field["min"]) + field["min"]).reshape(
            header["ny"], header["nx"]
        )
        offset += 2 * count
    out["valid"] = (
        np.frombuffer(payload, np.uint8, count, offset).astype(bool).reshape(header["ny"], header["nx"])
    )
    return header, out
