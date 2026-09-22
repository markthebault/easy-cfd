"""Geometry preparation. Originals are kept; edits never silently repair imported shapes."""

from pathlib import Path
import hashlib
import numpy as np
import trimesh
import vtk
from vtk.util.numpy_support import numpy_to_vtk
from .models import ImportOptions


def write_vtp(mesh, path):
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(np.asarray(mesh.vertices), deep=True))
    cells = vtk.vtkCellArray()
    for face in mesh.faces:
        cells.InsertNextCell(3)
        for vertex in face:
            cells.InsertCellPoint(int(vertex))
    poly = vtk.vtkPolyData()
    poly.SetPoints(points)
    poly.SetPolys(cells)
    # Point normals describe the existing surface for lighting; the STL geometry
    # used by OpenFOAM is unchanged by this display-only operation.
    normals = vtk.vtkPolyDataNormals()
    normals.SetInputData(poly)
    normals.ComputePointNormalsOn()
    normals.ComputeCellNormalsOff()
    normals.SetFeatureAngle(45)
    normals.SplittingOn()
    normals.ConsistencyOn()
    normals.Update()
    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputConnection(normals.GetOutputPort())
    writer.SetHeaderTypeToUInt64()
    writer.SetDataModeToBinary()
    writer.SetCompressorTypeToNone()
    writer.Write()


def prism(profile, width):
    # Convex X/Z profile extruded in Y, intentionally simple and reproducible.
    points = np.array([[x, y, z] for y in (-width / 2, width / 2) for x, z in profile])
    return trimesh.convex.convex_hull(points)


def sample(folder, wing=False):
    folder.mkdir(parents=True, exist_ok=True)
    body = prism(
        [
            (-2.1, 0.32),
            (-2.1, 0.60),
            (-1.65, 0.83),
            (-0.7, 0.91),
            (-0.28, 1.32),
            (0.85, 1.32),
            (1.65, 0.86),
            (2.1, 0.72),
            (2.1, 0.32),
        ],
        1.62,
    )
    # Wheels sit outside the body so surface regions do not intersect.
    pieces = [("Body", body, "body", None)]
    for x in (-1.35, 1.3):
        for y in (-1.05, 1.05):
            radius = 0.32
            transform = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
            transform[:3, 3] = [x, y, radius + 0.01]
            wheel = trimesh.creation.cylinder(radius=radius, height=0.24, sections=32, transform=transform)
            pieces.append(
                (
                    f"{'Front' if x < 0 else 'Rear'} {'left' if y > 0 else 'right'} wheel",
                    wheel,
                    "wheel",
                    dict(center=[x, y, radius + 0.01], radius=radius),
                )
            )
    if wing:
        # A closed, tilted wing-shaped prism; a demonstration, not an optimized aerofoil.
        shape = prism([(1.48, 1.48), (1.49, 1.52), (1.88, 1.59), (1.90, 1.57)], 1.95)
        pieces.append(("Rear wing", shape, "body", None))
    return persist_parts(folder, pieces)


def step_meshes(path, target):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.StlAPI import StlAPI_Writer

    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError("The STEP file could not be read.")
    reader.TransferRoots()
    shape = reader.OneShape()
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    shapes = []
    while explorer.More():
        shapes.append(explorer.Current())
        explorer.Next()
    if not shapes:
        shapes = [shape]
    if len(shapes) > 100:
        raise ValueError("This assembly has more than 100 solids. Export just the exterior parts.")
    meshes = []
    for i, solid in enumerate(shapes):
        mesher = BRepMesh_IncrementalMesh(solid, 0.2, False, 0.3, True)
        mesher.Perform()
        out = target / f"step-{i}.stl"
        writer = StlAPI_Writer()
        if not writer.Write(solid, str(out)):
            raise ValueError("Could not tessellate STEP geometry.")
        # Open CASCADE's STEP reader normalizes length units to millimetres.
        mesh = trimesh.load_mesh(out, process=True)
        mesh.apply_scale(0.001)
        meshes.append(mesh)
        out.unlink()
    return meshes


def import_files(files: list[Path], folder: Path, options: ImportOptions):
    pieces = []
    for path in files:
        if path.suffix.lower() in (".step", ".stp"):
            meshes = step_meshes(path, folder)
        else:
            mesh = trimesh.load_mesh(path, process=True)
            if not isinstance(mesh, trimesh.Trimesh):
                raise ValueError("Expected an STL surface mesh.")
            mesh.apply_scale(dict(m=1, mm=0.001, cm=0.01, **{"in": 0.0254})[options.units])
            meshes = list(mesh.split(only_watertight=False))
        for i, mesh in enumerate(meshes):
            pieces.append((f"{path.stem[:60]} {i + 1}", mesh, "body", None))
    if not pieces or len(pieces) > 100:
        raise ValueError("Import between 1 and 100 connected exterior parts.")

    def axis(value):
        out = np.zeros(3)
        out["XYZ".index(value[-1])] = 1 if value[0] == "+" else -1
        return out

    x, z = -axis(options.forward), axis(options.up)
    y = np.cross(z, x)
    transform = np.eye(4)
    transform[:3, :3] = np.stack([x, y, z])
    for _, mesh, _, _ in pieces:
        mesh.apply_transform(transform)
    bounds = np.array([mesh.bounds for _, mesh, _, _ in pieces])
    low, high = bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)
    offset = np.array([-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, options.clearance - low[2]])
    for _, mesh, _, _ in pieces:
        mesh.apply_translation(offset)
    return persist_parts(folder, pieces)


def persist_parts(folder, pieces):
    parts, errors = [], []
    total = 0
    for i, (name, mesh, role, wheel) in enumerate(pieces):
        key = f"part{i}"
        mesh.remove_unreferenced_vertices()
        count = len(mesh.faces)
        total += count
        issues = []
        if count < 4 or not np.isfinite(mesh.vertices).all():
            raise ValueError(f"{name}: empty or non-finite geometry.")
        if not mesh.is_watertight:
            issues.append("Open edges or non-manifold edges. Export a closed solid.")
        if not mesh.is_winding_consistent or mesh.volume <= 0:
            issues.append("Inconsistent or inward-facing surface normals. Correct normals in CAD/Blender.")
        if np.any(mesh.area_faces < 1e-16):
            issues.append("Degenerate triangles. Clean the surface in CAD/Blender.")
        mesh.export(folder / f"{key}.stl")
        write_vtp(mesh, folder / f"{key}.vtp")
        parts.append(
            dict(
                id=key,
                name=name,
                role=role,
                wheel=wheel,
                triangles=count,
                minimum_extent=float(mesh.bounding_box_oriented.primitive.extents.min()),
                bounds=mesh.bounds.tolist(),
                issues=issues,
            )
        )
        errors.extend([f"{name}: {issue}" for issue in issues])
    if total > 1500000:
        errors.append("More than 1.5 million surface triangles. Export a coarser exterior model.")
    bounds = np.array([part["bounds"] for part in parts])
    low, high = bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)
    dimensions = high - low
    if dimensions.max() > 15 or dimensions.max() < 0.1:
        errors.append("Unexpected model size. Check export units; supported length is 0.1–15 metres.")
    digest = hashlib.sha256()
    for part in parts:
        digest.update((folder / f"{part['id']}.stl").read_bytes())
    return dict(
        parts=parts,
        bounds=[low.tolist(), high.tolist()],
        dimensions=dimensions.tolist(),
        triangles=total,
        errors=errors,
        fingerprint=digest.hexdigest(),
        warnings=[
            "Automatic checks do not establish that surfaces are free of intersections. Review the model and mesh.",
            "Small wheel-to-ground gaps avoid degenerate contact cells; ground clearance affects forces.",
        ],
    )
