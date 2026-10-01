#!/usr/bin/env python3
"""Independent final-state integration on native car wall polygons, never display STL triangles."""

import json
from pathlib import Path
import numpy as np
import vtk
from vtk.util.numpy_support import vtk_to_numpy

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / "docs/aerodynamic-analysis/native-state"


def main():
    run = json.loads((FOLDER.parent / "openfoam-run-final.json").read_text())
    origin = np.array(run["result"]["aero"]["origin"])
    force = np.zeros(3)
    moment = np.zeros(3)
    friction = np.zeros(3)
    force_magnitudes = 0
    moment_magnitudes = 0
    faces = 0
    for file in sorted(FOLDER.glob("part*.vtp")):
        reader = vtk.vtkXMLPolyDataReader()
        reader.SetFileName(str(file))
        reader.Update()
        poly = reader.GetOutput()
        cell = poly.GetCellData()
        tau = vtk_to_numpy(cell.GetArray("WallStressPa"))
        pressure = vtk_to_numpy(cell.GetArray("p")) * run["settings"]["density"]
        sizes = vtk.vtkCellSizeFilter()
        sizes.SetInputData(poly)
        sizes.ComputeAreaOn()
        sizes.Update()
        area = vtk_to_numpy(sizes.GetOutput().GetCellData().GetArray("Area"))
        normals = vtk.vtkPolyDataNormals()
        normals.SetInputData(poly)
        normals.ComputeCellNormalsOn()
        normals.ComputePointNormalsOff()
        normals.ConsistencyOff()
        normals.AutoOrientNormalsOff()
        normals.Update()
        n = vtk_to_numpy(normals.GetOutput().GetCellData().GetNormals())
        centres = vtk.vtkCellCenters()
        centres.SetInputData(poly)
        centres.Update()
        xyz = vtk_to_numpy(centres.GetOutput().GetPoints().GetData())
        traction = tau + pressure[:, None] * n
        f = traction * area[:, None]
        m = np.cross(xyz - origin, f)
        assert np.isfinite(f).all() and np.isfinite(m).all()
        force += f.sum(axis=0)
        moment += m.sum(axis=0)
        friction += (tau * area[:, None]).sum(axis=0)
        force_magnitudes += np.linalg.norm(f, axis=1).sum()
        moment_magnitudes += np.linalg.norm(m, axis=1).sum()
        faces += len(f)
    def rows(name):
        return np.loadtxt(FOLDER / "forcesTotal" / name)[-1]
    error_f = float(np.linalg.norm(force - rows("force.dat")[1:4]))
    error_m = float(np.linalg.norm(moment - rows("moment.dat")[1:4]))
    tolerance_f = max(1e-4, 0.005 * float(force_magnitudes))
    tolerance_m = max(1e-4, 0.005 * float(moment_magnitudes))
    evidence = {
        "scope": "Final solver state, not the averaging window",
        "faces": faces,
        "coverage": 1,
        "origin": origin.tolist(),
        "force": force.tolist(),
        "moment": moment.tolist(),
        "friction": friction.tolist(),
        "forceError": error_f,
        "forceTolerance": tolerance_f,
        "momentError": error_m,
        "momentTolerance": tolerance_m,
        "passed": error_f <= tolerance_f and error_m <= tolerance_m,
    }
    (FOLDER.parent / "independent-native-integration.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
    if not evidence["passed"]:
        raise RuntimeError("Native traction integration does not reconcile; evidence retained.")


if __name__ == "__main__":
    main()
