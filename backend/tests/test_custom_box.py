import json

import pytest
from fastapi.testclient import TestClient

from easycfd import foam, geometry, runner, storage
from easycfd.api import app
from easycfd.models import Settings, SimulationBox, resolved_preset


def box():
    return dict(x_min=-10, x_max=20, y_min=-5, y_max=5, z_max=6)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=8, cpus=4))
    monkeypatch.setattr(runner.JOBS, "put", lambda _: None)
    return TestClient(app)


def test_custom_box_validation_and_budget(tmp_path):
    data = geometry.sample(tmp_path)
    for bad in [dict(box(), x_min=20), dict(box(), z_max=0), dict(box(), y_max=float("inf"))]:
        with pytest.raises(ValueError):
            SimulationBox(**bad)
    for bad in [dict(box(), x_min=0), dict(box(), y_max=1), dict(box(), z_max=1)]:
        with pytest.raises(ValueError, match="surround"):
            foam.domain_bounds(data, Settings(simulation_box=bad))
    with pytest.raises(ValueError, match="budget"):
        foam.mesh_layout(
            data, Settings(simulation_box=dict(x_min=-100, x_max=100, y_min=-100, y_max=100, z_max=100))
        )
    for invalid in [49, 20001, 125.5, True]:
        with pytest.raises(ValueError):
            Settings(quality="custom", custom_iterations=invalid)


def test_preview_solver_snapshot_and_comparison(client, tmp_path):
    p = client.post("/api/projects", json={"sample": True}).json()
    settings = {
        **p["settings"],
        "quality": "custom",
        "custom_mesh": "fast",
        "custom_iterations": 125,
        "simulation_box": box(),
        "geometry_confirmed": True,
    }
    preview = client.post(f"/api/projects/{p['id']}/domain-preview", json=settings).json()
    assert preview["bounds"] == [-10, 20, -5, 5, 0, 6]
    assert preview["error"] is None
    assert client.put(f"/api/projects/{p['id']}/settings", json=settings).status_code == 200
    run = client.post(f"/api/projects/{p['id']}/runs").json()
    assert run["domain"] == preview["bounds"]
    root = storage.directory("runs", run["id"])
    meta = foam.generate(
        root / "case-custom", root / "geometry", run["geometry"], Settings(**run["settings"])
    )
    assert meta["domain"] == run["domain"]
    assert meta["preset"]["memory_gb"] == 3
    control = (root / "case-custom/system/controlDict").read_text()
    assert "endTime 125;" in control and "writeInterval 125;" in control
    assert "(-10 -5 0)" in (root / "case-custom/system/blockMeshDict").read_text()
    updated = {**settings, "custom_iterations": 150, "simulation_box": dict(box(), x_max=21)}
    assert client.put(f"/api/projects/{p['id']}/settings", json=updated).status_code == 200
    assert storage.get("runs", run["id"])["settings"] == settings
    other = client.post(f"/api/projects/{p['id']}/runs").json()
    for saved in (run, other):
        storage.update(
            "runs",
            saved["id"],
            status="completed",
            result=dict(
                cd=0.3,
                cl=0.1,
                drag=1,
                downforce=-1,
                force_settled=True,
                residual_converged=True,
                ranges={name: [0, 1] for name in ("Pressure", "Speed", "Turbulence")},
                warnings=[],
            ),
        )
    compared = client.get(f"/api/compare?baseline={run['id']}&variant={other['id']}").json()
    assert not compared["comparable"]
    assert "simulation box" in compared["warnings"][0] and "iteration limit" in compared["warnings"][0]
    bad = {**updated, "simulation_box": dict(box(), x_max=0)}
    assert client.put(f"/api/projects/{p['id']}/settings", json=bad).status_code == 400
    assert storage.get("projects", p["id"])["settings"] == updated


def test_custom_precise_is_one_mesh_and_legacy_defaults():
    assert (
        resolved_preset(Settings(quality="custom", custom_mesh="precise", custom_iterations=333))[
            "iterations"
        ]
        == 333
    )
    assert resolved_preset(Settings(quality="precise"))["iterations"] == 1800
    assert Settings.model_validate_json(json.dumps({"quality": "medium"})).simulation_box is None


def test_small_part_box_uses_metres_without_changing_mesh_scale():
    geometry_data = {"bounds": [[-0.1, -0.04, 0.01], [0.1, 0.04, 0.08]]}
    settings = Settings(
        quality="custom",
        custom_mesh="fast",
        custom_iterations=75,
        simulation_box=dict(x_min=-0.4, x_max=0.8, y_min=-0.3, y_max=0.3, z_max=0.5),
    )
    bounds, counts, cell = foam.mesh_layout(geometry_data, settings)
    assert bounds == [-0.4, 0.8, -0.3, 0.3, 0, 0.5]
    assert counts == [39, 20, 17]
    assert cell == pytest.approx(0.65 * 0.2 / 4.2)


@pytest.mark.parametrize("quality", ["fast", "medium", "precise", "custom"])
def test_mesher_limits_match_final_skewness_gate(tmp_path, quality):
    geometry_dir = tmp_path / "geometry"
    geometry_dir.mkdir()
    data = geometry.sample(geometry_dir)
    case = tmp_path / "case"
    settings = Settings(
        quality=quality,
        simulation_box=dict(x_min=-4.7, x_max=10.3, y_min=-3.13, y_max=3.57, z_max=3.72),
    )
    meta = foam.generate(case, geometry_dir, data, settings)
    assert meta["domain"] == [-4.7, 10.3, -3.13, 3.57, 0, 3.72]
    # Boundary faces must satisfy the same limit as checkMesh's basic check,
    # including when snappy merges faces on the ground beside the wheels.
    for name in ("snappyHexMeshDict", "meshQualityDict"):
        text = (case / "system" / name).read_text()
        assert "maxBoundarySkewness 4;" in text
        assert "maxInternalSkewness 4;" in text


@pytest.mark.parametrize("failure", [
    "***Max skewness = 4.6500418, 4 highly skew faces detected",
    "***Negative volume cells detected",
])
def test_failed_mesh_still_blocks_solver_with_specific_reason(client, monkeypatch, failure):
    p = client.post("/api/projects", json={"sample": True}).json()
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "quality": "fast", "geometry_confirmed": True},
    )
    run = client.post(f"/api/projects/{p['id']}/runs").json()
    commands = []

    def stage(key, case, command, *args):
        commands.append(command)
        if command[0] == "checkMesh":
            (case / "log.checkMesh").write_text(f"{failure}\nFailed 1 mesh checks.\n")
        return 0

    monkeypatch.setattr(runner, "stage", stage)
    runner.execute(run["id"])
    failed = storage.get("runs", run["id"])
    assert failed["status"] == "failed"
    assert failure.lstrip("*") in failed["error"]
    assert "airflow solver was not started" in failed["error"]
    assert "repair the geometry" not in failed["error"]
    assert commands == [["blockMesh"], ["snappyHexMesh", "-overwrite"],
                        ["checkMesh", "-meshQuality", "-allTopology"]]
