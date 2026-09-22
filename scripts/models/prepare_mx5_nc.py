"""Reproduce the superseded first NC reconstruction.

Use refine_mx5_nc.py for the current, smoother surface.

This deliberately reconstructs a simplified, sealed exterior on a 10 mm voxel
lattice. It is not a scan or engineering CAD model. Keep the original GLB.
"""

from pathlib import Path
import json
import struct
import hashlib
import numpy as np
import trimesh
from scipy import ndimage
from skimage.measure import marching_cubes

root = Path(".easycfd/imports/mx5-nc")
raw = (root / "source.glb").read_bytes()
json_length = struct.unpack_from("<I", raw, 12)[0]
source_metadata = json.loads(raw[20 : 20 + json_length])["asset"].get("extras", {})
scene = trimesh.load(root / "source.glb", force="scene")
# Source is about 400 coordinate units long. Treat these as centimetres.
# This yields a 3.996 m car; no independent dimensional calibration is claimed.
meshes = []
for node in scene.graph.nodes_geometry:
    transform, name = scene.graph[node]
    mesh = scene.geometry[name].copy()
    material = getattr(mesh.visual.material, "name", "")
    if material in ("interior", "brakedisk", "material", "tire"):
        continue
    mesh.apply_transform(transform)
    mesh.apply_scale(0.01)
    meshes.append(mesh)
body = trimesh.util.concatenate(meshes)
body.merge_vertices()
body.update_faces(body.unique_faces())
body.update_faces(body.nondegenerate_faces())
body.remove_unreferenced_vertices()
body = body.simplify_quadric_decimation(face_count=120000)
print("Body surface", len(body.faces), body.bounds, flush=True)
pitch = 0.01
vox = body.voxelized(pitch)
matrix = np.pad(vox.matrix, 5)
closed = ndimage.binary_closing(matrix, iterations=2)
# Seal the missing underbody/cabin using the vertical exterior envelope.
# This is a deliberate geometric approximation, not automatic CAD repair.
filled = np.maximum.accumulate(closed, axis=2) & np.maximum.accumulate(closed[:, :, ::-1], axis=2)[:, :, ::-1]
# Restore simplified wheel housings after sealing the underbody.
# 20 mm radial clearance and 20 mm axial clearance avoid intersecting surfaces.
coords = [np.arange(n) * pitch + vox.transform[i, 3] - 5 * pitch for i, n in enumerate(filled.shape)]
xx, yy, zz = np.ix_(*coords)
for cx in (-0.715555, 0.718355):
    for cy in (-1.220275, 1.07626):
        housing = (abs(xx - cx) < 0.125) & ((yy - cy) ** 2 + (zz - 0.313455) ** 2 < 0.333455**2)
        filled[housing] = False
filled = ndimage.binary_opening(filled, iterations=1)
filled = ndimage.binary_fill_holes(filled)
print("Surface/closed/filled voxels", matrix.sum(), closed.sum(), filled.sum(), flush=True)
verts, faces, _, _ = marching_cubes(
    filled.astype(np.float32),
    level=0.5,
    spacing=(pitch,) * 3,
    allow_degenerate=False,
    gradient_direction="ascent",
)
verts += vox.transform[:3, 3] - 5 * pitch
body = trimesh.Trimesh(verts, faces, process=True)
parts = sorted(body.split(), key=lambda m: abs(m.volume), reverse=True)
print("Parts", [(len(p.faces), round(p.volume, 3)) for p in parts[:10]], flush=True)
body = parts[0]
trimesh.smoothing.filter_taubin(body, iterations=10)
simplified = body.simplify_quadric_decimation(face_count=60000)
if simplified.is_watertight:
    body = simplified
body.fix_normals(multibody=True)
assert body.is_watertight and body.volume > 1, "Reconstruction did not produce a closed body"
body.export(root / "body.stl")
print("BODY", body.is_watertight, body.volume, body.bounds, flush=True)
# Closed convex tire envelopes omit spoke openings and brake detail.
tires = []
for node in scene.graph.nodes_geometry:
    transform, name = scene.graph[node]
    mesh = scene.geometry[name].copy()
    if getattr(mesh.visual.material, "name", "") != "tire":
        continue
    mesh.apply_transform(transform)
    mesh.apply_scale(0.01)
    tires.append(mesh.vertices)
points = np.concatenate(tires)
for side in (-1, 1):
    for end in (-1, 1):
        v = points[(points[:, 0] * side > 0) & (points[:, 1] * end > 0)]
        wheel = trimesh.convex.convex_hull(v)
        wheel.export(root / f"wheel-{side}-{end}.stl")
        print("WHEEL", side, end, wheel.bounds.tolist(), flush=True)
(root / "preparation.json").write_text(
    json.dumps(
        dict(
            source="User supplied GLB, 2009 Mazda MX-5 NC",
            original_metadata=source_metadata,
            source_sha256=hashlib.sha256(raw).hexdigest(),
            scale=0.01,
            pitch_m=pitch,
            closing_iterations=2,
            body_volume_m3=body.volume,
            limitations=[
                "Visualization geometry, not measured CAD",
                "Assumed centimetres; scale not independently calibrated",
                "Interior and brake parts removed",
                "Exterior voxel reconstruction closes small openings and smooths detail",
                "Missing underbody and cabin sealed with vertical envelope; underbody flow is approximate",
                "Tires replaced with closed convex envelopes",
                "Wheel housings reconstructed as cylinders with 20 mm nominal tire clearance",
            ],
        ),
        indent=2,
    )
)
