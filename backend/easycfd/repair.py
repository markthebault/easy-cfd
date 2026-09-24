"""Selective, additive caps. Never remesh or move the existing surface."""

import hashlib
import numpy as np
import trimesh
import networkx as nx
import vtk


def cap(points):
    """Triangulate a simple near-planar boundary, retaining its exact vertices."""
    if len(points) > 1000:
        raise ValueError("More than 1,000 rim vertices. Repair this opening in Blender.")
    center = points.mean(axis=0)
    _, _, basis = np.linalg.svd(points - center, full_matrices=False)
    span = float(np.linalg.norm(np.ptp(points, axis=0)))
    deviation = float(np.abs((points - center) @ basis[2]).max())
    if deviation > max(1e-7, span * 0.01):
        raise ValueError("Curved opening. A flat cap could change the shape; repair in Blender.")
    flat = (points - center) @ basis[:2].T
    # Reject crossing outlines before vtkPolygon's ear-cut triangulation.
    n = len(flat)

    def cross(a, b):
        return a[0] * b[1] - a[1] * b[0]

    for i in range(n):
        a, b = flat[i], flat[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            c, d = flat[j], flat[(j + 1) % n]
            if (
                cross(b - a, c - a) * cross(b - a, d - a) < 0
                and cross(d - c, a - c) * cross(d - c, b - c) < 0
            ):
                raise ValueError("Crossing boundary. Repair this opening in Blender.")
    polygon = vtk.vtkPolygon()
    for i, p in enumerate(flat):
        polygon.GetPoints().InsertNextPoint(float(p[0]), float(p[1]), 0)
        polygon.GetPointIds().InsertNextId(i)
    ids = vtk.vtkIdList()
    if not polygon.TriangulateLocalIds(0, ids) or ids.GetNumberOfIds() != 3 * (n - 2):
        raise ValueError("This boundary could not be triangulated safely.")
    faces = np.array([ids.GetId(i) for i in range(ids.GetNumberOfIds())]).reshape(-1, 3)
    candidate = trimesh.Trimesh(points, faces, process=False)
    if np.any(candidate.area_faces < 1e-16):
        raise ValueError("The patch would contain collapsed triangles.")
    return faces


def inspect(mesh, part_id, name):
    counts = np.bincount(mesh.edges_unique_inverse, minlength=len(mesh.edges_unique))
    boundary = mesh.edges_unique[counts == 1]
    graph = nx.Graph()
    graph.add_edges_from(boundary.tolist())
    openings = []
    directed = {}
    # Retain the winding of the existing face at each open edge.
    for e in mesh.edges[counts[mesh.edges_unique_inverse] == 1]:
        directed[tuple(sorted(e))] = tuple(e)
    for component in sorted(nx.connected_components(graph), key=lambda c: min(c)):
        vertices = sorted(component)
        ordered = []
        reason = ""
        if any(graph.degree(v) != 2 for v in vertices):
            reason = "Branching tear. Repair the connections in Blender."
        else:
            start = vertices[0]
            ordered = [start]
            previous, current = start, min(graph[start])
            while current != start:
                ordered.append(current)
                nxt = next(v for v in graph[current] if v != previous)
                previous, current = current, nxt
            # Patch traverses boundary in the opposite direction to the old face.
            if directed[tuple(sorted(ordered[:2]))] == tuple(ordered[:2]):
                ordered.reverse()
        points = mesh.vertices[ordered or vertices]
        triangles = []
        if not reason:
            try:
                triangles = np.asarray(ordered)[cap(points)].tolist()
                # Every cap boundary must oppose its neighbouring existing face.
                edges = trimesh.Trimesh(mesh.vertices, triangles, process=False).edges
                if any(tuple(e) == directed.get(tuple(sorted(e))) for e in edges):
                    raise ValueError("Inconsistent rim normals. Correct face directions in Blender.")
            except ValueError as exc:
                reason = str(exc)
        identity = hashlib.sha256(np.asarray(vertices, dtype=np.int64).tobytes()).hexdigest()[:16]
        openings.append(
            dict(
                id=f"{part_id}-{identity}",
                part_id=part_id,
                part_name=name,
                points=points.tolist(),
                closed=bool(ordered),
                edges=[
                    [mesh.vertices[a].tolist(), mesh.vertices[b].tolist()]
                    for a, b in graph.subgraph(component).edges
                ],
                span=float(np.linalg.norm(np.ptp(points, axis=0))),
                perimeter=float(
                    sum(
                        np.linalg.norm(mesh.vertices[a] - mesh.vertices[b])
                        for a, b in graph.subgraph(component).edges
                    )
                ),
                reason=reason,
                repairable=not reason,
                triangles=triangles,
                patch=mesh.vertices[triangles].tolist() if triangles else [],
            )
        )
    return dict(
        part_id=part_id,
        name=name,
        openings=openings,
        boundary_edges=int((counts == 1).sum()),
        nonmanifold_edges=int((counts > 2).sum()),
        watertight=bool(mesh.is_watertight),
        winding_consistent=bool(mesh.is_winding_consistent),
    )


def analyze(folder, geometry, selected=()):
    selected = set(selected)
    found = set()
    reports, meshes, patches = [], [], []
    for part in geometry["parts"]:
        mesh = trimesh.load_mesh(folder / f"{part['id']}.stl", process=True)
        report = inspect(mesh, part["id"], part["name"])
        report["enabled"] = part.get("enabled", True)
        extra = []
        for opening in report["openings"]:
            if opening["id"] in selected:
                found.add(opening["id"])
                if not opening["repairable"]:
                    raise ValueError(opening["reason"])
                extra.extend(opening["triangles"])
                patches.extend(opening["patch"])
            del opening["triangles"]
        if extra:
            mesh = trimesh.Trimesh(mesh.vertices.copy(), np.vstack([mesh.faces, extra]), process=False)
            counts = np.bincount(mesh.edges_unique_inverse)
            if int((counts > 2).sum()) > report["nonmanifold_edges"]:
                raise ValueError(
                    "These caps would create non-manifold connections. Repair the opening manually."
                )
        meshes.append(mesh)
        reports.append(report)
    if found != selected:
        raise ValueError("The selected openings have changed. Reopen the repair view.")
    return dict(
        parts=reports,
        patches=patches,
        added_triangles=sum(len(p["patch"]) for r in reports for p in r["openings"] if p["id"] in selected),
        remaining_openings=sum(len(r["openings"]) for r in reports) - len(selected),
        closed_parts=sum(bool(m.is_watertight) for m in meshes),
        total_parts=len(meshes),
    ), meshes
