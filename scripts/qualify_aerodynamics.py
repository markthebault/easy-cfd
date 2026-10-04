#!/usr/bin/env python3
"""Retain separate, reproducible numerical candidates; never calibrate force multipliers."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/aerodynamic-analysis"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--study", choices=["grid", "wall-model", "thin-wall"], required=True)
    args = parser.parse_args()
    EVIDENCE.mkdir(exist_ok=True)
    models = json.loads((ROOT / "web/validation/models.json").read_text())
    inputs = []
    for model in models["models"]:
        for part in model["parts"]:
            path = ROOT / ".easycfd/runs" / model["geometryRun"] / "geometry" / part["file"]
            inputs.append(
                {
                    "model": model["id"],
                    "path": str(path.relative_to(ROOT)),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "bytes": path.stat().st_size,
                    "part": part,
                }
            )
    (EVIDENCE / "input-manifest.json").write_text(json.dumps({"models": models, "inputs": inputs}, indent=2))
    axle = {"frontX": -1.35, "rearX": 1.3, "centrelineY": 0, "confirmed": True}
    cases = (
        [(f"grid-{n}", {"custom_cells": n}, "sample,sample-wing") for n in (45, 60, 72)]
        if args.study == "grid"
        else [("candidate-log-wall", {"wallModel": "log"}, "sample-wing,mx5-kit-wing")]
        if args.study == "wall-model"
        else [("candidate-dilated-wall", {"thinMode": "dilate"}, "sample-wing,mx5-kit-wing")]
    )
    for name, settings, selected in cases:
        settings = {"custom_passes": 10, "custom_cells": 72, "axles": axle, **settings}
        if args.study != "grid":
            settings.pop("axles")  # imported-car axle locations are not guessed
        cmd = [
            "node",
            "validation/run-validation.mjs",
            "--models",
            selected,
            "--quality",
            "custom",
            "--settings",
            json.dumps(settings),
        ]
        before = set((ROOT / "web/validation/results").glob("validation-*.json"))
        print(f"Running {name}", flush=True)
        with (EVIDENCE / f"{name}.txt").open("w") as log:
            completed = subprocess.run(cmd, cwd=ROOT / "web", stdout=log, stderr=subprocess.STDOUT)
        after = set((ROOT / "web/validation/results").glob("validation-*.json")) - before
        if len(after) != 1 or completed.returncode:
            raise RuntimeError(f"{name} failed; its log remains in {EVIDENCE}")
        shutil.copy2(after.pop(), EVIDENCE / f"{name}.json")
        print(f"Saved {name}", flush=True)


if __name__ == "__main__":
    main()
