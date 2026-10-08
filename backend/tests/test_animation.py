import json
import pytest
from fastapi.testclient import TestClient
from easycfd import animation, storage
from easycfd.api import app
from easycfd.models import Settings, profile_time_limit


def test_transient_continuation_resets_clock_and_preserves_warmup(tmp_path):
    source = tmp_path / "steady"
    for name in ("constant", "system", "300/uniform"):
        (source / name).mkdir(parents=True)
    (source / "300/U").write_bytes(b"immutable computed velocity")
    (source / "300/uniform/time").write_text("value 300; deltaT 1;")
    (source / "system/fvSchemes").write_text("ddtSchemes {default steadyState;} divSchemes {div(phi,U) bounded Gauss linearUpwindV grad(U);}")
    case = tmp_path / "transient"
    plan = animation.prepare(source, case, 4, 20)
    assert plan["duration"] == 2.4
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


def test_recording_profile_time_budget_and_explicit_limit():
    assert profile_time_limit("basic") == 300
    assert profile_time_limit("basic", True) == 600
    assert profile_time_limit("regular", True) == 1200
    assert profile_time_limit("advanced2", True) == 43200
    assert Settings(profile="basic", flow_animation=True, max_seconds=120).max_seconds == 120
    assert Settings(profile="basic", flow_animation=True, max_seconds=600).max_seconds == 600
    with pytest.raises(ValueError, match="at most 600"):
        Settings(profile="basic", flow_animation=True, max_seconds=601)
    with pytest.raises(ValueError, match="at most 300"):
        Settings(profile="basic", max_seconds=600)


def test_medium_budget_includes_recording_and_legacy_settings():
    assert profile_time_limit("regular") == 1200
    for recording in (False, True):
        for profile in (None, "regular"):
            assert Settings(profile=profile, quality="medium", flow_animation=recording, max_seconds=1200)
            with pytest.raises(ValueError, match="at most 1200"):
                Settings(profile=profile, quality="medium", flow_animation=recording, max_seconds=1201)
    assert Settings(profile="advanced1", max_seconds=10800)
    assert Settings(flow_animation=True, flow_detail="fine", max_seconds=43200)


def test_medium_profile_cannot_inherit_an_expensive_custom_or_precise_preset():
    from easycfd.models import PRESETS, resolved_preset

    for quality in ("custom", "precise", "fast"):
        settings = Settings(profile="regular", quality=quality, custom_mesh="precise", custom_iterations=20000)
        assert settings.quality == "medium"
        assert resolved_preset(settings) == PRESETS["medium"]
        assert resolved_preset(settings, "precise") == PRESETS["medium"]
    with pytest.raises(ValueError, match="single-mesh"):
        Settings(profile="regular", flow_animation=True, flow_detail="fine", max_seconds=43200)


def test_medium_deadline_is_checked_during_every_job_stage(tmp_path, monkeypatch):
    from easycfd import runner, storage

    monkeypatch.setattr(storage, "ROOT", tmp_path)
    key = "f" * 32
    storage.save("runs", dict(id=key, status="running"))
    monkeypatch.setattr(runner, "DEADLINES", {key:1200})
    monkeypatch.setattr(runner.time, "monotonic", lambda:1199.9)
    runner.check_cancelled(key)
    monkeypatch.setattr(runner.time, "monotonic", lambda:1200.1)
    with pytest.raises(TimeoutError, match="Whole-job"):
        runner.check_cancelled(key)
