#!/usr/bin/env python3
"""Ten fresh, matched native solves per mesh; no reference flow is reused."""
import argparse
import hashlib
import json
import math
import random
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from easycfd import foam
from easycfd.models import Settings

ROOT = Path(__file__).resolve().parents[2]
PHYSICAL = ("speed_kmh", "yaw_deg", "reference_area", "density", "moving_ground", "wheels")


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temp.replace(path)


def now():
    return datetime.now(timezone.utc).isoformat()


def initialize(output, model_id):
    manifest = output / "design.json"
    if manifest.exists():
        design = read(manifest)
        if design["model"] != model_id:
            raise RuntimeError("The registered geometry cannot change after initialization")
        return design
    model = next(m for m in read(ROOT / "web/validation/models.json")["models"] if m["id"] == model_id)
    rng = random.Random(20261003)
    yaw_bins = list(range(10))
    rng.shuffle(yaw_bins)
    trials = [{"id": f"pair-{i+1:02d}", "settings": {
        **model["settings"], "speed_kmh": round(model["settings"]["speed_kmh"] * (.95 + .01 * (i + .5)), 4),
        "yaw_deg": round(-2 + .4 * (yaw_bins[i] + .5), 4)}} for i in range(10)]
    settings = read(ROOT / "docs/webgpu-openfoam-algorithm/plan-final.json")[0]["settings"]
    design = {"created": now(), "model": model_id, "seed": 20261003,
        "sampling": "Midpoints of ten equal speed bins across +/-5%, paired with a seeded permutation of ten yaw bins across +/-2 degrees; one fixed geometry",
        "trials": trials, "stages": {
            "small": {"nativeMesh": "fast", "gpuCells": 62500},
            "medium": {"nativeMesh": "medium", "gpuCells": 250000},
            "final": {"nativeMesh": "precise", "gpuCells": 500000}},
        "nativeIterationCheckpoints": [800, 1600, 2400], "nativeAverageIterations": 200,
        "nativeResidualTolerance": 1e-4, "nativeForceSpanTolerance": .01,
        "gpuSourceRevision": "2e3794f0000ae17cc5ab34c722b3e2654564ffa2",
        "gpuSettings": settings, "gpuSolver": {"vcycles": 4, "coarseSweeps": 24, "sstSweeps": 4},
        "gpuPasses": 40, "tolerance": .05,
        "gate": "All ten pairs complete, inputs and domains match, BOTH Cd and Cl errors <=5% for EVERY pair, native mesh passes, native final residuals <=1e-4 and last-200 force spans <1%, GPU finite/unclipped/conserved (relative divergence <=0.001), settled with <=1% mean bands. The final stage requires BOTH small and medium to pass. Mesh independence is reported separately; passing this pilot is not general aerodynamic qualification.",
        "quantiles": "Linear interpolation at (n-1)*p (type 7), including median; paired signed percent difference = 100*(GPU-native)/max(abs(native),0.01)",
        "interpretation": "Changed-input spread measures input sensitivity, not identical-input solver repeatability; native iterative drift is reported separately. No broad Monte Carlo is authorized by this pilot."}
    save(manifest, design)
    for stage, detail in design["stages"].items():
        folder = output / stage
        plan = [{"key": f"{stage}-{t['id']}", "referenceKey": f"{stage}-{t['id']}", "model": model_id,
            "hypothesis": "Preregistered matched input sensitivity comparison; frozen common solver, fresh freestream start",
            "settings": {**settings, **t["settings"], "targetCells": detail["gpuCells"], "custom_passes": 40},
            "solver": design["gpuSolver"], "maxExtension": 1} for t in trials]
        save(folder / "plan.json", plan)
    return design


def run_tool(case, command, log_name):
    started = time.monotonic()
    print(f"{case.name}: {log_name}", flush=True)
    with (case / f"log.{log_name}").open("w") as log:
        result = subprocess.run(["docker", "run", "--rm", "--name", f"easycfd-paired-{case.name}",
            "--network", "none", "--memory", "5g", "--memory-swap", "5g", "--cpus", "4", "--pids-limit", "256",
            "--mount", f"type=bind,source={case},target=/case", "-w", "/case", "--entrypoint", "/bin/bash",
            foam.IMAGE, "-lc", 'exec "$@"', "paired", *command],
            stdout=log, stderr=subprocess.STDOUT, timeout=7200)
    if result.returncode:
        raise RuntimeError(f"{log_name} failed ({result.returncode}): " + (case / f"log.{log_name}").read_text(errors="replace")[-3000:])
    return time.monotonic() - started


def mesh_identity(mesh):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(mesh.iterdir()) if p.is_file()}


def native_evidence(case, log_name, settings, metadata):
    rows = {}
    for file in (case / "postProcessing/coefficients").glob("*/coefficient.dat"):
        lines = file.read_text().splitlines()
        header = next(line.lstrip("# ").split() for line in lines if line.startswith("# Time"))
        for line in lines:
            if line and not line.startswith("#"):
                values = [float(x) for x in line.split()]
                if not all(math.isfinite(x) for x in values):
                    raise RuntimeError("Native coefficients contain non-finite values")
                rows[values[0]] = {"iteration": values[0], "cd": values[header.index("Cd")], "cl": values[header.index("Cl")]}
    history = [rows[t] for t in sorted(rows)]
    if len(history) < 200:
        raise RuntimeError("Not enough native force samples")
    window = history[-200:]
    means = {key: sum(r[key] for r in window) / len(window) for key in ("cd", "cl")}
    spans = {key: max(r[key] for r in window) - min(r[key] for r in window) for key in means}
    splits = {key: [sum(r[key] for r in part) / len(part) for part in (window[:100], window[100:])] for key in means}
    blocks = {key: [sum(r[key] for r in window[i:i+25])/25 for i in range(0, 200, 25)] for key in means}
    standard_deviation = {key: math.sqrt(sum((r[key]-means[key])**2 for r in window)/199) for key in means}
    log = (case / f"log.{log_name}").read_text(errors="replace")
    final = re.split(r"^Time = ", log, flags=re.M)[-1]
    residuals = {}
    for variable, value in re.findall(r"Solving for (\w+), Initial residual = ([\deE.+-]+)", final):
        residuals[variable] = max(residuals.get(variable, 0), float(value))
    residual_converged = all(residuals.get(v, math.inf) <= 1e-4 for v in ("p", "Ux", "Uy", "Uz", "k", "omega"))
    force_settled = all(spans[k] < .01 * max(abs(means[k]), .01) for k in means)
    q_area = .5 * settings["density"] * metadata["freestream"]**2 * settings["reference_area"]
    return {**means, "drag": means["cd"]*q_area, "lift": means["cl"]*q_area,
        "iterations": int(history[-1]["iteration"]), "forceSettled": force_settled,
        "forceSpans": spans, "forceWindowStd": standard_deviation, "forceWindowSplitMeans": splits,
        "forceWindowBlockMeans": blocks, "residualConverged": residual_converged, "residuals": residuals,
        "averagingIterations": 200, "history": history[::10], "lastWindow": window}


def run_stage(output, design, stage):
    if stage == "final":
        gates = read(output / "statistics.json")["stages"]
        if not all(gates[s]["passed"] for s in ("small", "medium")):
            raise RuntimeError("Final stage is conditional on both smaller stages passing")
    stage_output = output / stage
    stage_output.mkdir(parents=True, exist_ok=True)
    base = ROOT / ".accuracy-reference/paired-inputs" / design["model"] / stage
    base.mkdir(parents=True, exist_ok=True)
    model = next(m for m in read(ROOT / "web/validation/models.json")["models"] if m["id"] == design["model"])
    source = ROOT / ".easycfd/runs" / model["geometryRun"]
    geometry = read(source / "record.json")["geometry"]
    detail = design["stages"][stage]
    mesh_case = base / "mesh"
    mesh_record = stage_output / "mesh.json"
    if not mesh_record.exists():
        if mesh_case.exists():
            raise RuntimeError("Incomplete mesh remains; inspect its logs before resuming")
        metadata = foam.generate(mesh_case, source / "geometry", geometry,
            Settings(**model["settings"], quality="custom", custom_mesh=detail["nativeMesh"], custom_iterations=800))
        timings = {}
        for command in (["blockMesh"], ["snappyHexMesh", "-overwrite"], ["checkMesh", "-allTopology"]):
            timings[command[0]] = run_tool(mesh_case, command, command[0])
        text = (mesh_case / "log.checkMesh").read_text()
        cells = int(re.search(r"^\s*cells:\s+(\d+)", text, re.M)[1])
        if "Mesh OK." not in text:
            raise RuntimeError("Native mesh did not pass checkMesh")
        save(mesh_record, {"cells": cells, "meshPassed": True, "metadata": metadata, "image": foam.IMAGE,
            "case": str(mesh_case), "meshHashes": mesh_identity(mesh_case / "constant/polyMesh"), "timings": timings,
            "note": "Mesh built once at baseline speed; reused unchanged for all ten perturbed-input solves, including baseline prism-layer thickness."})
    mesh = read(mesh_record)
    refs_file = stage_output / "references.json"
    refs = read(refs_file) if refs_file.exists() else {}
    for trial in design["trials"]:
        key = f"{stage}-{trial['id']}"
        evidence_file = stage_output / "native" / f"{trial['id']}.json"
        if evidence_file.exists():
            if read(evidence_file)["status"] in ("completed", "failed"):
                continue
            raise RuntimeError(f"Unfinished {key}; inspect before retrying")
        case = base / trial["id"]
        if case.exists():
            raise RuntimeError(f"Case already exists without evidence: {case}")
        record = {"key": key, "settings": trial["settings"], "case": str(case), "status": "running", "started": now()}
        save(evidence_file, record)
        started = time.monotonic()
        try:
            metadata = foam.generate(case, source / "geometry", geometry,
                Settings(**trial["settings"], quality="custom", custom_mesh=detail["nativeMesh"], custom_iterations=800))
            shutil.copytree(mesh_case / "constant/polyMesh", case / "constant/polyMesh")
            part_hashes = {p["file"]: hashlib.sha256((case / "constant/triSurface" / p["file"]).read_bytes()).hexdigest() for p in model["parts"]}
            if any(hashlib.sha256((source / "geometry" / name).read_bytes()).hexdigest() != digest for name, digest in part_hashes.items()):
                raise RuntimeError("Native STL differs from paired geometry")
            if any(part.get("wheel") != next(p for p in geometry["parts"] if p["id"] == Path(part["file"]).stem).get("wheel") for part in model["parts"]):
                raise RuntimeError("Wheel metadata differs")
            control = case / "system/controlDict"
            control.write_text(re.sub(r"writeInterval\s+800;", "writeInterval 800;", control.read_text(), count=1))
            timings = {"decomposePar": run_tool(case, ["decomposePar", "-force"], "decomposePar")}
            checkpoints = []
            for end in design["nativeIterationCheckpoints"]:
                content = re.sub(r"endTime\s+\d+;", f"endTime {end};", control.read_text())
                if end > 800:
                    content = content.replace("startFrom startTime;", "startFrom latestTime;")
                control.write_text(content)
                label = f"simpleFoam-{end}"
                timings[label] = run_tool(case, ["mpirun", "--allow-run-as-root", "-np", "4", "simpleFoam", "-parallel"], label)
                evidence = native_evidence(case, label, trial["settings"], metadata)
                checkpoints.append({k: v for k, v in evidence.items() if k not in ("history", "lastWindow")})
                save(evidence_file, {**record, "checkpoints": checkpoints, "timings": timings})
                print(f"  {key} at {end}: Cd={evidence['cd']:.6f} Cl={evidence['cl']:.6f} forces={evidence['forceSettled']} residuals={evidence['residualConverged']}", flush=True)
                if evidence["forceSettled"] and evidence["residualConverged"]:
                    break
            timings["reconstructPar"] = run_tool(case, ["reconstructPar", "-newTimes"], "reconstructPar")
            record.update(evidence)
            record.update(status="completed", settingsMatch=True, cells=mesh["cells"], meshPassed=mesh["meshPassed"],
                meshIndependent=False, meshHashes=mesh["meshHashes"], domain=metadata["domain"],
                freestream=metadata["freestream"], geometryFingerprint=geometry["fingerprint"], partHashes=part_hashes,
                image=foam.IMAGE, checkpoints=checkpoints, timings=timings,
                dictionaryHashes={str(p.relative_to(case)): hashlib.sha256(p.read_bytes()).hexdigest() for folder in ("system", "0") for p in (case / folder).glob("*") if p.is_file()})
            refs[key] = {k: v for k, v in record.items() if k not in ("history", "lastWindow", "checkpoints", "meshHashes")}
            save(refs_file, refs)
        except Exception as error:
            record.update(status="failed", error=str(error))
            print(f"FAILED {key}: {error}", flush=True)
        finally:
            record.update(finished=now(), wallSeconds=time.monotonic()-started)
            save(evidence_file, record)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/webgpu-paired-inputs")
    parser.add_argument("--model", default="sample", choices=("sample", "ahmed25", "mx5"))
    parser.add_argument("--stage", choices=("small", "medium", "final"))
    args = parser.parse_args()
    output = ROOT / args.output
    design = initialize(output, args.model)
    if args.stage:
        run_stage(output, design, args.stage)


if __name__ == "__main__":
    main()
