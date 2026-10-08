"""Native section fidelity, physical recording setup, and bounded API selection."""

import gzip
import json
import math
import queue
import numpy as np
import pytest
import vtk
from fastapi.testclient import TestClient
from vtk.util.numpy_support import numpy_to_vtk
from easycfd import animation, fineflow, foam, runner, storage
from easycfd.animation_worker import sample_section
from easycfd.api import app
from easycfd.models import Settings, resolved_preset


def test_detailed_recording_keeps_the_steady_result_and_develops_the_wake(tmp_path):
    source = tmp_path / "steady"
    for name in ("constant", "system", "500/uniform"):
        (source / name).mkdir(parents=True)
    (source / "500/U").write_bytes(b"computed steady velocity")
    (source / "system/fvSchemes").write_text("ddtSchemes {default steadyState;}")
    geometry = dict(bounds=[[-2, -1, 0.01], [2, 1, 1.3]])
    meta = dict(domain=[-14, 26, -9, 9, 0, 9.3])
    run = dict(geometry=geometry, settings=dict(flow_detail="fine"))
    case = tmp_path / "ddes"
    plan = animation.prepare(source, case, 4, 40, run, meta)
    assert plan["warmup"] == 0.8
    assert plan["duration"] == pytest.approx(1.2)
    control = (case / "system/controlDict").read_text()
    assert "timeStart 0.8" in control
    assert "turbulenceModelSchemes" in control
    assert "purgeWrite 2" in control
    assert plan["integration"]["max_delta_t"] * 40 / plan["integration"]["wake_spacing"] <= 0.350001
    assert plan["integration"]["max_delta_t"] < plan["interval"] / 2
    assert "type surfaces" in control
    assert "kOmegaSSTDDES" in (case / "constant/turbulenceProperties").read_text()
    assert "DEShybrid" in (case / "system/fvSchemes").read_text()
    assert (source / "500/U").read_bytes() == (case / "0/U").read_bytes()
    assert (
        resolved_preset(Settings(flow_animation=True, flow_detail="fine"))["wake"]
        > resolved_preset(Settings())["wake"]
    )
    with pytest.raises(ValueError, match="single-mesh"):
        Settings(flow_animation=True, flow_detail="fine", profile="advanced2")
    with pytest.raises(ValueError, match="quality medium"):
        Settings(flow_animation=True, flow_detail="fine", quality="precise")
    assert len(plan["source_sha256"]) == 64
    assert len(plan["dictionaries_sha256"]) == 4


@pytest.mark.parametrize("scale", [0.2, 1, 3])
def test_section_budgets_and_resolution_scale_with_the_car(scale):
    geometry = dict(bounds=[[-2 * scale, -scale, 0.01 * scale], [2 * scale, scale, 1.3 * scale]])
    planes = fineflow.sections(geometry, np.array([-14, 26, -9, 9, 0, 9.3]) * scale)
    assert len(planes) == 4
    for plane in planes:
        assert math.prod(plane["dims"]) <= fineflow.MAX_SECTION_POINTS
        assert plane["dims"].count(1) == 1
        assert plane["origin"][plane["axis"]] == plane["position"]
        assert max(s for a, s in enumerate(plane["spacing"]) if a != plane["axis"]) < 0.03 * scale


@pytest.mark.parametrize("axis", [0, 1, 2])
@pytest.mark.parametrize("position", [0.0, 0.6123456789])
def test_native_float32_sections_preserve_linear_velocity_and_mask_holes(axis, position):
    other = [a for a in range(3) if a != axis]
    origin = np.array([0.0, 0.0, 0.0])
    origin[axis] = position
    dims = [9, 9, 9]
    dims[axis] = 1
    spacing = [0.125, 0.125, 0.125]
    spacing[axis] = 1
    coordinates = []
    for x, y in [(0, 0), (1, 0), (0, 1), (1, 1)]:
        p = origin.copy()
        p[other] = [x, y]
        coordinates.append(p)
    coordinates = np.array(coordinates, dtype=np.float32)
    # Native intersections around zero can retain tiny, face-dependent normal errors.
    coordinates[:, axis] += np.array([1, -1, -1, 1], dtype=np.float32) * 1e-8
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(coordinates, deep=True))
    triangles = vtk.vtkCellArray()
    for ids in [(0, 1, 2), (1, 3, 2)]:
        triangles.InsertNextCell(3, ids)
    source = vtk.vtkPolyData()
    source.SetPoints(points)
    source.SetPolys(triangles)
    values = {
        "U": np.column_stack([1 + 2 * coordinates[:, 0], 3 * coordinates[:, 1], 4 * coordinates[:, 2]]),
        "p": coordinates[:, 0] - coordinates[:, 1],
        "k": 0.1 + coordinates[:, 2],
    }
    for name, values in values.items():
        array = numpy_to_vtk(values.copy(), deep=True)
        array.SetName(name)
        source.GetPointData().AddArray(array)
    section = dict(axis=axis, origin=origin.tolist(), spacing=spacing, dims=dims)
    payload = sample_section(source, section)
    n = math.prod(dims)
    fields = np.frombuffer(payload, dtype="<f4", count=5 * n).reshape(5, n)
    valid = np.frombuffer(payload, dtype="u1", offset=20 * n)
    assert valid.all()
    xyz = np.array(
        [
            origin + np.array([x, y, z]) * spacing
            for z in range(dims[2])
            for y in range(dims[1])
            for x in range(dims[0])
        ]
    )
    np.testing.assert_allclose(fields[0], 1 + 2 * xyz[:, 0], atol=2e-6)
    np.testing.assert_allclose(fields[1], 3 * xyz[:, 1], atol=2e-6)
    np.testing.assert_allclose(fields[2], 4 * xyz[:, 2], atol=2e-6)
    one = vtk.vtkCellArray()
    one.InsertNextCell(3, (0, 1, 2))
    source.SetPolys(one)
    payload = sample_section(source, section)
    fields = np.frombuffer(payload, dtype="<f4", count=5 * n).reshape(5, n)
    valid = np.frombuffer(payload, dtype="u1", offset=20 * n)
    assert (valid == 0).any()
    assert np.all(fields[:, valid == 0] == 0)


def test_section_api_selects_only_recorded_planes_and_retains_legacy_bounds(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    key = "f" * 32
    storage.save("runs", dict(id=key, status="completed"))
    output = storage.directory("runs", key) / "animation"
    output.mkdir()
    planes = [
        dict(id="top", origin=[0, 0, 0.5], spacing=[0.01, 0.01, 1], dims=[2, 2, 1]),
        dict(id="side", origin=[0, 0, 0], spacing=[0.01, 1, 0.01], dims=[2, 1, 2]),
    ]
    (output / "manifest.json").write_text(
        json.dumps(dict(version=2, section="top", sections=planes, frames=[dict(time=0), dict(time=0.002)]))
    )
    for section in planes:
        folder = output / "sections" / section["id"]
        folder.mkdir(parents=True)
        (folder / "frame-0.bin.gz").write_bytes(gzip.compress(section["id"].encode()))
    client = TestClient(app)
    assert client.get(f"/api/runs/{key}/animation?section=side").json()["dims"] == [2, 1, 2]
    assert client.get(f"/api/runs/{key}/animation/0?section=side").content == b"side"
    assert client.get(f"/api/runs/{key}/animation?section=unknown").status_code == 400
    assert client.get(f"/api/runs/{key}/animation/0?section=../side").status_code == 400
    assert client.get(f"/api/runs/{key}/animation/2?section=top").status_code == 400


def test_recording_resume_preserves_physical_time_sections_and_parent(tmp_path):
    source = tmp_path / "parent"
    for name in (
        "system",
        "0",
        "processor0/0.4",
        "processor1/0.4",
        "processor0/0.5",
        "postProcessing/fineSections/0.3",
        "postProcessing/fineSections/0.81",
    ):
        (source / name).mkdir(parents=True)
    original = "startFrom startTime; startTime 0; stopAt writeNow; endTime 1.2;"
    (source / "system/controlDict").write_text(original)
    for processor in ("processor0", "processor1"):
        for name in ("U", "p", "k", "omega"):
            (source / processor / "0.4" / name).write_bytes(b"computed checkpoint")
    (source / "processor0/0.5/U").write_bytes(b"partial write")
    (source / "postProcessing/fineSections/0.81/top.vtp").write_bytes(b"native section")
    (source / "postProcessing/fineSections/0.3/top.vtp").write_bytes(b"retained section")
    (source / "recording.json").write_text(json.dumps(dict(duration=1.2)))
    target = tmp_path / "continued"
    plan = animation.prepare_resume(source, target, "a" * 32)
    assert plan["continuation"]["physical_time"] == 0.4
    assert "startFrom latestTime" in (target / "system/controlDict").read_text()
    assert "stopAt endTime" in (target / "system/controlDict").read_text()
    assert (source / "system/controlDict").read_text() == original
    assert not (target / "postProcessing/fineSections/0.81").exists()
    assert not (target / "processor0/0.5").exists()
    assert (source / "postProcessing/fineSections/0.81/top.vtp").read_bytes() == b"native section"
    assert (target / "postProcessing/fineSections/0.3/top.vtp").read_bytes() == b"retained section"
    (target / "processor0/0.4/U").write_bytes(b"continued field")
    assert (source / "processor0/0.4/U").read_bytes() == b"computed checkpoint"


def test_continuation_is_a_separate_bounded_run_and_does_not_rerun_the_mesh(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=8, cpus=4))
    disk = runner.shutil.disk_usage(tmp_path)
    monkeypatch.setattr(runner.shutil, "disk_usage", lambda _: disk._replace(free=32 * 1024**3))
    monkeypatch.setattr(runner, "JOBS", queue.Queue())
    parent = "a" * 32
    record = dict(
        id=parent,
        project_id="b" * 32,
        name="Fine wake",
        created="2026-10-07",
        status="failed",
        settings=Settings(flow_animation=True, flow_detail="fine").model_dump(),
        geometry={},
        domain=[-14, 26, -9, 9, 0, 9],
        image=foam.IMAGE,
        pipeline_hash="same mesh",
        processes=4,
        cpus=4,
    )
    storage.save("runs", record)
    root = storage.directory("runs", parent)
    for folder in ("animation-case", "results", "geometry"):
        (root / folder).mkdir()
    checkpoint = root / "animation-case/0.1"
    checkpoint.mkdir()
    for name in ("U", "p", "k", "omega"):
        (checkpoint / name).write_bytes(b"saved checkpoint")
    (root / "animation-case/recording.json").write_text("{}")
    result = dict(iteration=500, cd=0.3)
    (root / "results/summary.json").write_text(json.dumps(result))
    client = TestClient(app)
    assert (
        client.post(f"/api/runs/{parent}/continue-recording", json=dict(max_seconds=43201)).status_code == 422
    )
    response = client.post(f"/api/runs/{parent}/continue-recording", json=dict(max_seconds=43200))
    assert response.status_code == 202
    child = response.json()
    assert child["id"] != parent
    assert child["recording_source"] == parent
    assert child["pipeline_hash"] == "same mesh"
    assert child["settings"]["max_seconds"] == 43200
    monkeypatch.setattr(
        animation, "continue_recording", lambda key, run: dict(result, flow_animation=dict(detail="fine"))
    )

    def forbidden(*args):
        raise AssertionError("A continuation must not build another mesh or steady solution")

    monkeypatch.setattr(runner, "solve", forbidden)
    runner.execute(child["id"])
    assert storage.get("runs", child["id"])["status"] == "completed"
    assert storage.get("runs", parent) == record
    assert (
        client.post(f"/api/runs/{parent}/continue-recording", json=dict(restart_from_steady=True)).status_code
        == 400
    )
    (root / "case-medium").mkdir()
    (root / "case-medium/metadata.json").write_text("{}")
    restarted = client.post(
        f"/api/runs/{parent}/continue-recording", json=dict(restart_from_steady=True)
    ).json()
    assert restarted["recording_restart"] is True
    assert restarted["recording_source"] == parent
    runner.execute(restarted["id"])
    assert storage.get("runs", restarted["id"])["status"] == "completed"
    assert storage.get("runs", parent) == record
    storage.update("runs", parent, status="running")
    assert client.post(f"/api/runs/{parent}/continue-recording", json={}).status_code == 400
