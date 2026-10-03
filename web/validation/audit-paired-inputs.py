#!/usr/bin/env python3
"""Read actual paired native dictionaries, meshes and geometry after solving."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads(path.read_text())


def close(a, b):
    return abs(a-b) <= 1e-7*max(1., abs(a), abs(b))


def vector(content, pattern):
    return [float(x) for x in re.search(pattern, content)[1].split()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/webgpu-paired-inputs")
    args = parser.parse_args()
    output = ROOT / args.output
    design = read(output / "design.json")
    models = read(ROOT / "web/validation/models.json")["models"]
    model = next(m for m in models if m["id"] == design["model"])
    evidence = []
    for stage in design["stages"]:
        folder = output / stage
        gpu = {r["key"]: r for p in (folder / "iterations").glob("*.json") if (r := read(p)) and r["status"] == "completed"}
        for file in sorted((folder / "native").glob("*.json")):
            n = read(file)
            if n["status"] != "completed" or n["key"] not in gpu:
                continue
            g = gpu[n["key"]]
            case = Path(n["case"])
            control = (case / "system/controlDict").read_text()
            initial_u = (case / "0/U").read_text()
            s = g["settings"]
            speed = s["speed_kmh"]/3.6
            velocity = [speed, speed*math.tan(math.radians(s["yaw_deg"])), 0.]
            magnitude = math.hypot(velocity[0], velocity[1])
            actual_velocity = vector(initial_u, r"internalField\s+uniform\s+\(([^()]*)\)")
            coeff_section = control.split("coefficients {", 1)[1].split("}\n", 1)[0]
            coeff_inputs = {name: float(re.search(r"\b"+name+r"\s+([\d.eE+-]+);", coeff_section)[1]) for name in ("rhoInf", "magUInf", "Aref")}
            ground = vector(initial_u, r"ground\s*\{[^}]*value\s+uniform\s+\(([^()]*)\)")
            body = initial_u.split("part0", 1)[1].split("}", 1)[0]
            wheels_match = True
            for part in model["parts"]:
                if part["role"] != "wheel":
                    continue
                section = initial_u.split(Path(part["file"]).stem, 1)[1].split("}", 1)[0]
                if s["wheels"]:
                    omega = float(re.search(r"omega\s+([\d.eE+-]+);", section)[1])
                    wheels_match &= ("rotatingWallVelocity" in section and close(omega, -speed/part["wheel"]["radius"])
                        and all(close(a, b) for a, b in zip(vector(section, r"origin\s+\(([^()]*)\)"), part["wheel"]["center"]))
                        and vector(section, r"axis\s+\(([^()]*)\)") == [0., 1., 0.])
                else:
                    wheels_match &= "noSlip" in section
            vertices = (case / "system/blockMeshDict").read_text().split("vertices", 1)[1].split(";", 1)[0]
            xyz = [[float(v) for v in item.split()] for item in re.findall(r"\(([^()]+)\)", vertices)]
            bounds = [v for axis in range(3) for v in (min(p[axis] for p in xyz), max(p[axis] for p in xyz))]
            actual_parts = {p["file"]: hashlib.sha256((case / "constant/triSurface" / p["file"]).read_bytes()).hexdigest() for p in model["parts"]}
            same_geometry = all(actual_parts[Path(p["file"]).name] == p["sha256"] for p in g["inputs"])
            same_mesh = all(hashlib.sha256((case / "constant/polyMesh" / name).read_bytes()).hexdigest() == digest for name, digest in n["meshHashes"].items())
            same_dictionaries = all(hashlib.sha256((case / name).read_bytes()).hexdigest() == digest for name, digest in n["dictionaryHashes"].items())
            turbulence = (case / "constant/turbulenceProperties").read_text()
            transport = (case / "constant/transportProperties").read_text()
            length = model["dimensions"][0]
            expected_k = 1.5*(magnitude*.01)**2
            expected_omega = math.sqrt(expected_k)/(.09**.25*.07*length)
            actual_k = float(re.search(r"internalField\s+uniform\s+([\d.eE+-]+);", (case / "0/k").read_text())[1])
            actual_omega = float(re.search(r"internalField\s+uniform\s+([\d.eE+-]+);", (case / "0/omega").read_text())[1])
            expected_dynamic_pressure = .5*s["density"]*magnitude**2
            q_area = expected_dynamic_pressure*s["reference_area"]
            result = g["result"]
            checks = {"actualFreestreamMatches": all(close(a,b) for a,b in zip(actual_velocity, velocity)),
                "coefficientNormalizationMatches": all(close(a,b) for a,b in zip(coeff_inputs.values(), (s["density"], magnitude, s["reference_area"]))),
                "groundMatches": ground == [speed if s["moving_ground"] else 0., 0., 0.] or all(close(a,b) for a,b in zip(ground, [speed if s["moving_ground"] else 0., 0., 0.])),
                "wheelConditionsMatch": bool(wheels_match), "bodyNoSlip": "noSlip" in body,
                "actualDomainsMatch": max(abs(a-b) for a,b in zip(bounds, g["result"]["domain"])) <= 1e-5,
                "actualStlsMatch": same_geometry, "sameNativeMeshWithinStage": same_mesh,
                "savedDictionariesUnchanged": same_dictionaries, "nativeSst": "kOmegaSST" in turbulence,
                "sameViscosity": "1.5e-5;" in transport,
                "inletTurbulenceMatches": close(actual_k, expected_k) and close(actual_omega, expected_omega),
                "coefficientDirectionsMatch": vector(coeff_section, r"dragDir\s+\(([^()]*)\)") == [1.,0.,0.]
                    and vector(coeff_section, r"liftDir\s+\(([^()]*)\)") == [0.,0.,1.],
                "gpuForceNormalizationMatches": close(result["freestream"], magnitude)
                    and close(result["dynamicPressure"], expected_dynamic_pressure)
                    and close(result["drag"], result["cd"]*q_area)
                    and close(result["lift"], result["cl"]*q_area),
                "gpuForceAxesMatch": close(result["drag"], result["aero"]["force"][0])
                    and close(result["lift"], result["aero"]["force"][2]),
                "freshGpuStart": not result["initializedFromReference"]}
            evidence.append({"key": n["key"], "checks": checks, "matches": all(checks.values()),
                "nativeVelocity": actual_velocity, "nativeCoefficientInputs": coeff_inputs, "nativeBounds": bounds,
                "gpuBounds": g["result"]["domain"], "nativePartHashes": actual_parts,
                "nativeMeshCells": n["cells"], "gpuGridCells": g["result"]["cells"]})
    (output / "input-audit.json").write_text(json.dumps(evidence, indent=2)+"\n")
    if any(not row["matches"] for row in evidence):
        raise RuntimeError("Actual paired input audit failed; inspect input-audit.json")
    print(f"Actual native dictionaries, STL files, wheel conditions, turbulence and unchanged stage mesh matched on {len(evidence)} pairs")


if __name__ == "__main__":
    main()
