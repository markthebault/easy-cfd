import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from easycfd import geometry, storage, transform
from easycfd.api import app


def test_rotation_scale_translation_and_untouched_object(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    box = trimesh.creation.box(extents=[4, 2, 1])
    box.apply_translation([0, 0, 1])
    other = trimesh.creation.box()
    other.apply_translation([6, 0, 1])
    before = geometry.persist_parts(
        source, [("Body", box, "body", None), ("Other", other, "body", None, {"enabled": False})]
    )
    options = transform.TransformOptions(
        revision="unused", part_ids=["part0"], rotation=[0, 0, 90], scale=1.5, translation=[2, 3, 0.2]
    )
    after = transform.prepare(source, target, before, options)
    result = trimesh.load_mesh(target / "part0.stl")
    assert result.extents == pytest.approx([3, 6, 1.5])
    assert result.bounds[0, 2] == pytest.approx(0.7)
    assert result.bounds.mean(axis=0)[:2] == pytest.approx([2, 3])
    assert result.is_watertight and result.is_winding_consistent
    assert set(map(tuple, trimesh.load_mesh(target / "part1.stl").vertices)) == set(
        map(tuple, other.vertices)
    )
    assert not after["parts"][1]["enabled"]


def test_wheel_center_radius_axis_and_ground_height(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    before = geometry.sample(source)
    ids = [p["id"] for p in before["parts"]]
    after = transform.prepare(
        source,
        target,
        before,
        transform.TransformOptions(revision="x", part_ids=ids, rotation=[0, 0, 180], scale=2),
    )
    assert after["bounds"][0][2] == pytest.approx(before["bounds"][0][2], abs=1e-7)
    assert not after["errors"]
    for old, new in zip(before["parts"][1:], after["parts"][1:]):
        assert new["wheel"]["radius"] == pytest.approx(old["wheel"]["radius"] * 2)
        assert new["wheel"]["center"] == pytest.approx(np.mean(new["bounds"], axis=0), abs=1e-7)
    tilted = tmp_path / "tilted"
    tilted.mkdir()
    result = transform.prepare(
        source, tilted, before, transform.TransformOptions(revision="x", part_ids=ids, rotation=[0, 0, 90])
    )
    assert any("axle is not transverse" in e for e in result["errors"])


def test_preview_apply_on_repaired_model_and_stale_token(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    client = TestClient(app)
    p = client.post("/api/projects", json={"sample": True}).json()
    key = p["id"]
    p["geometry"]["repaired"] = True
    storage.save("projects", p)
    before = storage.get("projects", key)
    old = (storage.directory("projects", key) / before["geometry_dir"] / "part0.stl").read_bytes()
    revision = client.get(f"/api/projects/{key}/transform").json()["revision"]
    payload = {"revision": revision, "part_ids": ["part0"], "rotation": [0, 0, 90], "scale": 1.2}
    preview = client.post(f"/api/projects/{key}/transform/preview", json=payload)
    assert preview.status_code == 200, preview.text
    data = preview.json()
    token = data["token"]
    assert storage.get("projects", key) == before
    assert data["geometry"]["repaired"]
    after = client.post(f"/api/projects/{key}/transform/apply", json={"token": token})
    assert after.status_code == 200
    after = after.json()
    assert after["geometry"]["transformed"] and after["geometry"]["repaired"]
    assert not after["settings"]["geometry_confirmed"]
    assert (storage.directory("projects", key) / before["geometry_dir"] / "part0.stl").read_bytes() == old
    assert client.post(f"/api/projects/{key}/transform/preview", json=payload).status_code == 400
    assert client.get(f"/api/projects/{key}/transform-previews/{token}/geometry/part0.vtp").status_code == 404
    assert (
        client.post(f"/api/projects/{key}/transform/preview", json={**payload, "scale": 0}).status_code == 422
    )


def test_unchecked_clearance_and_full_euler_order(tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    m = trimesh.creation.icosphere(subdivisions=1)
    m.apply_scale([2, 1, 0.5])
    m.apply_translation([2, 3, 4])
    data = geometry.persist_parts(a, [("Body", m, "body", None)])
    options = transform.TransformOptions(
        revision="x",
        part_ids=["part0"],
        rotation=[25, -35, 70],
        scale=0.8,
        translation=[1, -2, 3],
        keep_clearance=False,
    )
    after = transform.prepare(a, b, data, options)
    original = trimesh.load_mesh(a / "part0.stl")
    pivot = original.bounds.mean(axis=0)
    rotation = trimesh.transformations.euler_matrix(*np.deg2rad([25, -35, 70]), axes="sxyz")[:3, :3]
    expected = (original.vertices - pivot) @ rotation.T * 0.8 + pivot + [1, -2, 3]
    assert after["parts"][0]["bounds"] == pytest.approx(
        np.array([expected.min(axis=0), expected.max(axis=0)])
    )
