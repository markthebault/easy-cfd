"""Geometry preservation, safe rejection, and the preview/apply transaction."""

import io
import zipfile
import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from easycfd import geometry, repair, storage
from easycfd.api import app
from easycfd.models import ImportOptions


def open_box():
    m = trimesh.creation.box(extents=[4, 2, 1])
    m.update_faces(np.abs(m.face_normals[:, 2]) < 0.5)
    return m


def test_selected_cap_preserves_vertices_and_other_opening():
    mesh = open_box()
    report = repair.inspect(mesh, "part0", "body")
    assert len(report["openings"]) == 2
    chosen = report["openings"][0]
    assert chosen["repairable"]
    result = trimesh.Trimesh(
        mesh.vertices.copy(), np.vstack([mesh.faces, chosen["triangles"]]), process=False
    )
    assert np.array_equal(mesh.vertices, result.vertices)
    assert np.array_equal(mesh.faces, result.faces[: len(mesh.faces)])
    assert len(repair.inspect(result, "part0", "body")["openings"]) == 1
    other = repair.inspect(result, "part0", "body")["openings"][0]
    closed = trimesh.Trimesh(result.vertices, np.vstack([result.faces, other["triangles"]]), process=False)
    assert closed.is_watertight and closed.is_winding_consistent
    assert closed.volume == pytest.approx(8)


def test_curved_and_crossing_rims_are_rejected():
    with pytest.raises(ValueError, match="Curved"):
        repair.cap(np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0.5], [0, 1, 0]]))
    with pytest.raises(ValueError, match="Crossing"):
        repair.cap(np.array([[0, 0, 0], [1, 1, 0], [0, 1, 0], [1, 0, 0]]))


def test_concave_cap_stays_inside_rim():
    points = np.array([[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]])
    patch = trimesh.Trimesh(points, repair.cap(points), process=False)
    assert len(patch.faces) == 4
    assert patch.area == pytest.approx(3)
    assert not np.any(np.all(patch.triangles_center[:, :2] > 1, axis=1))


def test_nonmanifold_is_reported_without_becoming_a_hole():
    m = trimesh.creation.box()
    m = trimesh.Trimesh(m.vertices, np.vstack([m.faces, m.faces[0]]), process=False)
    report = repair.inspect(m, "part0", "body")
    assert report["nonmanifold_edges"] == 3
    assert not report["watertight"]
    assert not report["openings"]


def test_import_does_not_silently_fill_triangle(tmp_path):
    mesh = trimesh.creation.box()
    mesh.update_faces(np.arange(len(mesh.faces)) != 0)
    source = tmp_path / "open.stl"
    mesh.export(source)
    data = geometry.import_files([source], tmp_path, ImportOptions())
    assert data["parts"][0]["triangles"] == 11
    assert data["errors"]


def test_preview_apply_export_and_stale_requests(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    client = TestClient(app)
    p = client.post("/api/projects", json={"sample": False}).json()
    key = p["id"]
    content = open_box().export(file_type="stl")
    response = client.post(f"/api/projects/{key}/import", files={"files": ("body.stl", content)})
    assert response.status_code == 200
    before = response.json()
    root = storage.directory("projects", key)
    original = (root / before["geometry_dir"] / "originals/0-body.stl").read_bytes()
    asset = (root / before["geometry_dir"] / "part0.stl").read_bytes()
    report = client.get(f"/api/projects/{key}/repair").json()
    ids = [o["id"] for p in report["parts"] for o in p["openings"]]
    payload = {"revision": report["revision"], "selected": ids}
    preview = client.post(f"/api/projects/{key}/repair/preview", json=payload)
    assert preview.status_code == 200
    assert preview.json()["closed_parts"] == 1
    assert preview.json()["remaining_openings"] == 0
    assert preview.json()["added_triangles"] == 4
    assert storage.get("projects", key) == before
    assert (root / before["geometry_dir"] / "part0.stl").read_bytes() == asset
    invalid = {**payload, "selected": ["not-an-opening"]}
    assert client.post(f"/api/projects/{key}/repair/apply", json=invalid).status_code == 400
    result = client.post(f"/api/projects/{key}/repair/apply", json=payload)
    assert result.status_code == 200
    after = result.json()
    assert after["geometry"]["errors"] == []
    assert not after["settings"]["geometry_confirmed"]
    assert after["geometry"]["fingerprint"] != before["geometry"]["fingerprint"]
    assert (root / after["geometry_dir"] / "originals/0-body.stl").read_bytes() == original
    assert (root / before["geometry_dir"] / "part0.stl").read_bytes() == asset
    assert client.post(f"/api/projects/{key}/repair/apply", json=payload).status_code == 400
    assert (
        client.put(f"/api/projects/{key}/import-options", json=ImportOptions().model_dump()).status_code
        == 400
    )
    exported = client.get(f"/api/projects/{key}/repair/export")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        mesh = trimesh.load_mesh(io.BytesIO(archive.read("part0.stl")), file_type="stl")
        assert mesh.is_watertight and mesh.is_winding_consistent
