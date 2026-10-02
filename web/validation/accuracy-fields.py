#!/usr/bin/env python3
"""Compare final native fields at identical wake points; no rendered/image fields."""
import argparse
import json
from pathlib import Path

import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

from easycfd.results import named_blocks

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/webgpu-accuracy"


def source_field(reference):
    case = Path(reference["case"]) if "case" in reference else ROOT / ".easycfd/runs" / reference["run"] / f"case-{reference['quality']}"
    reader = vtk.vtkOpenFOAMReader()
    reader.SetFileName(str(case / "case.foam"))
    reader.EnableAllCellArrays()
    reader.UpdateInformation()
    reader.EnableAllPatchArrays()
    times = reader.GetTimeValues()
    last = times.GetValue(times.GetNumberOfValues() - 1)
    reader.UpdateTimeStep(last)
    reader.Update()
    volume = next(block for name, block in named_blocks(reader.GetOutput()) if name == "internalMesh")
    convert = vtk.vtkCellDataToPointData()
    convert.SetInputData(volume)
    convert.PassCellDataOn()
    convert.Update()
    return convert.GetOutput(), last


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-iteration", type=int, default=92)
    parser.add_argument("--output", default="docs/webgpu-accuracy")
    args = parser.parse_args()
    evidence = ROOT / args.output
    references = json.loads((evidence / "references.json").read_text())
    cache, comparisons = {}, []
    for file in sorted((evidence / "iterations").glob("*.json")):
        record = json.loads(file.read_text())
        if record["iteration"] < args.from_iteration or record["status"] != "completed":
            continue
        reference = references.get(record["model"])
        points = record["result"].get("probes")
        if not points or not reference or not reference.get("settingsMatch"):
            continue
        if record["model"] not in cache:
            cache[record["model"]] = source_field(reference)
        source, iteration = cache[record["model"]]
        xyz = np.array([row["position"] for row in points], dtype=np.float64)
        locations = vtk.vtkPoints()
        locations.SetData(numpy_to_vtk(xyz, deep=True))
        input_points = vtk.vtkPolyData()
        input_points.SetPoints(locations)
        probe = vtk.vtkProbeFilter()
        probe.SetInputData(input_points)
        probe.SetSourceData(source)
        probe.Update()
        data = probe.GetOutput().GetPointData()
        native_valid = vtk_to_numpy(data.GetArray("vtkValidPointMask")) > 0
        valid = native_valid & np.array([row["valid"] for row in points])
        u = vtk_to_numpy(data.GetArray("U"))
        p = vtk_to_numpy(data.GetArray("p"))
        gpu_u = np.array([row["velocity"] for row in points])
        gpu_p = np.array([row["pressure"] for row in points])
        speed = record["result"]["freestream"]
        u_error = float(np.sqrt(np.sum((gpu_u[valid]-u[valid])**2) / np.sum(u[valid]**2)))
        cp_rms = float(np.sqrt(np.mean((2*(gpu_p[valid]-p[valid])/speed**2)**2)))
        comparisons.append({"iteration": record["iteration"], "model": record["model"], "referenceIteration": iteration, "points": len(points), "validPoints": int(np.sum(valid)), "velocityRelativeL2": u_error, "pressureCpRms": cp_rms, "referenceQualified": reference.get("forceSettled") and reference.get("residualConverged") and reference.get("meshIndependent"), "samples": [{"position": list(xyz[n]), "valid": bool(valid[n]), "openfoamVelocity": list(u[n].astype(float)), "webgpuVelocity": list(gpu_u[n]), "openfoamPressure": float(p[n]), "webgpuPressure": float(gpu_p[n])} for n in range(len(points))]})
        print(f"{record['model']}: {int(np.sum(valid))}/{len(points)} wake points, velocity L2 error {100*u_error:.2f}%, Cp RMS {cp_rms:.4f}", flush=True)
    (evidence / "field-comparisons.json").write_text(json.dumps(comparisons, indent=2)+"\n")


if __name__ == "__main__":
    main()
