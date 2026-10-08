import numpy as np
import pytest
from easycfd.aerodynamics import integrals, stress_factor
from easycfd.models import Settings
from easycfd import foam


def test_stress_dimensions_sign_and_density(tmp_path):
    folder = tmp_path / "100"
    folder.mkdir()
    file = folder / "wallShearStress"
    for dimensions, expected in [("0 2 -2 0 0 0 0", -1.225), ("1 -1 -2 0 0 0 0", -1)]:
        file.write_text(f"dimensions [{dimensions}];")
        assert stress_factor(tmp_path, 100, 1.225) == expected
    file.write_text("dimensions [0 1 -1 0 0 0 0];")
    with pytest.raises(RuntimeError, match="dimensions"):
        stress_factor(tmp_path, 100, 1.225)


def test_component_force_and_moment_use_identical_window(tmp_path):
    for name, mult in [("forcesTotal", 3), ("forces_part0", 1), ("forces_part1", 2)]:
        folder = tmp_path / "postProcessing" / name / "0"
        folder.mkdir(parents=True)
        for kind in ["force", "moment"]:
            rows = [
                "# Time total_x total_y total_z pressure_x pressure_y pressure_z viscous_x viscous_y viscous_z"
            ]
            for t in range(1, 5):
                p = np.array([t, -t, -2 * t]) * mult
                v = np.array([0.5 * t, 0.1 * t, -0.2 * t]) * mult
                rows.append(" ".join(map(str, [t, *(p + v), *p, *v])))
            (folder / f"{kind}.dat").write_text("\n".join(rows))
    run = {
        "settings": {"moment_origin": [-1, 0, 0]},
        "geometry": {"parts": [{"id": "part0", "name": "body"}, {"id": "part1", "name": "wing"}]},
    }
    r = integrals(tmp_path, run, [3.0, 4.0])
    assert r["reconciliation"]["complete"]
    assert np.allclose(r["aero"]["force"], [15.75, -9.45, -23.1])
    assert r["provenance"]["averaging"] == {"start": 3.0, "end": 4.0, "unit": "iteration"}
    (tmp_path / "postProcessing/forces_part1/0/moment.dat").unlink()
    with pytest.raises(RuntimeError, match="missing samples"):
        integrals(tmp_path, run, [3.0, 4.0])


def test_dictionary_records_origin_and_part_stress(tmp_path):
    # Use the existing sample geometry builder, without running a solver.
    from easycfd import geometry

    geom = geometry.sample(tmp_path / "geometry", wing=True)
    foam.generate(tmp_path / "case", tmp_path / "geometry", geom, Settings(moment_origin=(-1, 0.1, 0)))
    text = (tmp_path / "case/system/controlDict").read_text()
    assert "CofR (-1.0 0.1 0.0)" in text
    assert "forcesTotal" in text and "wallShearStress" in text
    for p in geom["parts"]:
        assert f"forces_{p['id']}" in text


def test_balance_drift_is_separate_from_stable_total_lift():
    from easycfd.aerodynamics import balance_diagnostics

    history = [dict(iteration=t, force=[100, 0, -100], moment=[0, 20 * t, 0]) for t in range(1, 9)]
    checks = balance_diagnostics(history, list(range(1, 9)), dict(frontX=-1, rearX=2, confirmed=True))
    assert checks["balance_settled"] is False
    assert checks["balance_bands"]["frontLift"] > 0
    assert checks["balance_bands"]["rearLift"] > 0
    assert checks["balance_bands"]["pitch"] == 70
    for h in history:
        h["moment"][1] = 90
    stable = balance_diagnostics(history, list(range(1, 9)), dict(frontX=-1, rearX=2, confirmed=True))
    assert stable["balance_settled"] is True
    assert all(v == 0 for v in stable["balance_bands"].values())


def test_profile_runtime_cannot_bypass_shared_ceiling():
    for profile, seconds in [("basic", 300), ("regular", 1200), ("advanced1", 10800), ("advanced2", 43200)]:
        assert Settings(profile=profile, max_seconds=seconds).max_seconds == seconds
        with pytest.raises(ValueError):
            Settings(profile=profile, max_seconds=seconds + 1)
    assert Settings(quality="precise").profile is None


def test_compute_lease_serializes_server_and_browser(monkeypatch):
    from easycfd import compute_lease as lease
    from fastapi import HTTPException

    monkeypatch.setattr(lease, "OWNER", None)
    monkeypatch.setattr(lease, "UNTIL", 0)
    monkeypatch.setattr(lease, "SERVER_JOB", None)
    lease.acquire(lease.Lease(owner="browser1"))
    assert not lease.start_server("native")
    with pytest.raises(HTTPException):
        lease.acquire(lease.Lease(owner="browser2"))
    lease.release("browser1")
    assert lease.start_server("native")
    with pytest.raises(HTTPException):
        lease.acquire(lease.Lease(owner="browser1"))
    lease.finish_server()
    lease.acquire(lease.Lease(owner="browser2"))


def test_equivalent_loads_from_force_and_road_plane_moment():
    from easycfd.aerodynamics import equivalent_loads

    axles = dict(frontX=-1, rearX=2, centrelineY=0, confirmed=True)
    for point, force, expected in [
        ([-1, 0, 0], [0, 0, -90], [-90, 0]),
        ([2, 0, 0], [0, 0, -90], [0, -90]),
        ([0.5, 0, 0], [0, 0, -90], [-45, -45]),
        ([0.5, 0, 1], [90, 0, 0], [30, -30]),
    ]:
        moment = np.cross(np.array(point) - [-1, 0, 0], force)
        result = equivalent_loads(force, moment, axles, 450)
        assert np.allclose([result["frontLift"], result["rearLift"]], expected)
        assert np.isclose(result["frontCl"] + result["rearCl"], force[2] / 450)
    assert equivalent_loads([0, 0, 0], [0, 90, 0], axles, 450).get("frontDownforcePercent") is None
    assert equivalent_loads([0, 0, -90], [0, 135, 0], axles, 450)["frontDownforcePercent"] == 50


def test_tyre_support_loads_add_downforce_and_remove_lift():
    from easycfd.aerodynamics import tyre_loads

    settings = dict(vehicle_mass_kg=1200, front_weight_percent=55)
    for front_lift, rear_lift in [(0, 0), (-120, -300), (120, -300)]:
        loads = tyre_loads(dict(frontLift=front_lift, rearLift=rear_lift), settings)
        assert loads["front"]["staticN"] == pytest.approx(1200 * 9.80665 * 0.55)
        assert loads["rear"]["staticN"] == pytest.approx(1200 * 9.80665 * 0.45)
        assert loads["front"]["aerodynamicN"] == -front_lift
        assert loads["rear"]["aerodynamicN"] == -rear_lift
        assert loads["front"]["totalN"] + loads["rear"]["totalN"] == pytest.approx(
            1200 * 9.80665 - front_lift - rear_lift
        )
        assert loads["contactFeasible"] is True
    loads = tyre_loads(dict(frontLift=7000, rearLift=0), settings)
    assert loads["front"]["totalN"] < 0
    assert loads["contactFeasible"] is False


def test_tyre_loads_require_weight_and_valid_axle_balance():
    from easycfd.aerodynamics import tyre_loads

    balance = dict(frontLift=0, rearLift=0)
    weight = dict(vehicle_mass_kg=1200, front_weight_percent=55)
    assert tyre_loads(None, weight) is None
    assert tyre_loads(balance, {}) is None
    assert tyre_loads(balance, dict(vehicle_mass_kg=1200)) is None
    assert tyre_loads(balance, dict(front_weight_percent=55)) is None
    assert tyre_loads(dict(frontLift=float("nan"), rearLift=0), weight) is None
    for field, invalid in [
        ("vehicle_mass_kg", 0),
        ("vehicle_mass_kg", -1),
        ("vehicle_mass_kg", 10001),
        ("vehicle_mass_kg", float("inf")),
        ("front_weight_percent", -1),
        ("front_weight_percent", 101),
        ("front_weight_percent", float("nan")),
    ]:
        assert tyre_loads(balance, {**weight, field: invalid}) is None
        with pytest.raises(ValueError):
            Settings(**{field: invalid})
    for percent in [0, 100]:
        assert tyre_loads(balance, {**weight, "front_weight_percent": percent}) is not None


def test_detected_wheel_axles_reject_ambiguous_or_inactive_parts():
    from easycfd.aerodynamics import detected_axles

    parts = [
        dict(role="wheel", wheel=dict(center=[x, y, 0.3], radius=0.3))
        for x, y in [(-1, -0.7), (-1, 0.7), (2, -0.7), (2, 0.7)]
    ]
    assert detected_axles(parts) == dict(frontX=-1, rearX=2, centrelineY=0, confirmed=True, source="wheels")
    assert detected_axles(parts[:3]) is None
    assert detected_axles([*parts, parts[0]]) is None
    assert detected_axles([{**p, "enabled": False} if i == 0 else p for i, p in enumerate(parts)]) is None
    assert (
        detected_axles(
            [{**p, "wheel": {**p["wheel"], "center": [p["wheel"]["center"][0], 0, 0.3]}} for p in parts]
        )
        is None
    )


def test_saved_native_moments_and_history_transfer_to_front_axle():
    from easycfd.aerodynamics import equivalent_loads, balance_diagnostics

    axles = dict(frontX=-1, rearX=2, centrelineY=0, confirmed=True)
    force = [80, 12, -90]
    point, origin = np.array([0.5, 0.2, 1]), np.array([7, -3, 2])
    stored = np.cross(point - origin, force).tolist()
    expected = equivalent_loads(force, np.cross(point - [-1, 0, 0], force), axles, 450)
    actual = equivalent_loads(force, stored, axles, 450, origin)
    assert actual == expected
    history = [dict(iteration=t, force=force, moment=stored) for t in range(1, 5)]
    checks = balance_diagnostics(history, [1, 2, 3, 4], axles, origin)
    assert checks["balance_settled"] is True
    assert all(v == 0 for v in checks["balance_bands"].values())
