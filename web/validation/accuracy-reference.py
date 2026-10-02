#!/usr/bin/env python3
"""Fresh force/convergence evidence on copied or newly refined native OpenFOAM cases.

Original runs and fields remain intact. Large solver files stay outside the tracked report.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

from easycfd import foam, results
from easycfd.models import Settings

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/webgpu-accuracy"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default="sample,mx5,ahmed25")
    parser.add_argument("--iterations", type=int, default=3000)
    parser.add_argument("--refine", action="store_true")
    parser.add_argument("--resume", action="store_true", help="Reuse a mesh after a recorded setup failure")
    args = parser.parse_args()
    models = json.loads((ROOT / "web/validation/models.json").read_text())["models"]
    for model in models:
        if model["id"] not in args.models.split(","):
            continue
        refs = json.loads((EVIDENCE / "references.json").read_text())
        existing = refs[model["id"]]
        source = ROOT / ".easycfd/runs" / existing["run"]
        record = json.loads((source / "record.json").read_text())
        label = model["id"] + ("-refined" if args.refine else "-continued")
        case = ROOT / ".accuracy-reference" / label
        if case.exists() and not args.resume:
            raise RuntimeError(f"{case} already exists; use its saved evidence rather than overwriting it")
        if args.resume and (EVIDENCE / f"reference-{label}.json").exists():
            raise RuntimeError("This reference already completed; its saved result must not be overwritten")
        started = time.monotonic()
        if args.refine:
            settings = Settings(**{**record["settings"], "quality": "custom", "custom_mesh": "precise", "custom_iterations": args.iterations, "geometry_confirmed": True})
            metadata = foam.generate(case, source / "geometry", record["geometry"], settings, processes=4)
            (case / "metadata.json").write_text(json.dumps(metadata, indent=2))
            commands = ([] if args.resume else [["blockMesh"], ["snappyHexMesh", "-overwrite"]]) + [["checkMesh", "-allTopology"], ["decomposePar", "-force"], ["mpirun", "--allow-run-as-root", "-np", "4", "simpleFoam", "-parallel"], ["reconstructPar", "-newTimes"]]
        else:
            level = existing["quality"]
            shutil.copytree(source / f"case-{level}", case, ignore=shutil.ignore_patterns("processor*", "postProcessing", "log.*"))
            metadata = json.loads((case / "metadata.json").read_text())
            control = case / "system/controlDict"
            content = re.sub(r"startFrom\s+\w+;", "startFrom latestTime;", control.read_text())
            content = re.sub(r"endTime\s+[\d.eE+-]+;", f"endTime {args.iterations};", content)
            content = re.sub(r"writeInterval\s+\d+;", "writeInterval 500;", content, count=1)
            control.write_text(content)
            commands = [["checkMesh", "-allTopology"], ["decomposePar", "-force", "-latestTime"], ["mpirun", "--allow-run-as-root", "-np", "4", "simpleFoam", "-parallel"], ["reconstructPar", "-newTimes"]]
        timings = {}
        for command in commands:
            tool = "simpleFoam" if "simpleFoam" in command else "potentialFoam" if "potentialFoam" in command else command[0]
            print(f"{label}: {tool}", flush=True)
            t0 = time.monotonic()
            with (case / f"log.{tool}").open("w") as log:
                completed = subprocess.run(["docker", "run", "--rm", "--name", f"easycfd-accuracy-{label}", "--network", "none", "--memory", "5g", "--memory-swap", "5g", "--cpus", "4", "--pids-limit", "256", "--mount", f"type=bind,source={case},target=/case", "-w", "/case", "--entrypoint", "/bin/bash", foam.IMAGE, "-lc", 'exec "$@"', "accuracy", *command], stdout=log, stderr=subprocess.STDOUT, timeout=7200)
            timings[tool] = time.monotonic() - t0
            if completed.returncode:
                failure = {"model": model["id"], "case": str(case), "stage": tool, "returncode": completed.returncode, "timings": timings, "tail": (case / f"log.{tool}").read_text(errors="replace")[-4000:]}
                (EVIDENCE / f"reference-{label}-failure.json").write_text(json.dumps(failure, indent=2))
                raise RuntimeError(f"{label}: {tool} failed; saved log remains in {case}")
        settings = {**record["settings"], **model["settings"]}
        coefficients = results.coefficients(case, settings, metadata["freestream"])
        # A broad end window catches slower force drift that a last-50-only test can miss.
        history = coefficients.pop("history")
        window = history[-min(200, len(history)):]
        means = {key: sum(row[key] for row in window) / len(window) for key in ("cd", "cl")}
        spans = {key: max(row[key] for row in window) - min(row[key] for row in window) for key in means}
        log = (case / "log.simpleFoam").read_text(errors="replace")
        final = re.split(r"^Time = ", log, flags=re.M)[-1]
        residuals = {}
        for variable, value in re.findall(r"Solving for (\w+), Initial residual = ([\deE.+-]+)", final):
            residuals[variable] = max(residuals.get(variable, 0), float(value))
        residual_converged = all(residuals.get(v, float("inf")) <= 1e-4 for v in ("p", "Ux", "Uy", "Uz", "k", "omega"))
        mesh_log = (case / "log.checkMesh").read_text(errors="replace")
        cells_match = re.search(r"^\s*cells:\s+(\d+)", mesh_log, re.M)
        force_settled = len(window) >= 100 and all(spans[k] < 0.01 * max(abs(means[k]), .01) for k in means)
        dictionaries = {str(p.relative_to(case)): hashlib.sha256(p.read_bytes()).hexdigest() for folder in ("system", "constant") for p in (case / folder).glob("*") if p.is_file()}
        fresh = {"run": existing["run"], "quality": "precise" if args.refine else existing["quality"], "case": str(case), **means, "cells": int(cells_match[1]) if cells_match else None, "settings": model["settings"], "settingsMatch": existing["settingsMatch"], "forceSettled": force_settled, "forceSpans": spans, "averagingIterations": len(window), "residualConverged": residual_converged, "residuals": residuals, "meshPassed": "Mesh OK." in mesh_log, "meshIndependent": False, "image": foam.IMAGE, "dictionaryHashes": dictionaries, "timings": timings, "wallSeconds": time.monotonic() - started, "history": history, "geometryFingerprint": record["geometry"]["fingerprint"], "status": "fresh native result; mesh independence pending"}
        if args.refine:
            previous = EVIDENCE / f"reference-{model['id']}-continued.json"
            if previous.exists():
                coarse = json.loads(previous.read_text())
                changes = {key: abs(fresh[key]-coarse[key])/max(abs(fresh[key]),.01) for key in means}
                fresh["meshChanges"] = changes
                fresh["meshIndependent"] = all(value <= .01 for value in changes.values()) and coarse["forceSettled"] and coarse["residualConverged"]
        (EVIDENCE / f"reference-{label}.json").write_text(json.dumps(fresh, indent=2)+"\n")
        # Other reference cases can finish while this one is running.
        refs = json.loads((EVIDENCE / "references.json").read_text())
        refs[model["id"]] = {key: value for key, value in fresh.items() if key != "history"}
        temporary = EVIDENCE / "references.json.tmp"
        temporary.write_text(json.dumps(refs, indent=2)+"\n")
        temporary.replace(EVIDENCE / "references.json")
        print(f"{label}: {fresh['cells']} cells, Cd {fresh['cd']:.6f}, Cl {fresh['cl']:.6f}, settled={force_settled}, residuals={residual_converged}", flush=True)


if __name__ == "__main__":
    main()
