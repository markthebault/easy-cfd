"""Behavioral checks for geometry, force units, immutable runs, and failure handling."""

import io
import json
import re
import zipfile
import numpy as np
import pytest
import trimesh
import vtk
from fastapi.testclient import TestClient
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy
from easycfd import storage, geometry, foam, runner, results
from easycfd.api import app
from easycfd.models import Settings, ImportOptions


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "health", lambda: {"ready": True, "memory_gb": 8})
    # API persistence is real; the container is exercised by scripts/smoke.py.
    return TestClient(app)


def project(client):
    r = client.post("/api/projects", json={"sample": True})
    assert r.status_code == 201
    return r.json()


def test_sample_and_wing_are_closed_and_separate(tmp_path):
    data = geometry.sample(tmp_path, wing=True)
    assert data["errors"] == []
    assert len(data["parts"]) == 6
    assert data["dimensions"][0] == pytest.approx(4.2)
    assert sum(p["role"] == "wheel" for p in data["parts"]) == 4
    for part in data["parts"]:
        assert trimesh.load_mesh(tmp_path / f"{part['id']}.stl").is_watertight


def test_stl_units_axes_and_clearance(tmp_path):
    source = tmp_path / "car.stl"
    mesh = trimesh.creation.box(extents=[2000, 4000, 1000])
    mesh.export(source)
    data = geometry.import_files(
        [source], tmp_path, ImportOptions(units="mm", forward="+Y", up="+Z", clearance=0.1)
    )
    assert data["dimensions"] == pytest.approx([4, 2, 1])
    assert data["bounds"][0][2] == pytest.approx(0.1)
    assert not data["errors"]


def test_bad_axes_and_nonfinite_values_are_rejected():
    with pytest.raises(ValueError):
        ImportOptions(forward="+Z", up="-Z")
    with pytest.raises(ValueError):
        Settings(speed_kmh=float("nan"))


def test_high_speed_settings():
    assert Settings(speed_kmh=270).speed_kmh == 270
    assert Settings(speed_kmh=300).speed_kmh == 300
    with pytest.raises(ValueError):
        Settings(speed_kmh=301)


def test_open_surface_is_retained_for_review_but_blocked(tmp_path):
    mesh = trimesh.creation.box()
    mesh.update_faces(np.arange(len(mesh.faces) - 1))
    data = geometry.persist_parts(tmp_path, [("Open car", mesh, "body", None)])
    assert any("Open edges" in e for e in data["errors"])
    assert (tmp_path / "part0.vtp").exists()


def test_step_embedded_units(tmp_path):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
    from OCP.IFSelect import IFSelect_RetDone

    source = tmp_path / "box.step"
    writer = STEPControl_Writer()
    writer.Transfer(BRepPrimAPI_MakeBox(4000, 1800, 1200).Shape(), STEPControl_AsIs)
    assert writer.Write(str(source)) == IFSelect_RetDone
    # STL units must not rescale a STEP file.
    data = geometry.import_files([source], tmp_path, ImportOptions(units="in"))
    assert data["dimensions"] == pytest.approx([4, 1.8, 1.2])


def test_confirmation_and_snapshot(client):
    p = project(client)
    assert client.post(f"/api/projects/{p['id']}/runs").status_code == 400
    settings = {**p["settings"], "geometry_confirmed": True, "quality": "fast"}
    assert client.put(f"/api/projects/{p['id']}/settings", json=settings).status_code == 200
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    assert r["status"] == "queued"
    client.post(f"/api/projects/{p['id']}/sample?wing=true")
    client.put(f"/api/projects/{p['id']}/settings", json={**settings, "speed_kmh": 180})
    saved = client.get(f"/api/runs/{r['id']}").json()
    assert len(saved["geometry"]["parts"]) == 5
    assert saved["settings"]["speed_kmh"] == 100
    assert (storage.directory("runs", r["id"]) / "geometry/part0.stl").exists()


def test_duplicate_preserves_comparison_conditions(client):
    p = project(client)
    clone = client.post(f"/api/projects/{p['id']}/duplicate").json()
    assert clone["id"] != p["id"]
    assert clone["settings"] == p["settings"]
    assert clone["geometry"]["fingerprint"] == p["geometry"]["fingerprint"]


def test_invalid_import_does_not_replace_geometry(client):
    p = project(client)
    r = client.post(
        f"/api/projects/{p['id']}/import", files={"files": ("evil.txt", io.BytesIO(b"test"), "text/plain")}
    )
    assert r.status_code == 400
    assert client.get(f"/api/projects/{p['id']}").json()["geometry"] == p["geometry"]


def test_nonlocal_origin_and_host_blocked(client):
    assert client.post("/api/projects", json={}, headers={"Origin": "https://example.com"}).status_code == 403
    assert client.get("/api/projects", headers={"Host": "example.com"}).status_code == 403
    assert client.get("/api/projects/invalid").status_code == 404


def test_pressure_and_speed_conversion():
    poly = vtk.vtkPolyData()
    points = vtk.vtkPoints()
    points.InsertNextPoint(0, 0, 0)
    poly.SetPoints(points)
    cells = vtk.vtkCellArray()
    cells.InsertNextCell(1)
    cells.InsertCellPoint(0)
    poly.SetVerts(cells)
    for name, values in [("p", np.array([2.0])), ("U", np.array([[3.0, 4.0, 0.0]])), ("k", np.array([0.5]))]:
        array = numpy_to_vtk(values, deep=True)
        array.SetName(name)
        poly.GetPointData().AddArray(array)
    output = results.add_fields(poly, 1.225)
    assert vtk_to_numpy(output.GetPointData().GetArray("Pressure"))[0] == pytest.approx(2.45)
    assert vtk_to_numpy(output.GetPointData().GetArray("Speed"))[0] == 5


def test_force_signs_area_and_stability(tmp_path):
    folder = tmp_path / "postProcessing/coefficients/0"
    folder.mkdir(parents=True)
    (folder / "coefficient.dat").write_text("# Time Cd Cl\n" + "\n".join(f"{i} 0.3 -0.2" for i in range(100)))
    result = results.coefficients(tmp_path, {"density": 1.2, "reference_area": 2}, 10)
    assert result["drag"] == pytest.approx(36)
    assert result["downforce"] == pytest.approx(24)
    assert result["force_settled"]
    (folder / "coefficient.dat").write_text(
        "# Time Cd Cl\n" + "\n".join(f"{i} {i * 0.01} -0.2" for i in range(100))
    )
    assert not results.coefficients(tmp_path, {"density": 1.2, "reference_area": 2}, 10)["force_settled"]


def test_road_and_wheel_directions_and_yaw(tmp_path):
    g = tmp_path / "geometry"
    g.mkdir()
    data = geometry.sample(g)
    meta = foam.generate(tmp_path / "case", g, data, Settings(yaw_deg=10, quality="fast"))
    u = (tmp_path / "case/0/U").read_text()
    assert "omega -86.80555555555554" in u or "omega -86.80555555555556" in u
    assert "ground {type fixedValue; value uniform (27.7777778 0 0);}" in u
    assert meta["velocity"][1] > 0
    assert meta["freestream"] > 100 / 3.6
    control = (tmp_path / "case/system/controlDict").read_text()
    assert "dragDir (1 0 0)" in control
    assert "rhoInf 1.225" in control


def test_cancellation_and_failed_stage(client, monkeypatch):
    p = project(client)
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "geometry_confirmed": True, "quality": "fast"},
    )
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    assert client.post(f"/api/runs/{r['id']}/cancel").status_code == 200
    runner.execute(r["id"])
    assert storage.get("runs", r["id"])["status"] == "cancelled"
    assert storage.get("runs", r["id"])["stage"] == "Cancelled"
    assert storage.get("runs", r["id"])["finished"]
    r = client.post(f"/api/projects/{p['id']}/runs").json()

    def fail(*args):
        raise RuntimeError("Meshing failed: non-manifold surface")

    monkeypatch.setattr(runner, "solve", fail)
    runner.execute(r["id"])
    saved = storage.get("runs", r["id"])
    assert saved["status"] == "failed"
    assert "Meshing failed" in saved["error"]
    assert "result" not in saved


def test_compare_flags_conditions_and_zero_percent(client):
    ids = []
    for area in [2.2, 3.0]:
        key = storage.identifier()
        ids.append(key)
        storage.save(
            "runs",
            dict(
                id=key,
                created=storage.now(),
                status="completed",
                image=foam.IMAGE,
                settings=Settings(reference_area=area).model_dump(),
                result=dict(
                    drag=10,
                    downforce=0,
                    cd=0.2,
                    cl=0,
                    force_settled=True,
                    residual_converged=True,
                    ranges={f: [0, 1] for f in ["Pressure", "Speed", "Turbulence"]},
                ),
            ),
        )
    result = client.get(f"/api/compare?baseline={ids[0]}&variant={ids[1]}").json()
    assert not result["comparable"]
    assert "reference_area" in result["warnings"][0]
    assert result["changes"]["downforce"]["percent"] is None


def test_runtime_budget_rejects_before_queue(client, monkeypatch):
    p = project(client)
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "geometry_confirmed": True, "quality": "precise"},
    )
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=4))
    response = client.post(f"/api/projects/{p['id']}/runs")
    assert response.status_code == 400
    assert "6.5 GB" in response.json()["detail"]


def test_benchmark_preserves_reynolds_number_and_reference_conditions(tmp_path):
    from easycfd.benchmark import REFERENCE, apply_boundaries, domain

    g = tmp_path / "geometry"
    g.mkdir()
    data = geometry.sample(g)
    case = tmp_path / "case"
    settings = Settings(
        speed_kmh=144,
        density=1,
        reference_area=REFERENCE["reference_area"],
        moving_ground=False,
        wheels=False,
    )
    meta = foam.generate(case, g, data, settings, reference_case="ahmedml-run-1")
    apply_boundaries(case, meta)
    assert meta["domain"] == domain()
    assert meta["freestream"] / 1.5e-5 == pytest.approx(1 / 3.75e-7)
    assert float(
        re.search(r"internalField uniform ([^;]+)", (case / "0/k").read_text()).group(1)
    ) == pytest.approx(0.0864)
    assert "internalField uniform 576.0;" in (case / "0/omega").read_text()
    assert "sides {type slip;}" in (case / "0/U").read_text()
    assert "ground {type fixedValue; value uniform (0 0 0);}" in (case / "0/U").read_text()


def test_precise_compares_two_real_stages_and_preserves_failure(client, monkeypatch):
    p = project(client)
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "geometry_confirmed": True, "quality": "precise"},
    )
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    calls = []

    def stage(key, tier):
        calls.append(tier)
        (storage.directory("runs", key) / "results").mkdir(exist_ok=True)
        return dict(
            cd=0.3 if tier == "medium" else 0.32,
            cl=-0.2,
            force_settled=True,
            residual_converged=tier == "precise",
            iteration=1000,
            timings={"simpleFoam": 1},
            warnings=[],
        )

    monkeypatch.setattr(runner, "solve", stage)
    runner.execute(r["id"])
    result = storage.get("runs", r["id"])["result"]
    assert calls == ["medium", "precise"]
    assert result["refinement"]["delta_cd"] == pytest.approx(0.02)
    assert not result["refinement"]["both_converged"]
    assert result["medium_timings"]["simpleFoam"] == 1


def test_near_zero_lift_and_unconverged_medium_cannot_imply_confident_ranking(client):
    keys = []
    for cd in [0.3, 0.32]:
        key = storage.identifier()
        keys.append(key)
        storage.save(
            "runs",
            dict(
                id=key,
                created=storage.now(),
                status="completed",
                image=foam.IMAGE,
                settings=Settings(quality="precise").model_dump(),
                result=dict(
                    drag=cd * 100,
                    downforce=0,
                    cd=cd,
                    cl=0,
                    force_settled=True,
                    residual_converged=True,
                    wall_target_fraction=0.95,
                    refinement=dict(delta_cd=0.03, delta_cl=0, both_settled=True, both_converged=False),
                    ranges={f: [0, 1] for f in ["Pressure", "Speed", "Turbulence"]},
                ),
            ),
        )
    result = client.get(f"/api/compare?baseline={keys[0]}&variant={keys[1]}").json()
    assert any("refinement evidence" in w for w in result["warnings"])
    assert any("Ranking is inconclusive" in w for w in result["warnings"])
    assert result["changes"]["downforce"]["percent"] is None


def test_path_escape_and_invalid_slice_are_rejected(client):
    assert client.get("/api/projects/not-an-id").status_code == 404
    p = project(client)
    assert client.get(f"/api/projects/{p['id']}/geometry/not-a-part.vtp").status_code == 404
    assert client.get(f"/api/runs/{p['id']}/slice?axis=y&position=101").status_code == 400


def test_frontal_area_estimate_is_sane_and_grows_with_wing(tmp_path):
    base = geometry.sample(tmp_path / "base")
    wing = geometry.sample(tmp_path / "wing", wing=True)
    assert 1.0 < base["frontal_area_estimate"] < 4.0
    assert wing["frontal_area_estimate"] > base["frontal_area_estimate"]


def test_control_dict_has_per_role_force_objects(tmp_path):
    g = tmp_path / "geometry"
    g.mkdir()
    data = geometry.sample(g)
    foam.generate(tmp_path / "case", g, data, Settings(quality="fast"))
    control = (tmp_path / "case/system/controlDict").read_text()
    assert "forcesBody {type forces; libs (forces); patches (part0);" in control
    assert "forcesWheels" in control and "part1 part2 part3 part4" in control
    solo = tmp_path / "solo"
    solo.mkdir()
    box = trimesh.creation.box(extents=[4, 1.8, 1.2])
    single = geometry.persist_parts(solo, [("Car", box, "body", None)])
    foam.generate(tmp_path / "case2", solo, single, Settings(quality="fast"))
    control = (tmp_path / "case2/system/controlDict").read_text()
    assert "forcesBody" in control
    assert "forcesWheels" not in control


def test_blockage_ratio_uses_tunnel_cross_section(tmp_path):
    g = tmp_path / "geometry"
    g.mkdir()
    data = geometry.sample(g)
    meta = foam.generate(tmp_path / "case", g, data, Settings(quality="fast"))
    assert meta["blockage_ratio"] == pytest.approx(2.2 / meta["tunnel_cross_section"])
    assert 0 < meta["blockage_ratio"] < 0.05


def test_role_force_breakdown_splits_pressure_viscous_and_body(tmp_path):
    folder = tmp_path / "postProcessing/coefficients/0"
    folder.mkdir(parents=True)
    (folder / "coefficient.dat").write_text("# Time Cd Cl\n" + "\n".join(f"{i} 0.3 -0.2" for i in range(100)))
    body = tmp_path / "postProcessing/forcesBody/0"
    body.mkdir(parents=True)
    (body / "force.dat").write_text(
        "# Force\n# Time total_x total_y total_z pressure_x pressure_y pressure_z viscous_x viscous_y viscous_z\n"
        + "\n".join(f"{i} 36 0 -4 20 0 -3 16 0 -1" for i in range(100))
    )
    settings = {"density": 1.2, "reference_area": 2}
    groups = results.role_forces(tmp_path, settings, 10)
    assert set(groups) == {"body"}
    assert groups["body"]["drag"] == pytest.approx(36)
    assert groups["body"]["downforce"] == pytest.approx(4)
    assert groups["body"]["pressure_drag"] == pytest.approx(20)
    assert groups["body"]["viscous_drag"] == pytest.approx(16)
    assert groups["body"]["cd"] == pytest.approx(0.3)
    (body / "force.dat").write_text("# Time\n" + "\n".join("0 1 2 3 4 5 6 7 8 9" for _ in range(10)))
    with pytest.raises(RuntimeError, match="Unrecognized"):
        results.role_forces(tmp_path, settings, 10)
    (body / "force.dat").write_text(
        "# Time total_x total_y total_z pressure_x pressure_y pressure_z viscous_x viscous_y viscous_z\n"
        + "\n".join("0 36 0 nan 20 0 -3 16 0 -1" for _ in range(10))
    )
    with pytest.raises(RuntimeError, match="non-finite"):
        results.role_forces(tmp_path, settings, 10)


def test_compare_attributes_drag_change_to_body_and_wheels(client):
    ids = []
    for extra in [0, 5]:
        key = storage.identifier()
        ids.append(key)
        storage.save(
            "runs",
            dict(
                id=key,
                created=storage.now(),
                status="completed",
                image=foam.IMAGE,
                settings=Settings().model_dump(),
                result=dict(
                    drag=100 + extra,
                    downforce=0,
                    cd=0.3,
                    cl=0,
                    force_settled=True,
                    residual_converged=True,
                    ranges={f: [0, 1] for f in ["Pressure", "Speed", "Turbulence"]},
                    breakdown=dict(
                        body=dict(drag=80 + extra, downforce=0),
                        wheels=dict(drag=20, downforce=0),
                        pressure_drag=70 + extra,
                        viscous_drag=30,
                        consistent=True,
                    ),
                ),
            ),
        )
    result = client.get(f"/api/compare?baseline={ids[0]}&variant={ids[1]}").json()
    assert result["changes"]["body_drag"]["delta"] == pytest.approx(5)
    assert result["changes"]["wheels_drag"]["delta"] == pytest.approx(0)
    assert result["changes"]["pressure_drag"]["delta"] == pytest.approx(5)
    assert result["changes"]["viscous_drag"]["delta"] == pytest.approx(0)


def test_explicit_tailnet_origin(client, monkeypatch):
    origin = "https://example.ts.net:8443"
    monkeypatch.setenv("EASYCFD_TAILNET_ORIGIN", origin)
    headers = {"host": "example.ts.net:8443", "origin": origin}
    assert client.get("/api/projects", headers=headers).status_code == 200
    assert client.get("/api/projects", headers={**headers, "origin": "https://other.ts.net"}).status_code == 403
    assert client.get("/api/projects", headers={**headers, "host": "other.ts.net"}).status_code == 403


def test_flow_window_scales_with_car_length():
    full = results.flow_window([-2.1, -1.17, 0.01], [2.1, 1.17, 1.32])
    # Unchanged for the 4.2 m sample the margins were tuned on.
    assert full["seed_y"] == pytest.approx((-1.67, 1.67))
    assert full["seed_z"] == pytest.approx((0.08, 1.82))
    assert full["slice_bounds"] == pytest.approx([-6.3, 10.5, -1.67, 1.67, 0.02, 2.02])
    small = results.flow_window([-0.21, -0.117, 0.001], [0.21, 0.117, 0.132])
    assert small["slice_bounds"] == pytest.approx([x / 10 for x in full["slice_bounds"]])
    assert small["seed_z"] == pytest.approx(tuple(x / 10 for x in full["seed_z"]))


def test_solver_ranks_and_cpu_limit_fit_the_runtime(client, monkeypatch):
    p = project(client)
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "geometry_confirmed": True, "quality": "fast"},
    )
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=8, cpus=2))
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    # Docker rejects --cpus above the runtime's count; four ranks share two CPUs.
    assert (r["processes"], r["cpus"]) == (4, 2)
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=8, cpus=12))
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    assert (r["processes"], r["cpus"]) == (4, 4)
    monkeypatch.setenv("EASYCFD_PROCESSES", "8")
    r = client.post(f"/api/projects/{p['id']}/runs").json()
    assert (r["processes"], r["cpus"]) == (8, 8)
    monkeypatch.setenv("EASYCFD_PROCESSES", "1")
    assert runner.processes() == 2
    g = storage.ROOT / "g"
    g.mkdir()
    foam.generate(storage.ROOT / "case", g, geometry.sample(g), Settings(quality="fast"), processes=8)
    assert "numberOfSubdomains 8;" in (storage.ROOT / "case/system/decomposeParDict").read_text()


def test_solve_passes_ranks_and_removes_processor_copies(client, monkeypatch):
    p = project(client)
    client.put(
        f"/api/projects/{p['id']}/settings",
        json={**p["settings"], "geometry_confirmed": True, "quality": "fast"},
    )
    monkeypatch.setattr(runner, "health", lambda: dict(ready=True, memory_gb=8, cpus=6))
    monkeypatch.setenv("EASYCFD_PROCESSES", "6")
    run = client.post(f"/api/projects/{p['id']}/runs").json()
    calls = []

    def stage(key, case, command, stage_name, memory, cpus=4):
        calls.append((command, cpus))
        if command[0] == "snappyHexMesh":
            (case / "constant/polyMesh").mkdir(parents=True)
            (case / "constant/polyMesh/boundary").write_text(
                " ".join(f"{part['id']} {{ nFaces 50; }}" for part in run["geometry"]["parts"])
            )
            (case / "log.snappyHexMesh").write_text("Finished meshing")
        if command[0] == "checkMesh":
            (case / "log.checkMesh").write_text("cells: 1000\nMesh OK.")
        if command[0] == "decomposePar":
            # purgeWrite keeps two times; both exist only per rank until reconstructed.
            for i in range(6):
                for t in ("200", "300"):
                    (case / f"processor{i}/{t}").mkdir(parents=True)
                    (case / f"processor{i}/{t}/U").write_text("per-rank field")
        if command[0] == "reconstructPar":
            for t in ("200", "300"):
                (case / t).mkdir()
                (case / f"{t}/U").write_text("reconstructed field")
        return 1.0

    monkeypatch.setattr(runner, "stage", stage)
    def process(case, output, run, meta):
        output.mkdir()
        return dict(warnings=[])

    monkeypatch.setattr(results, "process", process)
    runner.solve(run["id"], "fast")
    solver = next(command for command, _ in calls if command[0] == "mpirun")
    assert solver[solver.index("-np") + 1] == "6"
    assert {cpus for _, cpus in calls} == {6}
    assert ["reconstructPar", "-newTimes"] in [command for command, _ in calls]
    case = storage.directory("runs", run["id"]) / "case-fast"
    assert not list(case.glob("processor*"))
    assert (case / "200/U").exists() and (case / "300/U").exists()


def test_processor_copies_are_removable_only_when_every_time_was_reconstructed(tmp_path):
    for i in range(2):
        (tmp_path / f"processor{i}/constant/polyMesh").mkdir(parents=True)
        for t in ("0", "200", "300"):
            (tmp_path / f"processor{i}/{t}").mkdir()
            for field in ("U", "p"):
                (tmp_path / f"processor{i}/{t}/{field}").write_text("rank")
    for t in ("0", "300"):
        (tmp_path / t).mkdir()
        for field in ("U", "p"):
            (tmp_path / f"{t}/{field}").write_text("reconstructed")
    # Only the latest time was reconstructed, as by -latestTime: 200 is unique per rank.
    assert runner.redundant_processor_copies(tmp_path) == []
    (tmp_path / "200").mkdir()
    (tmp_path / "200/U").write_text("reconstructed")
    assert runner.redundant_processor_copies(tmp_path) == []
    (tmp_path / "200/p").write_text("reconstructed")
    assert runner.redundant_processor_copies(tmp_path) == [tmp_path / "processor0", tmp_path / "processor1"]


def test_run_list_omits_history_and_export_leaves_no_archive(client):
    key = storage.identifier()
    root = storage.directory("runs", key)
    (root / "case-fast/processor0/300").mkdir(parents=True)
    (root / "case-fast/processor0/300/U").write_text("duplicate")
    (root / "case-fast/300").mkdir()
    (root / "case-fast/300/U").write_text("reconstructed")
    (root / "case-fast/log.simpleFoam").write_text("log")
    # A time held only per rank must reach the export.
    (root / "case-medium/processor0/900").mkdir(parents=True)
    (root / "case-medium/processor0/900/U").write_text("unique")
    storage.save(
        "runs",
        dict(
            id=key,
            created=storage.now(),
            status="completed",
            result=dict(cd=0.3, history=[dict(iteration=1, cd=0.3, cl=0)]),
        ),
    )
    listed = next(r for r in client.get("/api/runs").json() if r["id"] == key)
    assert "history" not in listed["result"] and listed["result"]["cd"] == 0.3
    assert client.get(f"/api/runs/{key}").json()["result"]["history"]
    response = client.get(f"/api/runs/{key}/export")
    assert response.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    assert "case-fast/log.simpleFoam" in names
    assert not any(name.startswith("case-fast/processor") for name in names)
    assert "case-medium/processor0/900/U" in names
    assert not (root / "run.zip").exists()
    assert not list(storage.ROOT.glob("export-*.zip"))


def stl(mesh):
    out = io.BytesIO()
    mesh.export(out, file_type="stl")
    out.seek(0)
    return out


def imported_car(client):
    """Synthetic box car in millimetres, Y forward, with one wheel as a separate file."""
    p = project(client)
    body = trimesh.creation.box(extents=[1800, 4000, 1200])
    body.apply_translation([0, 0, 900])
    wheel = trimesh.creation.cylinder(radius=300, height=200, sections=24)
    wheel.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    wheel.apply_translation([1100, -1300, 300])
    options = dict(units="mm", forward="-Y", up="+Z", clearance=0.02)
    r = client.post(
        f"/api/projects/{p['id']}/import",
        files=[("files", ("body.stl", stl(body))), ("files", ("wheel.stl", stl(wheel)))],
        data={"options": json.dumps(options)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_added_parts_keep_car_position_and_toggle_out_of_runs(client):
    p = imported_car(client)
    before = p["geometry"]
    assert [s["base"] for s in before["sources"]] == [True, True]
    # A wing exported in the same scene: above the body's rear, in the same units.
    wing = trimesh.creation.box(extents=[1600, 300, 50])
    wing.apply_translation([0, 1800, 1700])
    r = client.post(f"/api/projects/{p['id']}/parts", files=[("files", ("wing v2.stl", stl(wing)))])
    assert r.status_code == 201, r.text
    after = r.json()["geometry"]
    wing_part = after["parts"][-1]
    assert after["sources"][-1] == dict(file="2-wing v2.stl", name="wing v2.stl", base=False, components=1)
    assert np.array(after["parts"][0]["bounds"]) == pytest.approx(np.array(before["parts"][0]["bounds"]))
    # Not re-centered: 1.8 m behind the body centre (+X is rearward), 0.175 m above its roof.
    assert wing_part["bounds"][0][0] == pytest.approx(1.65)
    assert wing_part["bounds"][1][2] == pytest.approx(0.02 + 1.725)
    assert after["fingerprint"] != before["fingerprint"]
    assert not (storage.directory("projects", p["id"]) / p["geometry_dir"]).exists()

    r = client.put(f"/api/projects/{p['id']}/parts-enabled", json=dict(part_ids=[wing_part["id"]], enabled=False))
    off = r.json()
    assert off["geometry"]["fingerprint"] == before["fingerprint"]
    assert off["geometry"]["frontal_area_estimate"] == pytest.approx(before["frontal_area_estimate"])
    assert not off["settings"]["geometry_confirmed"]
    client.put(f"/api/projects/{p['id']}/settings", json={**off["settings"], "geometry_confirmed": True})
    run = client.post(f"/api/projects/{p['id']}/runs").json()
    assert [part["id"] for part in run["geometry"]["parts"]] == ["part0", "part1"]

    client.put(f"/api/projects/{p['id']}/parts-enabled", json=dict(part_ids=[wing_part["id"]], enabled=True))
    project_ = client.get(f"/api/projects/{p['id']}").json()
    client.put(f"/api/projects/{p['id']}/settings", json={**project_["settings"], "geometry_confirmed": True})
    with_wing = client.post(f"/api/projects/{p['id']}/runs").json()
    assert with_wing["configuration"] == dict(added=["wing v2.stl"], excluded=[])
    for r in (run, with_wing):
        record = storage.get("runs", r["id"])
        record.update(status="completed", result=dict(drag=1, downforce=0, cd=0.1, cl=0, force_settled=True,
                      residual_converged=True, ranges={f: [0, 1] for f in ["Pressure", "Speed", "Turbulence"]}))
        storage.save("runs", record)
    parts = client.get(f"/api/compare?baseline={run['id']}&variant={with_wing['id']}").json()["parts"]
    assert parts == dict(same=False, only_baseline=[], only_variant=["wing v2.stl"])


def test_reorient_rebuilds_from_originals_and_keeps_roles(client):
    p = imported_car(client)
    wheel = p["geometry"]["parts"][1]
    client.put(f"/api/projects/{p['id']}/parts/{wheel['id']}", json=dict(role="wheel", radius=0.3))
    options = p["geometry"]["import_options"]
    turned = client.put(f"/api/projects/{p['id']}/import-options", json={**options, "forward": "+X"}).json()
    # The wheel sticks out 0.3 m sideways; forward +X only swaps longitudinal and transverse.
    assert turned["geometry"]["dimensions"] == pytest.approx([2.1, 4.0, 1.5])
    assert turned["geometry"]["parts"][1]["wheel"]["radius"] == pytest.approx(0.3)
    assert not turned["settings"]["geometry_confirmed"]
    # Centimetres instead of millimetres: 10x larger, wheel radius scales with the part.
    scaled = client.put(f"/api/projects/{p['id']}/import-options", json={**options, "units": "cm"}).json()
    assert scaled["geometry"]["parts"][1]["wheel"]["radius"] == pytest.approx(3.0)
    assert any("Unexpected model size" in e for e in scaled["geometry"]["errors"])


def test_added_part_below_road_blocks_and_base_files_cannot_be_removed(client):
    p = imported_car(client)
    splitter = trimesh.creation.box(extents=[1600, 200, 20])
    splitter.apply_translation([0, -2100, -30])
    data = client.post(f"/api/projects/{p['id']}/parts", files=[("files", ("splitter.stl", stl(splitter)))]).json()
    assert any("above the road" in e for e in data["geometry"]["errors"])
    part = data["geometry"]["parts"][-1]["id"]
    off = client.put(f"/api/projects/{p['id']}/parts-enabled", json=dict(part_ids=[part], enabled=False)).json()
    assert not off["geometry"]["errors"]
    base = data["geometry"]["sources"][0]["file"]
    assert client.delete(f"/api/projects/{p['id']}/sources/{base}").status_code == 400
    removed = client.delete(f"/api/projects/{p['id']}/sources/{data['geometry']['sources'][-1]['file']}").json()
    assert len(removed["geometry"]["parts"]) == 2
    sample = project(client)
    assert client.post(f"/api/projects/{sample['id']}/parts", files=[("files", ("x.stl", stl(splitter)))]).status_code == 400


def completed(client, project_id):
    """Queue a run of the project as saved, then mark it completed with placeholder forces."""
    current = client.get(f"/api/projects/{project_id}").json()
    client.put(f"/api/projects/{project_id}/settings", json={**current["settings"], "geometry_confirmed": True})
    run = client.post(f"/api/projects/{project_id}/runs").json()
    record = storage.get("runs", run["id"])
    ranges = {f: [0, 1] for f in ["Pressure", "Speed", "Turbulence"]}
    record.update(
        status="completed",
        result=dict(drag=1, downforce=0, cd=0.1, cl=0, force_settled=True, residual_converged=True, ranges=ranges),
    )
    storage.save("runs", record)
    return run["id"]


def test_compare_names_components_switched_off_inside_one_file(client):
    p = imported_car(client)
    # One STL with two disconnected pieces: a wing and a separate gurney strip.
    wing = trimesh.creation.box(extents=[1600, 300, 50])
    wing.apply_translation([0, 1800, 1700])
    strip = trimesh.creation.box(extents=[1600, 20, 20])
    strip.apply_translation([0, 2000, 1800])
    both = trimesh.util.concatenate([wing, strip])
    data = client.post(f"/api/projects/{p['id']}/parts", files=[("files", ("aero.stl", stl(both)))]).json()
    assert data["geometry"]["sources"][-1]["components"] == 2
    added = [part for part in data["geometry"]["parts"] if part["source"] == 2]
    full = completed(client, p["id"])
    client.put(f"/api/projects/{p['id']}/parts-enabled", json=dict(part_ids=[added[1]["id"]], enabled=False))
    partial = completed(client, p["id"])
    client.put(f"/api/projects/{p['id']}/parts-enabled", json=dict(part_ids=[added[0]["id"]], enabled=False))
    none = completed(client, p["id"])

    def diff(a, b):
        return client.get(f"/api/compare?baseline={a}&variant={b}").json()["parts"]

    # One component off inside a multipart file is named, not hidden behind the file name.
    assert diff(full, partial) == dict(same=False, only_baseline=[added[1]["name"]], only_variant=[])
    # A whole file off is named once.
    assert diff(none, full) == dict(same=False, only_baseline=[], only_variant=["aero.stl"])
    assert diff(partial, none)["only_baseline"] == [added[0]["name"]]
    labels = [storage.get("runs", r)["configuration"]["added"] for r in (full, partial, none)]
    assert labels == [["aero.stl"], [added[0]["name"]], []]


def synthetic_volume(folder):
    """Known flow U = (10 + x, 2y, z) around a hole where a car would be; synthetic test data."""
    image = vtk.vtkImageData()
    image.SetDimensions(41, 31, 21)
    image.SetOrigin(-2, -1.5, 0)
    image.SetSpacing(0.2, 0.1, 0.1)
    count = image.GetNumberOfPoints()
    xyz = np.array([image.GetPoint(i) for i in range(count)])
    velocity = np.stack([10 + xyz[:, 0], 2 * xyz[:, 1], xyz[:, 2]], axis=1)
    for name, values in [
        ("U", velocity),
        ("Speed", np.linalg.norm(velocity, axis=1)),
        ("Pressure", -xyz[:, 0] * 10),
        ("Turbulence", np.full(count, 0.5)),
    ]:
        array = numpy_to_vtk(values, deep=True)
        array.SetName(name)
        image.GetPointData().AddArray(array)
    centers = vtk.vtkCellCenters()
    centers.SetInputData(image)
    centers.Update()
    middle = vtk_to_numpy(centers.GetOutput().GetPoints().GetData())
    keep = vtk.vtkIdList()
    for i, (x, y, z) in enumerate(middle):
        if not (-1 < x < 1 and -0.5 < y < 0.5 and z < 1):
            keep.InsertNextId(i)
    extract = vtk.vtkExtractCells()
    extract.SetInputData(image)
    extract.SetCellList(keep)
    extract.Update()
    folder.mkdir(parents=True, exist_ok=True)
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(folder / "volume.vtu"))
    writer.SetInputData(extract.GetOutput())
    writer.Write()
    return [-2, 6, -1.5, 1.5, 0, 2]


def test_plane_grid_orients_components_and_masks_the_car(tmp_path):
    from easycfd import plane

    bounds = synthetic_volume(tmp_path)
    header, fields = plane.read(plane.plane_field(tmp_path, "z", 25, bounds, 27.8))
    assert (header["horizontal"], header["vertical"], header["position"]) == ("X", "Y", pytest.approx(0.5))
    nx, ny = header["nx"], header["ny"]
    assert nx == 640 and abs(ny - 640 * 3 / 8) <= 1

    def at(x, y, h):
        i = round((x - h["left"]) / (h["right"] - h["left"]) * (h["nx"] - 1))
        j = round((y - h["bottom"]) / (h["top"] - h["bottom"]) * (h["ny"] - 1))
        return j, i

    j, i = at(4, 1, header)
    assert fields["valid"][j, i]
    assert fields["u"][j, i] == pytest.approx(14, abs=0.05)
    assert fields["v"][j, i] == pytest.approx(2, abs=0.05)
    assert fields["Pressure"][j, i] == pytest.approx(-40, abs=0.1)
    # Inside the car: no fluid cells, so masked rather than interpolated.
    assert not fields["valid"][at(0, 0, header)]
    assert 0.8 < header["valid_fraction"] < 1

    # Cross-sections look downstream from the nose: +Y is on the left, so the
    # rightward component is -Uy.
    header, fields = plane.read(plane.plane_field(tmp_path, "x", 75, bounds, 27.8))
    assert (header["horizontal"], header["left"], header["right"]) == ("Y", 1.5, -1.5)
    j, i = at(1.2, 1.5, header)
    assert fields["u"][j, i] == pytest.approx(-2.4, abs=0.05)
    assert fields["v"][j, i] == pytest.approx(1.5, abs=0.05)
    # Side plane: right is +X, up is +Z.
    header, fields = plane.read(plane.plane_field(tmp_path, "y", 50, bounds, 27.8))
    j, i = at(5, 1.5, header)
    assert (header["horizontal"], header["vertical"]) == ("X", "Z")
    assert fields["u"][j, i] == pytest.approx(15, abs=0.05)
    assert fields["v"][j, i] == pytest.approx(1.5, abs=0.05)


def test_plane_endpoint_serves_gzip_and_validates(client):
    key = storage.identifier()
    bounds = synthetic_volume(storage.directory("runs", key) / "results")
    storage.save(
        "runs",
        dict(id=key, created=storage.now(), status="completed", settings=Settings().model_dump(),
             result=dict(slice_bounds=bounds)),
    )
    r = client.get(f"/api/runs/{key}/plane?axis=z&position=25")
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert r.content[:4] == b"ECFP"  # the test client decompresses like a browser
    assert client.get(f"/api/runs/{key}/plane?axis=z&position=101").status_code == 400
    assert client.get(f"/api/runs/{key}/plane?axis=w").status_code == 422


def test_plane_masks_extrapolated_probe_values():
    from easycfd import plane

    velocity = np.array([[3.0, 4.0, 0.0], [30.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    # |U| = 5 within the speed; 30 above the interpolated speed of 12; negative speed.
    speed = np.array([5.2, 12.0, -1.0])
    assert plane.interpolated(velocity, speed).tolist() == [True, False, False]
