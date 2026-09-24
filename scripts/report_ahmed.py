"""Independent checks of raw solver coefficients and fields against saved/UI assets."""

import json
from pathlib import Path

import numpy as np
import vtk
from vtk.util.numpy_support import vtk_to_numpy

from easycfd import storage

ROOT = storage.ROOT / "reference/nathanrooy-comparison"
OUT = Path("docs/ahmed-validation")


def raw_coefficients(path):
    lines = path.read_text().splitlines()
    header = next(line.lstrip("# ").split() for line in lines if line.startswith("# Time"))
    rows = np.loadtxt(path)
    return {name: rows[:, header.index(name)] for name in ("Cd", "Cl")}


def foam_blocks(case):
    reader = vtk.vtkOpenFOAMReader()
    reader.SetFileName(str(case / "case.foam"))
    reader.EnableAllCellArrays()
    reader.UpdateInformation()
    reader.EnableAllPatchArrays()
    reader.CreateCellToPointOff()
    times = reader.GetTimeValues()
    reader.UpdateTimeStep(times.GetValue(times.GetNumberOfValues() - 1))
    reader.Update()
    found = {}

    def visit(root):
        for i in range(root.GetNumberOfBlocks()):
            block = root.GetBlock(i)
            if block is None:
                continue
            if isinstance(block, vtk.vtkMultiBlockDataSet):
                visit(block)
            else:
                name = root.GetMetaData(i).Get(vtk.vtkCompositeDataSet.NAME())
                copy = block.NewInstance()
                copy.DeepCopy(block)
                found[name] = copy

    visit(reader.GetOutput())
    return found


def read_asset(path, surface=False):
    reader = vtk.vtkXMLPolyDataReader() if surface else vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(path))
    reader.Update()
    return reader.GetOutput()


def check_run(name):
    saved = json.loads((ROOT / f"{name}.json").read_text())
    run = storage.get("runs", saved["id"])
    result = run["result"]
    root = storage.directory("runs", run["id"])
    case = root / f"case-{run['settings']['quality']}"
    raw = raw_coefficients(case / "postProcessing/coefficients/0/coefficient.dat")
    for field, column in (("cd", "Cd"), ("cl", "Cl")):
        np.testing.assert_allclose(result[field], np.mean(raw[column][-50:]), rtol=1e-12)
    settings = run["settings"]
    q_area = 0.5 * settings["density"] * (settings["speed_kmh"] / 3.6) ** 2 * settings["reference_area"]
    np.testing.assert_allclose(result["drag"], result["cd"] * q_area, rtol=1e-12)
    np.testing.assert_allclose(result["downforce"], -result["cl"] * q_area, rtol=1e-12)
    blocks = foam_blocks(case)
    errors = {}
    for block, file, surface in [("internalMesh", "volume.vtu", False), ("part0", "surface.vtp", True)]:
        source = blocks[block].GetCellData()
        asset = read_asset(root / "results" / file, surface).GetCellData()
        for raw_name, asset_name, factor in [("p", "Pressure", settings["density"]), ("k", "Turbulence", 1)]:
            expected = vtk_to_numpy(source.GetArray(raw_name)) * factor
            actual = vtk_to_numpy(asset.GetArray(asset_name))
            np.testing.assert_allclose(actual, expected, rtol=2e-6, atol=1e-6)
            errors[f"{block}_{asset_name}_max_abs_error"] = float(np.max(np.abs(actual - expected)))
        velocity = vtk_to_numpy(source.GetArray("U"))
        np.testing.assert_allclose(
            vtk_to_numpy(asset.GetArray("Speed")), np.linalg.norm(velocity, axis=1), rtol=2e-6, atol=1e-6
        )
        if surface:
            np.testing.assert_allclose(velocity, 0, atol=1e-12)
    return {
        "run_id": run["id"],
        **{
            key: result[key]
            for key in [
                "cd",
                "cl",
                "drag",
                "downforce",
                "cells",
                "iteration",
                "force_settled",
                "residual_converged",
                "cd_span",
                "cl_span",
                "timings",
                "warnings",
            ]
        },
        "field_checks": errors,
    }, blocks


if __name__ == "__main__":
    native, _ = check_run("native")
    matched, blocks = check_run("matched")
    upstream = ROOT / "upstream-coarse"
    raw = raw_coefficients(upstream / "postProcessing/forceCoeffs1/0/coefficient.dat")
    reference = {
        "cd": float(raw["Cd"][-50:].mean()),
        "cl": float(raw["Cl"][-50:].mean()),
        "iterations": len(raw["Cd"]),
    }
    reference["timings"] = json.loads((ROOT / "upstream-timings.json").read_text())
    reference_blocks = foam_blocks(upstream)
    differences = {}
    for source_name, target_name in [("internalMesh", "internalMesh"), ("ahmed_body", "part0")]:
        source = reference_blocks[source_name]
        target = blocks[target_name]
        np.testing.assert_allclose(
            vtk_to_numpy(source.GetPoints().GetData()), vtk_to_numpy(target.GetPoints().GetData()), atol=1e-12
        )
        for name in ["p", "U", "k", "omega"]:
            a = vtk_to_numpy(source.GetCellData().GetArray(name))
            b = vtk_to_numpy(target.GetCellData().GetArray(name))
            differences[f"{target_name}_{name}"] = {
                "max_abs": float(np.max(np.abs(a - b))),
                "relative_l2": float(np.linalg.norm(a - b) / max(np.linalg.norm(a), 1e-12)),
            }
    velocity_a = vtk_to_numpy(reference_blocks["internalMesh"].GetCellData().GetArray("U"))
    velocity_b = vtk_to_numpy(blocks["internalMesh"].GetCellData().GetArray("U"))
    velocity_delta = np.linalg.norm(velocity_a - velocity_b, axis=1)
    local_velocity = {
        "p99_difference_m_s": float(np.quantile(velocity_delta, 0.99)),
        "fraction_cells_difference_over_1_m_s": float(np.mean(velocity_delta > 1)),
        "max_vector_difference_m_s": float(velocity_delta.max()),
        "note": "Largest differences occur near the support legs; the final fields are not identical.",
    }
    report = {
        "upstream_revision": "25677d638b1ae6f1289cb6b70fce666f898ce560",
        "published": {"cd": 0.299, "cl": 0.339, "cells": 8250693},
        "upstream_coarse": reference,
        "native": native,
        "matched": matched,
        "shared_mesh_field_differences": differences,
        "local_velocity_differences": local_velocity,
        "matched_delta_cd": matched["cd"] - reference["cd"],
        "matched_delta_cl": matched["cl"] - reference["cl"],
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "measurements.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
