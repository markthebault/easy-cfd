#!/usr/bin/env python3
"""Verify the retained evidence and recompute paired quartiles with the standard library."""
import csv
import hashlib
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/webgpu-investigation"


def read(path):
    return json.loads(path.read_text())


def main():
    manifest = read(REPORT / "evidence-index.json")
    files = [entry for entry in manifest["files"] if "local" in entry]
    for entry in files:
        assert hashlib.sha256((REPORT / entry["local"]).read_bytes()).hexdigest() == entry["sha256"], entry["local"]
    evidence = REPORT / "evidence"
    initial = read(evidence / "webgpu-accuracy/evaluation.json")
    assert (initial["limit"], initial["attempts"], initial["completed"], initial["failed"]) == (100, 100, 100, 0)
    assert len({row["model"] for row in initial["suite"]}) == 8
    assert all(row["result"]["cells"] == 500000 and not row["comparison"]["agrees"] for row in initial["suite"])
    algorithm = read(evidence / "webgpu-openfoam-algorithm/evaluation.json")
    assert (algorithm["limit"], algorithm["attempts"], algorithm["completed"], algorithm["failed"]) == (50, 50, 41, 9)
    assert len({row["model"] for row in algorithm["final"]}) == 8
    assert all(row["cells"] == 500000 and not row["comparison"]["agrees"] for row in algorithm["final"])
    paired = read(evidence / "webgpu-paired-inputs/statistics.json")
    assert paired["finalEligible"] is False
    with (evidence / "webgpu-paired-inputs/pairs.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 20 and len({row["key"] for row in rows}) == 20
    for stage in ("small", "medium"):
        data = paired["stages"][stage]
        assert data["pairedCount"] == 10 and data["agreementPairs"] == 0 and data["passed"] is False
        selected = [row for row in rows if row["key"].startswith(f"{stage}-")]
        assert len(selected) == 10 and all(row["inputsMatch"] == "True" for row in selected)
        for coefficient in ("cd", "cl"):
            errors = [100 * abs(float(row[f"gpu{coefficient.title()}"]) - float(row[f"native{coefficient.title()}"]))
                      / max(abs(float(row[f"native{coefficient.title()}"])), .01) for row in selected]
            quartiles = statistics.quantiles(errors, n=4, method="inclusive")
            recorded = data["metrics"][coefficient]["absoluteErrorPercent"]
            assert all(math.isclose(value, recorded[key], rel_tol=1e-12, abs_tol=1e-12)
                       for key, value in zip(("q1", "median", "q3"), quartiles)), (stage, coefficient)
    audited = read(evidence / "webgpu-paired-inputs/input-audit.json")
    assert len(audited) == 20 and all(row["matches"] for row in audited)
    model = next(model for model in read(ROOT / "web/validation/models.json")["models"] if model["id"] == "simple-car")
    reference = next(reference for reference in model["references"] if reference["quality"] == "medium")
    assert model["settings"]["speed_kmh"] == reference["speed_kmh"] == 200
    print(f"Verified {len(files)} unchanged evidence files, both bounded campaigns, 20 input audits and paired quartiles.")


if __name__ == "__main__":
    main()
