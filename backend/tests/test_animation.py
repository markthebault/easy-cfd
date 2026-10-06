import json
from fastapi.testclient import TestClient
from easycfd import animation, storage
from easycfd.api import app
from easycfd.models import Settings


def test_transient_continuation_resets_clock_and_preserves_warmup(tmp_path):
    source = tmp_path / "steady"
    for name in ("constant", "system", "300/uniform"):
        (source / name).mkdir(parents=True)
    (source / "300/U").write_bytes(b"immutable computed velocity")
    (source / "300/uniform/time").write_text("value 300; deltaT 1;")
    (source / "system/fvSchemes").write_text("ddtSchemes {default steadyState;} divSchemes {div(phi,U) bounded Gauss linearUpwindV grad(U);}")
    case = tmp_path / "transient"
    plan = animation.prepare(source, case, 4, 20)
    assert plan["duration"] == .6
    assert not (case / "0/uniform/time").exists()
    assert (case / "0/U").read_bytes() == (source / "300/U").read_bytes()
    assert (source / "300/uniform/time").exists()
    control = (case / "system/controlDict").read_text()
    assert "application pimpleFoam" in control
    assert "maxCo 0.5" in control and "purgeWrite 0" in control
    assert "adjustableRunTime" in control
    schemes = (case / "system/fvSchemes").read_text()
    assert "steadyState" not in schemes and "backward" in schemes
    assert "bounded Gauss" not in schemes
    assert not Settings().flow_animation
    assert Settings(flow_animation=True).flow_animation


def test_animation_api_bounds_and_legacy_availability(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    key = "a" * 32
    storage.save("runs", dict(id=key, status="completed"))
    client = TestClient(app)
    assert client.get(f"/api/runs/{key}/animation").status_code == 400
    output = storage.directory("runs", key) / "animation"
    output.mkdir()
    (output / "manifest.json").write_text(json.dumps(dict(frames=[dict(time=0), dict(time=.1)])))
    assert client.get(f"/api/runs/{key}/animation").json()["frames"][1]["time"] == .1
    assert client.get(f"/api/runs/{key}/animation/-1").status_code == 400
    assert client.get(f"/api/runs/{key}/animation/2").status_code == 400
    storage.update("runs", key, status="running")
    assert client.get(f"/api/runs/{key}/animation").status_code == 400
