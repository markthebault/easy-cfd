import pytest
import numpy as np
import trimesh
from easycfd import foam, geometry
from easycfd.models import Settings, PRESETS, resolved_preset


def test_import_test_is_lighter_and_writes_before_solver_budget_ends(tmp_path):
    settings = Settings(import_test=True, geometry_confirmed=True)
    preset = resolved_preset(settings)
    assert preset["iterations"] == 50 < PRESETS["fast"]["iterations"]
    assert preset["cell"] > PRESETS["fast"]["cell"]
    assert preset["surface"] < PRESETS["fast"]["surface"]
    assert preset["layers"] == 0
    assert settings.max_seconds == 180
    source = tmp_path / "geometry"
    data = geometry.sample(source)
    case = tmp_path / "case"
    foam.generate(case, source, data, settings)
    control = (case / "system/controlDict").read_text()
    assert "endTime 50;" in control
    assert "writeControl timeStep; writeInterval 10;" in control


@pytest.mark.parametrize("patch", [{"flow_animation": True}, {"profile": "advanced1"}, {"max_seconds": 181}])
def test_import_test_rejects_conflicting_modes_and_long_budgets(patch):
    with pytest.raises(ValueError):
        Settings(import_test=True, **patch)


def test_planar_original_panel_does_not_request_infinite_thickness_refinement(tmp_path):
    mesh = trimesh.Trimesh(vertices=[[-2,-1,1],[2,-1,1],[2,1,1],[-2,1,1],[0,0,1]], faces=[[0,1,4],[1,2,4],[2,3,4],[3,0,4]], process=False)
    source = tmp_path / "geometry"
    source.mkdir()
    data = geometry.persist_parts(source, [("Original panel", mesh, "body", None)])
    assert not data["errors"]
    assert np.array_equal(mesh.vertices[:,2], np.ones(5))
    case = tmp_path / "case"
    foam.generate(case, source, data, Settings(import_test=True, geometry_confirmed=True))
    assert "part0 {level (1 1);" in (case / "system/snappyHexMeshDict").read_text()


def test_import_check_preserves_tiny_solid_and_records_underresolution(tmp_path):
    source = tmp_path / "geometry"
    source.mkdir()
    badge = trimesh.creation.box(extents=[.15,.04,.001])
    badge.apply_translation([0,0,.0055])
    data = geometry.persist_parts(source, [("Original badge", badge, "body", None)])
    case = tmp_path / "case"
    metadata = foam.generate(case, source, data, Settings(import_test=True, geometry_confirmed=True))
    assert data["parts"][0]["triangles"] == 12
    assert metadata["local_refinement"]["part0"]["underresolved"]
    assert metadata["local_refinement"]["part0"]["surface_level"] == 3
