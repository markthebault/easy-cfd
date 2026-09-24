"""Compare the unchanged Precise Ahmed run with Medium and the local reference."""

import json
from pathlib import Path

import numpy as np

from easycfd import storage
from report_ahmed import ROOT, check_run, raw_coefficients

saved = json.loads((ROOT / "precise.json").read_text())
run = storage.get("runs", saved["id"])
if run["status"] != "completed":
    raise RuntimeError(f"Run is {run['status']}: {run.get('error', run['stage'])}")
verified, _ = check_run("precise")
root = storage.directory("runs", run["id"])
medium = json.loads((root / "results-medium/summary.json").read_text())
original = storage.get("runs", json.loads((ROOT / "native.json").read_text())["id"])
reference = json.loads(Path("docs/ahmed-validation/measurements.json").read_text())["upstream_coarse"]
windows = {}
for tier in ("medium", "precise"):
    raw = raw_coefficients(root / f"case-{tier}/postProcessing/coefficients/0/coefficient.dat")
    windows[tier] = {
        str(n): {
            column: {"mean": float(values[-n:].mean()), "span": float(np.ptp(values[-n:]))}
            for column, values in raw.items()
        }
        for n in (50, 100, 200)
    }
report = {
    "run_id": run["id"],
    "identical_geometry": run["geometry"]["fingerprint"] == original["geometry"]["fingerprint"],
    "identical_pipeline": run["pipeline_hash"] == original["pipeline_hash"],
    "settings": run["settings"],
    "reference": reference,
    "medium_repeat": {
        key: medium[key] for key in ("cd", "cl", "cells", "force_settled", "residual_converged")
    },
    "medium_repeat_delta_cd": medium["cd"] - original["result"]["cd"],
    "medium_repeat_delta_cl": medium["cl"] - original["result"]["cl"],
    "precise": verified,
    "diagnostics": {
        key: run["result"][key]
        for key in (
            "refinement",
            "residuals",
            "y_plus",
            "wall_target_fraction",
            "layer_coverage",
            "medium_timings",
        )
    },
    "force_windows": windows,
    "reference_error_percent": {key: (run["result"][key] / reference[key] - 1) * 100 for key in ("cd", "cl")},
}
assert report["identical_geometry"] and report["identical_pipeline"]
Path("docs/ahmed-validation/precise-measurements.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
