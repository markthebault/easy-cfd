"""Bounded voxel reconstruction for explicitly selected body parts.

Grouping is lossless. Sealing is a separate, approximate preview and keeps every
voxel component: we never discard small islands to make the result look valid.
"""

import numpy as np
import trimesh
import vtk
from scipy import ndimage
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

MAX_CELLS = 8_000_000
MAX_SUBDIVIDED_FACES = 8_000_000


def component_count(mesh):
    return len(
        trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(mesh.faces)), min_len=1)
    )


def polydata(mesh):
    poly = vtk.vtkPolyData()
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(np.asarray(mesh.vertices), deep=True))
    poly.SetPoints(points)
    cells = vtk.vtkCellArray()
    packed = np.column_stack([np.full(len(mesh.faces), 3), mesh.faces]).ravel().astype(np.int64)
    cells.ImportLegacyFormat(numpy_to_vtk(packed, deep=True, array_type=vtk.VTK_ID_TYPE))
    poly.SetPolys(cells)
    return poly


def distance_samples(source, target):
    """Deterministic vertex/face-centre samples, not a Hausdorff error bound."""
    points = np.vstack([source.vertices, source.triangles_center])
    points = points[np.linspace(0, len(points) - 1, min(4000, len(points)), dtype=int)]
    locator = vtk.vtkStaticCellLocator()
    locator.SetDataSet(polydata(target))
    locator.BuildLocator()
    closest, cell, sub, distance = [0.0, 0.0, 0.0], vtk.reference(0), vtk.reference(0), vtk.reference(0.0)
    values = []
    for point in points:
        locator.FindClosestPoint(point, closest, cell, sub, distance)
        values.append(float(distance) ** 0.5)
    return dict(
        samples=len(values), p95_mm=float(np.percentile(values, 95)) * 1000, max_mm=max(values) * 1000
    )


def reconstruct(mesh, pitch_mm, gap_mm):
    pitch = pitch_mm / 1000
    radius = int(np.ceil(gap_mm / (2 * pitch_mm))) if gap_mm else 0
    if radius > 6:
        raise ValueError("Choose a gap size no larger than 12 times the resolution.")
    pad = radius + 3
    dims = np.ceil(mesh.extents / pitch).astype(np.int64) + 2 * pad + 4
    if np.prod(dims, dtype=np.float64) > MAX_CELLS:
        raise ValueError(
            "This resolution needs too many voxels. Increase the resolution value in mm or select fewer parts."
        )
    # Bound subdivision before trimesh allocates refined triangles. Its default
    # edge_factor=2 requires edges <= pitch/2. Per-face powers of four are a
    # conservative count, including long, thin triangles.
    lengths = np.linalg.norm(mesh.triangles - np.roll(mesh.triangles, 1, axis=1), axis=2).max(axis=1)
    levels = np.maximum(0, np.ceil(np.log2(np.maximum(lengths / (pitch / 2), 1))))
    if levels.max(initial=0) > 10 or np.sum(4.0**levels) > MAX_SUBDIVIDED_FACES:
        raise ValueError("This surface needs too much subdivision. Increase the resolution value in mm.")
    voxels = mesh.voxelized(pitch, method="subdivide", max_iter=10)
    shell = np.pad(voxels.matrix, pad)
    if shell.size > MAX_CELLS:
        raise ValueError("Voxel budget exceeded. Increase the resolution value in mm.")
    if radius:
        closed = ndimage.binary_closing(
            shell, structure=ndimage.generate_binary_structure(3, 1), iterations=radius
        )
    else:
        closed = shell
    filled = ndimage.binary_fill_holes(closed)
    interior_voxels = int(np.count_nonzero(filled & ~closed))
    if not np.any(filled):
        raise ValueError("No surface survived this resolution. Use a finer resolution.")
    image = vtk.vtkImageData()
    image.SetDimensions(*filled.shape)
    image.SetSpacing(pitch, pitch, pitch)
    image.SetOrigin(*(voxels.transform[:3, 3] - pad * pitch))
    image.GetPointData().SetScalars(numpy_to_vtk(filled.astype(np.uint8).ravel(order="F"), deep=True))
    contour = vtk.vtkFlyingEdges3D()
    contour.SetInputData(image)
    contour.SetValue(0, 0.5)
    contour.Update()
    smoother = vtk.vtkWindowedSincPolyDataFilter()
    smoother.SetInputConnection(contour.GetOutputPort())
    smoother.SetNumberOfIterations(30)
    smoother.SetPassBand(0.01)
    smoother.BoundarySmoothingOff()
    smoother.FeatureEdgeSmoothingOff()
    smoother.NormalizeCoordinatesOn()
    smoother.Update()
    poly = smoother.GetOutput()
    vertices = vtk_to_numpy(poly.GetPoints().GetData()).copy()
    faces = vtk_to_numpy(poly.GetPolys().GetConnectivityArray()).reshape(-1, 3).copy()
    if len(faces) > 1500000:
        raise ValueError(
            "The sealed surface exceeds 1.5 million triangles. Increase the resolution value in mm."
        )
    result = trimesh.Trimesh(vertices, faces, process=True)
    result.fix_normals(multibody=True)
    solids = component_count(result)
    valid = bool(
        result.is_watertight
        and result.is_winding_consistent
        and result.volume > 0
        and solids == 1
        and interior_voxels > 0
        and np.all(result.area_faces > 1e-16)
    )
    report = dict(
        source_components=component_count(mesh),
        result_components=solids,
        watertight=bool(result.is_watertight),
        can_apply=valid,
        pitch_mm=pitch_mm,
        gap_mm=gap_mm,
        effective_gap_mm=2 * radius * pitch_mm,
        source_triangles=len(mesh.faces),
        result_triangles=len(result.faces),
        voxel_cells=int(shell.size),
        filled_voxels=int(filled.sum()),
        interior_voxels=interior_voxels,
        dimensions_before=mesh.extents.tolist(),
        dimensions_after=result.extents.tolist(),
        original_to_result=distance_samples(mesh, result),
        result_to_original=distance_samples(result, mesh),
        message=(
            "One closed body. Inspect the shape and intentional gaps before applying."
            if valid
            else "No enclosed interior was found. The result is only a thickened skin. Close larger openings first or increase the gap target."
            if interior_voxels == 0
            else f"{solids} disconnected surfaces remain, or the surface is invalid. No pieces were discarded. Adjust the gap size or repair manually."
        ),
    )
    return result, report
