"""Endpoints used by the web UI's OpenFOAM engine: live coefficients, resampled flow, surface values."""

import gzip
import numpy as np
import pytest
import vtk
from fastapi.testclient import TestClient
from vtk.util.numpy_support import numpy_to_vtk
from easycfd import runner, storage
from easycfd.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "health", lambda: {"ready": True, "memory_gb": 8})
    return TestClient(app)


def add(data, name, values):
    array = numpy_to_vtk(np.ascontiguousarray(values), deep=True)
    array.SetName(name)
    data.AddArray(array)


def saved_run(tmp_path, status="completed"):
    """A run folder with synthetic results: uniform flow U = (x + 20, 0, 0), p = x, k = 1."""
    key = "a" * 32
    folder = tmp_path / "runs" / key
    results = folder / "results"
    results.mkdir(parents=True)
    grid = vtk.vtkImageData()
    grid.SetDimensions(21, 11, 11)
    grid.SetOrigin(-5, -2.5, 0)
    grid.SetSpacing(0.5, 0.5, 0.5)
    points = np.array([grid.GetPoint(i) for i in range(grid.GetNumberOfPoints())])
    velocity = np.column_stack([points[:, 0] + 20, np.zeros(len(points)), np.zeros(len(points))])
    for name, values in [("U", velocity), ("Speed", np.abs(velocity[:, 0])), ("p", points[:, 0]), ("k", np.ones(len(points)))]:
        add(grid.GetPointData(), name, values)
    append = vtk.vtkAppendFilter()
    append.AddInputData(grid)
    append.Update()
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(results / "volume.vtu"))
    writer.SetInputData(append.GetOutput())
    writer.Write()
    # Wall surface: a plane of points at z = 1 with p = 2 x.
    surface = vtk.vtkPlaneSource()
    surface.SetOrigin(-1, -1, 1)
    surface.SetPoint1(1, -1, 1)
    surface.SetPoint2(-1, 1, 1)
    surface.SetResolution(20, 20)
    surface.Update()
    poly = surface.GetOutput()
    wall = np.array([poly.GetPoint(i) for i in range(poly.GetNumberOfPoints())])
    add(poly.GetPointData(), "p", 2 * wall[:, 0])
    pw = vtk.vtkXMLPolyDataWriter()
    pw.SetFileName(str(results / "surface.vtp"))
    pw.SetInputData(poly)
    pw.Write()
    case = folder / "case-fast" / "postProcessing/coefficients/0"
    case.mkdir(parents=True)
    (case / "coefficient.dat").write_text(
        "# Force coefficients\n# Time Cd Cs Cl CmRoll\n1 0.9 0 0.4 0\n2 0.6 0 0.3 0\n3 0.55 0 0.2 0\n4 0.5"
    )
    storage.save("runs", dict(
        id=key, project_id="b" * 32, name="test", created=storage.now(), status=status, stage="fast: Solving airflow",
        iteration=3, settings=dict(speed_kmh=72.0, density=1.225, reference_area=2.0),
        geometry=dict(parts=[dict(id="part0", name="body", role="body")]),
    ))
    (folder / "geometry").mkdir()
    (folder / "geometry" / "part0.stl").write_bytes(b"\0" * 84)
    return key


def test_live_history_skips_a_half_written_line(client, tmp_path):
    key = saved_run(tmp_path, status="running")
    live = client.get(f"/api/runs/{key}/live").json()
    assert live["status"] == "running" and live["iteration"] == 3 and live["case"] == "case-fast"
    assert [h["iteration"] for h in live["history"]] == [1, 2, 3]
    assert live["history"][-1]["cd"] == 0.55 and live["history"][-1]["cl"] == 0.2


def test_viz_field_samples_the_grid_it_is_asked_for(client, tmp_path):
    key = saved_run(tmp_path)
    body = dict(origin=[-2, -1, 0.5], spacing=[1, 1, 1], dims=[4, 3, 2])
    r = client.post(f"/api/runs/{key}/viz-field", json=body)
    assert r.status_code == 200
    raw = r.content  # the test client decompresses Content-Encoding: gzip
    n = 4 * 3 * 2
    u, v, w, p, k = (np.frombuffer(raw[4 * n * i: 4 * n * (i + 1)], dtype="<f4") for i in range(5))
    valid = np.frombuffer(raw[20 * n:], dtype=np.uint8)
    assert len(valid) == n and valid.all()
    x = -2 + np.arange(n) % 4  # x varies fastest
    assert np.allclose(u, x + 20, atol=1e-4) and np.allclose(p, x, atol=1e-4)
    assert np.allclose(v, 0) and np.allclose(w, 0) and np.allclose(k, 1)
    # Cached: the same request is served from the saved file.
    assert len(list((tmp_path / "runs" / key / "results").glob("vizfield-*.bin.gz"))) == 1
    assert client.post(f"/api/runs/{key}/viz-field", json=body).content == raw


def test_viz_field_rejects_unfinished_runs_and_huge_grids(client, tmp_path):
    key = saved_run(tmp_path, status="running")
    assert client.post(f"/api/runs/{key}/viz-field", json=dict(origin=[0, 0, 0], spacing=[1, 1, 1], dims=[2, 2, 2])).status_code == 400
    storage.update("runs", key, status="completed")
    assert client.post(f"/api/runs/{key}/viz-field", json=dict(origin=[0, 0, 0], spacing=[1, 1, 1], dims=[2000, 2000, 2])).status_code == 400


def test_surface_samples_take_wall_pressure_and_tangential_flow(client, tmp_path):
    key = saved_run(tmp_path)
    # One triangle on the wall plane, normal +z; flow is along +x, so tangential velocity is U.
    tri = np.array([[0.5, 0, 1], [0.6, 0, 1], [0.5, 0.1, 1]], dtype="<f4")
    r = client.post(f"/api/runs/{key}/surface-samples", content=tri.tobytes())
    assert r.status_code == 200
    out = np.frombuffer(r.content, dtype="<f4")
    cp, shear = out[:3], out[3:].reshape(3, 3)
    q = 0.5 * 20.0**2
    assert np.allclose(cp, 2 * tri[:, 0] / q, atol=0.1 / q)
    assert np.allclose(shear[:, 0], tri[:, 0] + 20, atol=0.01) and np.allclose(shear[:, 1:], 0, atol=1e-6)
    assert client.post(f"/api/runs/{key}/surface-samples", content=b"\0" * 10).status_code == 400


def test_run_geometry_is_served_as_stl(client, tmp_path):
    key = saved_run(tmp_path)
    assert client.get(f"/api/runs/{key}/geometry/part0.stl").status_code == 200
    assert client.get(f"/api/runs/{key}/geometry/part9.stl").status_code == 404
