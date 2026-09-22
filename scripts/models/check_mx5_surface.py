"""Compare broad-panel surface positions/normals with the supplied visual model."""

import json
from pathlib import Path
import numpy as np
import trimesh
import vtk
from vtk.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray

root = Path(".easycfd/imports/mx5-nc-surface")
scene = trimesh.load(".easycfd/imports/mx5-nc/source.glb", force="scene")
sources = []
for node in scene.graph.nodes_geometry:
    transform, name = scene.graph[node]
    part = scene.geometry[name].copy()
    if getattr(part.visual.material, "name", "") in ("interior", "brakedisk", "material", "tire"):
        continue
    part.apply_transform(transform)
    part.apply_scale(0.01)
    sources.append(part)
source = trimesh.util.concatenate(sources)
pts = vtk.vtkPoints()
pts.SetData(numpy_to_vtk(source.vertices, deep=True))
cells = vtk.vtkCellArray()
cells.SetData(
    numpy_to_vtkIdTypeArray(np.arange(len(source.faces) + 1, dtype=np.int64) * 3, deep=True),
    numpy_to_vtkIdTypeArray(source.faces.ravel().astype(np.int64), deep=True),
)
data = vtk.vtkPolyData()
data.SetPoints(pts)
data.SetPolys(cells)
locator = vtk.vtkStaticCellLocator()
locator.SetDataSet(data)
locator.BuildLocator()
report = {}
for label, path in [("v1", ".easycfd/imports/mx5-nc/body.stl"), ("revised", str(root / "body.stl"))]:
    m = trimesh.load_mesh(path)
    centers = m.triangles_center
    report[label] = {}
    for region, mask in [
        (
            "bonnet",
            (abs(centers[:, 0]) < 0.45)
            & (centers[:, 1] > -1.6)
            & (centers[:, 1] < -0.8)
            & (centers[:, 2] > 0.7),
        ),
        (
            "roof",
            (abs(centers[:, 0]) < 0.4)
            & (centers[:, 1] > -0.25)
            & (centers[:, 1] < 0.65)
            & (centers[:, 2] > 1.05),
        ),
    ]:
        ids = np.flatnonzero(mask)
        rng = np.random.default_rng(42)
        ids = rng.choice(ids, size=2000, replace=True, p=m.area_faces[ids] / m.area_faces[ids].sum())
        distances = []
        angles = []
        cell = vtk.reference(0)
        sub = vtk.reference(0)
        dist = vtk.reference(0.0)
        for i in ids:
            p = [0.0, 0.0, 0.0]
            locator.FindClosestPoint(centers[i], p, cell, sub, dist)
            distances.append(float(dist) ** 0.5 * 1000)
            angles.append(
                float(
                    np.degrees(
                        np.arccos(
                            np.clip(abs(np.dot(m.face_normals[i], source.face_normals[int(cell)])), 0, 1)
                        )
                    )
                )
            )
        report[label][region] = {
            "source_distance_mm_median_p95": np.percentile(distances, [50, 95]).tolist(),
            "face_normal_difference_degrees_median_p95": np.percentile(angles, [50, 95]).tolist(),
        }
print(json.dumps(report, indent=2))
(root / "surface-check.json").write_text(json.dumps(report, indent=2))
