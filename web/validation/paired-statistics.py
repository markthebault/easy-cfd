#!/usr/bin/env python3
"""Matched quartiles and bias against native spread; no pooling across meshes."""
import argparse
import csv
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PHYSICAL = ("speed_kmh", "yaw_deg", "reference_area", "density", "moving_ground", "wheels")


def quantile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered)-1)*probability
    lo, hi = math.floor(at), math.ceil(at)
    return ordered[lo] + (ordered[hi]-ordered[lo])*(at-lo)


def distribution(values):
    return {"n": len(values), "min": min(values) if values else None,
        "q1": quantile(values, .25), "median": quantile(values, .5),
        "q3": quantile(values, .75), "max": max(values) if values else None,
        "iqr": quantile(values, .75)-quantile(values, .25) if values else None}


def metric(native, gpu, floor=.01):
    differences = [g-n for n, g in zip(native, gpu)]
    signed = [100*(g-n)/max(abs(n), floor) for n, g in zip(native, gpu)]
    absolute = [abs(x) for x in signed]
    nd, gd = distribution(native), distribution(gpu)
    base = max(abs(nd["median"]), floor) if native else None
    iqr = nd["iqr"]
    rng = random.Random(20261003)
    bootstrap = [quantile([rng.choice(signed) for _ in signed], .5) for _ in range(10000)] if signed else []
    return {"native": nd, "gpu": gd, "pairedDifference": distribution(differences),
        "signedErrorPercent": distribution(signed), "absoluteErrorPercent": distribution(absolute),
        "nativeRelativeIqrPercent": 100*iqr/base if base else None,
        "medianDifferenceToNativeIqr": abs(quantile(differences, .5))/iqr if iqr else None,
        "medianAbsoluteDifferenceToNativeIqr": quantile([abs(x) for x in differences], .5)/iqr if iqr else None,
        "bootstrapMedianSignedError95Percent": [quantile(bootstrap, .025), quantile(bootstrap, .975)],
        "bootstrapNote": "10,000 paired resamples, fixed seed. Descriptive uncertainty for this ten-point design, not proof of equivalence or population coverage."}


def read(path):
    return json.loads(path.read_text())


def stage_statistics(output, design, stage):
    folder = output / stage
    audit_file = output / "input-audit.json"
    actual_audit = {r["key"]: r["matches"] for r in read(audit_file)} if audit_file.exists() else {}
    native = {r["key"]: r for p in sorted((folder / "native").glob("*.json")) if (r := read(p))}
    gpu = {r["key"]: r for p in sorted((folder / "iterations").glob("*.json")) if (r := read(p))}
    pairs, rows, failures = [], [], []
    for trial in design["trials"]:
        key = f"{stage}-{trial['id']}"
        n, g = native.get(key), gpu.get(key)
        if not n or not g or n["status"] != "completed" or g["status"] != "completed":
            failures.append({"key": key, "nativeStatus": n.get("status") if n else "not run",
                "gpuStatus": g.get("status") if g else "not run"})
            continue
        result = g["result"]
        matches = (all(n["settings"][p] == g["settings"][p] == trial["settings"][p] for p in PHYSICAL)
            and all(n["partHashes"].get(Path(p["file"]).name) == p["sha256"] for p in g["inputs"])
            and max(abs(a-b) for a, b in zip(n["domain"], result["domain"])) <= 1e-5
            and result["cells"] == design["stages"][stage]["gpuCells"]
            and g["sourceRevision"] == design["gpuSourceRevision"]
            and g["reference"]["key"] == key and all(g["reference"][p] == n[p] for p in ("cd", "cl"))
            and result["initializedFromReference"] is False and actual_audit.get(key, False))
        errors = {p: abs(result[p]-n[p])/max(abs(n[p]), .01) for p in ("cd", "cl")}
        healthy = g["comparison"]["finite"] and g["comparison"]["conserved"]
        quality = healthy and g["comparison"]["stable"] and n["forceSettled"] and n["residualConverged"] and n["meshPassed"]
        row = {"key": key, "speedKmh": trial["settings"]["speed_kmh"], "yawDeg": trial["settings"]["yaw_deg"],
            "nativeCells": n["cells"], "gpuCells": result["cells"], "nativeCd": n["cd"], "gpuCd": result["cd"],
            "nativeCl": n["cl"], "gpuCl": result["cl"], "cdErrorPercent": 100*errors["cd"], "clErrorPercent": 100*errors["cl"],
            "nativeForceSettled": n["forceSettled"], "nativeResidualConverged": n["residualConverged"],
            "gpuForceStable": g["comparison"]["stable"], "gpuHealthy": healthy, "inputsMatch": matches,
            "agrees": all(e <= design["tolerance"] for e in errors.values()), "quality": quality,
            "nativeWallSeconds": n["wallSeconds"], "gpuWallSeconds": result["wallSeconds"]}
        rows.append(row)
        pairs.append((n, result))
    metrics = {p: metric([n[p] for n, g in pairs], [g[p] for n, g in pairs], .01 if p in ("cd", "cl") else 1.) for p in ("cd", "cl", "drag", "lift")}
    temporal = {}
    for coefficient in ("cd", "cl"):
        temporal[coefficient] = {
            "last200SpanPercent": distribution([100*n["forceSpans"][coefficient]/max(abs(n[coefficient]), .01) for n, g in pairs]),
            "last200StdPercent": distribution([100*n["forceWindowStd"][coefficient]/max(abs(n[coefficient]), .01) for n, g in pairs]),
            "last200SplitDriftPercent": distribution([100*abs(n["forceWindowSplitMeans"][coefficient][1]-n["forceWindowSplitMeans"][coefficient][0])/max(abs(n[coefficient]), .01) for n, g in pairs])}
    passed = len(rows) == 10 and all(r["inputsMatch"] and r["agrees"] and r["quality"] for r in rows)
    return {"pairedCount": len(rows), "nativeAttempted": len(native), "gpuAttempted": len(gpu), "passed": passed,
        "agreementPairs": sum(r["agrees"] for r in rows), "qualityPairs": sum(r["quality"] for r in rows),
        "allInputsMatch": len(rows) == 10 and all(r["inputsMatch"] for r in rows), "metrics": metrics,
        "nativeIterationVariability": temporal, "pairs": rows, "missingOrFailed": failures,
        "nativeStatusCounts": {s: sum(r["status"] == s for r in native.values()) for s in ("completed", "failed", "running")},
        "gpuStatusCounts": {s: sum(r["status"] == s for r in gpu.values()) for s in ("completed", "failed", "running")}}


def triple(distribution, digits=3):
    if distribution["median"] is None:
        return "pending"
    return " / ".join(f"{distribution[k]:.{digits}f}" for k in ("q1", "median", "q3"))


def render_report(output, design, report):
    lines = ["# Matched OpenFOAM/WebGPU input-variation pilot", "",
        "Ten independent native and GPU starts at each tested resolution, using the same ten speed/yaw settings on one sample car. "
        "OpenFOAM's spread across those settings measures input sensitivity. Iterative drift is recorded separately; this is not a repeatability test with identical inputs.", "",
        f"Registered tolerance: {100*design['tolerance']:.0f}% for both signed Cd and Cl in every pair, plus convergence and healthy-field checks. "
        "The 500,000-cell stage is conditional on both smaller stages passing. GPU source and settings are frozen across stages; reference fields are never supplied to the GPU.", "",
        "Quartiles use linear interpolation at `(n-1)*p`. Entries below are **Q1 / median / Q3**. "
        "Errors are paired before summarizing, with `100*(GPU-native)/max(abs(native), 0.01)` for coefficients.", "",
        "| Stage | Metric | OpenFOAM | WebGPU | Paired absolute error (%) |", "|---|---|---|---|---|"]
    for stage, data in report["stages"].items():
        for metric_name in ("cd", "cl"):
            detail = data["metrics"][metric_name]
            lines.append(f"| {stage} | {metric_name.upper()} | {triple(detail['native'], 5)} | {triple(detail['gpu'], 5)} | {triple(detail['absoluteErrorPercent'], 2)} |")
    lines.extend(["", "| Stage | Pairs complete | Both coefficients within 5% | Convergence/field checks | Pass |", "|---|---:|---:|---:|---|"])
    for stage, data in report["stages"].items():
        lines.append(f"| {stage} | {data['pairedCount']}/10 | {data['agreementPairs']}/10 | {data['qualityPairs']}/10 | {'yes' if data['passed'] else 'no'} |")
    lines.extend(["", f"500,000-cell decision: **{report['finalDecision']}**.", "",
        "## Native variability versus solver disagreement", "",
        "| Stage | Metric | Native IQR / median (%) | Median absolute solver difference / native IQR | Native last-200 span, Q1 / median / Q3 (%) |", "|---|---|---:|---:|---|"])
    for stage, data in report["stages"].items():
        for metric_name in ("cd", "cl"):
            detail = data["metrics"][metric_name]
            iqr = detail["nativeRelativeIqrPercent"]
            ratio = detail["medianAbsoluteDifferenceToNativeIqr"]
            lines.append(f"| {stage} | {metric_name.upper()} | {iqr:.2f} | {ratio:.2f} | {triple(data['nativeIterationVariability'][metric_name]['last200SpanPercent'], 2)} |" if iqr is not None and ratio is not None else f"| {stage} | {metric_name.upper()} | pending | pending | pending |")
    lines.extend(["", "A broad Monte Carlo requires a justified input distribution. Ten bounded input changes cannot establish that a solver is generally accurate. "
        "Systematic paired errors larger than native input sensitivity remain solver differences, even if some pooled ranges overlap. "
        "Unsettled native cases limit the strength of a numerical accuracy conclusion and should be improved before an expensive uncertainty campaign.", "",
        "Native and GPU grids have different topology, near-wall treatment and actual fluid-cell counts. Cell budgets describe resolution stages, not identical discretizations. "
        "OpenFOAM uses the app's Fast/Medium/Precise meshing presets, with a mesh built once per stage and reused unchanged for all ten input variations. "
        "Baseline layer thickness is held fixed. Each native solve starts from freshly generated uniform fields and each GPU solve from freestream plus projection.", "",
        "Saved artifacts: [registered design](design.json), [full statistics](statistics.json), [paired rows](pairs.csv), per-stage plans, meshes, native records and GPU records. "
        "Full native meshes, fields and logs remain under `.accuracy-reference/paired-inputs/`.", ""])
    lines.extend(["## Physical forces under the same changed inputs", "",
        "Force variation includes the expected speed-squared scaling. Coefficient errors above isolate the aerodynamic response from that scaling.", "",
        "| Stage | Force (N) | OpenFOAM Q1 / median / Q3 | WebGPU Q1 / median / Q3 | Native IQR / median (%) |", "|---|---|---|---|---:|"])
    for stage, data in report["stages"].items():
        for name in ("drag", "lift"):
            detail = data["metrics"][name]
            relative = detail["nativeRelativeIqrPercent"]
            text = f"{relative:.2f}" if relative is not None else "pending"
            lines.append(f"| {stage} | {name} | {triple(detail['native'], 2)} | {triple(detail['gpu'], 2)} | {text} |")
    lines.extend(["", "## Paired signed bias", "",
        "| Stage | Metric | Signed error Q1 / median / Q3 (%) | Bootstrap median interval (%) |", "|---|---|---|---|"])
    for stage, data in report["stages"].items():
        for name in ("cd", "cl"):
            detail = data["metrics"][name]
            interval = detail["bootstrapMedianSignedError95Percent"]
            text = "pending" if interval[0] is None else f"{interval[0]:.2f} to {interval[1]:.2f}"
            lines.append(f"| {stage} | {name.upper()} | {triple(detail['signedErrorPercent'], 2)} | {text} |")
    lines.extend(["", "These bootstrap intervals describe this selected ten-point design; the pilot is too small and too narrow to establish general solver equivalence.", ""])
    (output / "README.md").write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/webgpu-paired-inputs")
    args = parser.parse_args()
    output = ROOT / args.output
    design = read(output / "design.json")
    stages = {stage: stage_statistics(output, design, stage) for stage in design["stages"] if (output / stage / "native").exists()}
    ready = all(stages.get(stage, {}).get("passed", False) for stage in ("small", "medium"))
    decision = "eligible: both smaller stages passed" if ready else "not eligible: both smaller stages must pass"
    if "final" in stages:
        decision = "completed and passed" if stages["final"]["passed"] else "completed; final stage failed"
    report = {"stages": stages, "finalEligible": ready, "finalDecision": decision,
        "gate": design["gate"], "bootstrapMethod": "10,000 paired resamples, percentile interval for signed-error median, seed 20261003",
        "limits": "Only one geometry, ten selected inputs, no identical-input repetition campaign or experimental aerodynamic qualification."}
    (output / "statistics.json").write_text(json.dumps(report, indent=2, allow_nan=False)+"\n")
    rows = [{"stage": stage, **r} for stage, data in stages.items() for r in data["pairs"]]
    if rows:
        with (output / "pairs.csv").open("w", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    render_report(output, design, report)
    for stage, data in stages.items():
        print(f"{stage}: {data['pairedCount']} pairs, agreement {data['agreementPairs']}/10, quality {data['qualityPairs']}/10, pass={data['passed']}")
        for name in ("cd", "cl"):
            print(f"  {name}: paired absolute error Q1/median/Q3 % {triple(data['metrics'][name]['absoluteErrorPercent'], 2)}")
    print(decision)


if __name__ == "__main__":
    main()
