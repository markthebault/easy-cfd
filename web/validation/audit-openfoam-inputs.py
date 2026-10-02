#!/usr/bin/env python3
"""Check the actual native STL files, paired physical inputs and measured tunnel bounds."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/webgpu-openfoam-algorithm"
PHYSICAL = ("speed_kmh", "yaw_deg", "reference_area", "density", "moving_ground", "wheels")


def read(path):
    return json.loads(path.read_text())


def main():
    references = read(EVIDENCE / "references.json")
    suite = read(EVIDENCE / "source-audit.json")["acceptance"]["suite"]
    models = read(ROOT / "web/validation/models.json")["models"]
    records = [read(file) for file in sorted((EVIDENCE / "iterations").glob("*.json"))]
    audit, domains = [], []
    for model in models:
        if model["id"] not in suite:
            continue
        reference = references[model["id"]]
        run = ROOT / ".easycfd/runs" / reference["run"]
        native_record = read(run / "record.json")
        case = Path(reference["case"]) if "case" in reference else run / f"case-{reference['quality']}"
        differences = {key: [model["settings"][key], native_record["settings"][key]]
                       for key in PHYSICAL if model["settings"][key] != native_record["settings"][key]}
        parts, digest = [], hashlib.sha256()
        native_parts = {p["id"]: p for p in native_record["geometry"]["parts"]}
        for part in model["parts"]:
            body = (ROOT / ".easycfd/runs" / model["geometryRun"] / "geometry" / part["file"]).read_bytes()
            native = (case / "constant/triSurface" / part["file"]).read_bytes()
            digest.update(body)
            wheel = native_parts[Path(part["file"]).stem].get("wheel")
            parts.append({"file": part["file"], "webgpuSha256": hashlib.sha256(body).hexdigest(),
                          "nativeSha256": hashlib.sha256(native).hexdigest(), "identicalStl": body == native,
                          "wheelMetadataMatches": part.get("wheel") == wheel})
        attempts = [r for r in records if r["model"] == model["id"]]
        hashes = {p["file"]: p["webgpuSha256"] for p in parts}
        attempted_inputs_match = all(all(hashes[Path(p["file"]).name] == p["sha256"] for p in r["inputs"])
                                     and all(r["settings"][key] == model["settings"][key] for key in PHYSICAL)
                                     for r in attempts)
        matches = (not differences and all(p["identicalStl"] and p["wheelMetadataMatches"] for p in parts)
                   and attempted_inputs_match and digest.hexdigest() == native_record["geometry"]["fingerprint"])
        audit.append({"model": model["id"], "nativeCase": str(case), "parts": parts,
                      "nativeFingerprint": native_record["geometry"]["fingerprint"], "webgpuFingerprint": digest.hexdigest(),
                      "physicalInputDifferences": differences, "allAttemptInputsMatch": attempted_inputs_match,
                      "attemptsChecked": len(attempts), "matches": matches})
        block = (case / "system/blockMeshDict").read_text()
        section = block.split("vertices", 1)[1].split(";", 1)[0]
        xyz = [[float(v) for v in item.split()] for item in re.findall(r"\(([^()]+)\)", section)]
        bounds = [v for axis in range(3) for v in (min(p[axis] for p in xyz), max(p[axis] for p in xyz))]
        completed = [r for r in attempts if r["status"] == "completed"]
        measured = completed[-1]["result"]["domain"] if completed else None
        delta = max(abs(a-b) for a, b in zip(bounds, measured)) if measured else None
        domains.append({"model": model["id"], "nativeCase": str(case), "nativeBounds": bounds,
                        "webgpuBounds": measured, "maximumDifferenceMetres": delta,
                        "allCompletedDomainsMatch": all(max(abs(a-b) for a, b in zip(bounds, r["result"]["domain"])) <= 1e-5 for r in completed),
                        "matches": delta <= 1e-5 if delta is not None else None})
    (EVIDENCE / "geometry-input-audit.json").write_text(json.dumps(audit, indent=2)+"\n")
    (EVIDENCE / "domain-audit.json").write_text(json.dumps(domains, indent=2)+"\n")
    if any(not row["matches"] for row in audit) or any(row["matches"] is False or not row["allCompletedDomainsMatch"] for row in domains):
        raise RuntimeError("Native and WebGPU inputs differ; inspect the saved audit")
    print(f"Matched actual native STL files, physical inputs and wheel metadata on {len(audit)} cases; {sum(r['matches'] is True for r in domains)} measured domains match")


if __name__ == "__main__":
    main()
