import io
import zipfile
import pytest
import trimesh
from fastapi.testclient import TestClient
from easycfd import storage, geometry, seal
from easycfd.api import app
from easycfd.models import ImportOptions


def fragmented():
    return trimesh.util.concatenate(
        [
            trimesh.creation.box(
                extents=[0.095, 0.095, 0.15],
                transform=trimesh.transformations.translation_matrix([x * 0.1, y * 0.1, 0.2]),
            )
            for x in range(11)
            for y in range(10)
        ]
    )


def test_group_import_over_100_components_is_lossless(tmp_path):
    source = tmp_path / "body.stl"
    original = fragmented()
    original.export(source)
    with pytest.raises(ValueError, match="Group each STL"):
        geometry.import_files([source], tmp_path, ImportOptions())
    grouped = geometry.import_files([source], tmp_path, ImportOptions(components="group"))
    assert len(grouped["parts"]) == 1
    assert grouped["parts"][0]["grouped_components"] == 110
    assert grouped["triangles"] == len(original.faces)
    assert grouped["dimensions"] == pytest.approx(original.extents, abs=1e-6)
    assert any("Merge & seal" in e for e in grouped["errors"])


def test_gap_bridging_and_remote_islands_not_discarded():
    def boxes(distance):
        return trimesh.util.concatenate(
            [
                trimesh.creation.box(
                    extents=[0.1, 0.1, 0.1], transform=trimesh.transformations.translation_matrix([x, 0, 0.2])
                )
                for x in [0, distance]
            ]
        )

    near, report = seal.reconstruct(boxes(0.11), 10, 30)
    assert report["can_apply"] and report["result_components"] == 1
    assert near.is_watertight and near.is_winding_consistent and near.volume > 0
    far, report = seal.reconstruct(boxes(0.5), 10, 30)
    assert report["result_components"] == 2 and not report["can_apply"]
    assert far.extents[0] > 0.5
    assert report["original_to_result"]["samples"] > 0


def test_resolution_budget_checked_before_voxelization(monkeypatch):
    monkeypatch.setattr(
        trimesh.Trimesh, "voxelized", lambda *a, **kw: pytest.fail("voxelization must not start")
    )
    with pytest.raises(ValueError, match="too many voxels"):
        seal.reconstruct(trimesh.creation.box(extents=[15, 15, 15]), 5, 20)
    with pytest.raises(ValueError, match="subdivision"):
        seal.reconstruct(trimesh.creation.box(extents=[4, 0.005, 0.005]), 5, 0)


def test_merge_preview_apply_export_preserve_other_parts(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    client = TestClient(app)
    p = client.post("/api/projects", json={"sample": False}).json()
    key = p["id"]
    body = fragmented().export(file_type="stl")
    wheel = trimesh.creation.box(
        extents=[0.2, 0.1, 0.2], transform=trimesh.transformations.translation_matrix([0, -0.3, 0.2])
    ).export(file_type="stl")
    response = client.post(
        f"/api/projects/{key}/import",
        files=[("files", ("body.stl", body)), ("files", ("wheel.stl", wheel))],
        data={"options": '{"components":"group","clearance":0.1}'},
    )
    assert response.status_code == 200
    response = client.put(f"/api/projects/{key}/parts/part1", json={"role": "wheel", "radius": 0.1})
    assert response.status_code == 200
    before = response.json()
    root = storage.directory("projects", key)
    old_file = root / before["geometry_dir"] / "part0.stl"
    original_bytes = old_file.read_bytes()
    revision = client.get(f"/api/projects/{key}/seal").json()["revision"]
    request = {"revision": revision, "part_ids": ["part0"], "pitch_mm": 10, "gap_mm": 20}
    assert (
        client.post(f"/api/projects/{key}/seal/preview", json={**request, "part_ids": ["part1"]}).status_code
        == 400
    )
    preview = client.post(f"/api/projects/{key}/seal/preview", json=request)
    assert preview.status_code == 200, preview.text
    preview = preview.json()
    assert preview["report"]["source_components"] == 110
    assert preview["report"]["result_components"] == 1
    assert preview["report"]["can_apply"]
    assert len(preview["geometry"]["parts"]) == 2
    assert preview["geometry"]["parts"][1]["role"] == "wheel"
    assert storage.get("projects", key) == before
    token = preview["token"]
    assert client.get(f"/api/projects/{key}/seal-previews/{token}/geometry/part0.vtp").status_code == 200
    response = client.post(f"/api/projects/{key}/seal/apply", json={"token": token})
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["geometry"]["errors"] == []
    assert not after["settings"]["geometry_confirmed"]
    assert after["geometry"]["parts"][1]["wheel"] == before["geometry"]["parts"][1]["wheel"]
    assert old_file.read_bytes() == original_bytes
    assert (root / after["geometry_dir"] / "originals/0-body.stl").read_bytes() == body
    assert client.get(f"/api/projects/{key}/seal-previews/{token}/geometry/part0.vtp").status_code == 404
    original_wheel = trimesh.load_mesh(root / before["geometry_dir"] / "part1.stl")
    final_wheel = trimesh.load_mesh(root / after["geometry_dir"] / "part1.stl")
    assert set(map(tuple, original_wheel.vertices)) == set(map(tuple, final_wheel.vertices))
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/projects/{key}/repair/export").content)) as z:
        exported = trimesh.load_mesh(io.BytesIO(z.read("part0.stl")), file_type="stl")
        assert exported.is_watertight and seal.component_count(exported) == 1


def test_stale_preview_and_discard(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    client = TestClient(app)
    p = client.post("/api/projects", json={"sample": False}).json()
    key = p["id"]
    mesh = trimesh.creation.box(extents=[0.2, 0.1, 0.1]).export(file_type="stl")
    client.post(f"/api/projects/{key}/import", files={"files": ("body.stl", mesh)})
    revision = client.get(f"/api/projects/{key}/seal").json()["revision"]
    preview = client.post(
        f"/api/projects/{key}/seal/preview",
        json={"revision": revision, "part_ids": ["part0"], "pitch_mm": 10, "gap_mm": 10},
    ).json()
    token = preview["token"]
    client.put(f"/api/projects/{key}/parts/part0", json={"role": "wheel", "radius": 0.1})
    assert client.post(f"/api/projects/{key}/seal/apply", json={"token": token}).status_code == 400
    assert client.delete(f"/api/projects/{key}/seal-previews/{token}").status_code == 200
    assert client.get(f"/api/projects/{key}/seal-previews/{token}/geometry/part0.vtp").status_code == 404
    assert client.post(f"/api/projects/{key}/seal/apply", json={"token": "../record"}).status_code == 422


def test_large_opening_does_not_mislabel_thickened_skin_as_body():
    mesh = trimesh.creation.box(extents=[0.4, 0.4, 0.4])
    mesh.update_faces(mesh.face_normals[:, 2] < 0.5)
    result, report = seal.reconstruct(mesh, 10, 0)
    assert result.is_watertight
    assert report["interior_voxels"] == 0
    assert not report["can_apply"]
    assert "thickened skin" in report["message"]
