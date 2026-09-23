"""Behavioral checks for geometry, force units, immutable runs, and failure handling."""

import io
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
