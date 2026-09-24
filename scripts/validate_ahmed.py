"""Bounded Ahmed comparison using nathanrooy's pinned RANS case.

Run after cloning the source into .easycfd/reference/nathanrooy-ahmed.
The upstream mode reduces refinement by two levels and raises the model 5 mm.
The matched mode runs EasyCFD-generated fields and force extraction on that same
mesh, with upstream boundary conditions and numerical schemes. It is a pipeline
verification, not validation of the normal EasyCFD meshing presets.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import trimesh
import httpx

from easycfd import foam, geometry, results, runner, storage
from easycfd.models import Settings

REVISION = "25677d638b1ae6f1289cb6b70fce666f898ce560"
SOURCE = storage.ROOT / "reference/nathanrooy-ahmed"
ROOT = storage.ROOT / "reference/nathanrooy-comparison"


def command(case, args, timings):
    tool = args[-2] if args[0] == "mpirun" else args[0]
    print(tool, flush=True)
    start = time.monotonic()
    with (case / f"log.{tool}").open("w") as log:
        try:
            done = subprocess.run(
                runner.container("ahmed-reference-audit", case.resolve(), args, 5, 4),
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=1200,
            )
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            runner.docker(["rm", "-f", "ahmed-reference-audit"])
            raise
    timings[tool] = time.monotonic() - start
    if done.returncode:
        raise RuntimeError((case / f"log.{tool}").read_text()[-4000:])
    if tool == "checkMesh" and "Mesh OK." not in (case / "log.checkMesh").read_text():
        raise RuntimeError("Reference mesh failed checks; inspect log.checkMesh.")


def parallel(tool):
    return ["mpirun", "--allow-run-as-root", "--oversubscribe", "-np", "4", tool, "-parallel"]


def native(quality="medium"):
    with httpx.Client(base_url="http://127.0.0.1:8000/api", timeout=120) as client:
        response = client.post(
            "/projects", json={"name": f"Ahmed 25° · native EasyCFD {quality.title()}", "sample": False}
        )
        response.raise_for_status()
        key = response.json()["id"]
        path = SOURCE / "openfoam_rans/constant/triSurface/ahmed_25deg_m.stl"
        response = client.post(
            f"/projects/{key}/import",
            files={"files": (path.name, path.read_bytes())},
            data={"options": json.dumps({"clearance": 0.005})},
        )
        response.raise_for_status()
        if response.json()["geometry"]["errors"]:
            raise ValueError(response.json()["geometry"]["errors"])
        settings = Settings(
            quality=quality,
            speed_kmh=144,
            reference_area=0.115032,
            density=1,
            moving_ground=True,
            wheels=False,
            geometry_confirmed=True,
        )
        response = client.put(f"/projects/{key}/settings", json=settings.model_dump())
        response.raise_for_status()
        response = client.post(f"/projects/{key}/runs")
        response.raise_for_status()
        run = response.json()
        (ROOT / ("precise.json" if quality == "precise" else "native.json")).write_text(
            json.dumps(run, indent=2)
        )
        while run["status"] in ("queued", "running"):
            print(run["stage"], run.get("iteration", 0), flush=True)
            time.sleep(10)
            response = client.get(f"/runs/{run['id']}")
            response.raise_for_status()
            run = response.json()
        if run["status"] != "completed":
            raise RuntimeError(run.get("error", run["status"]))


def upstream():
    revision = subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip()
    if revision != REVISION:
        raise ValueError(f"Expected upstream revision {REVISION}, got {revision}")
    case = ROOT / "upstream-coarse"
    shutil.copytree(SOURCE / "openfoam_rans", case)
    path = case / "constant/triSurface/ahmed_25deg_m.stl"
    mesh = trimesh.load_mesh(path)
    mesh.apply_translation([0, 0, 0.005])
    mesh.export(path)
    shutil.copy2(case / "0/U.orig", case / "0/U")
    path = case / "system/snappyHexMeshDict"
    text = path.read_text()
    for before, after in [
        ("level 8;", "level 6;"),
        ("level (7 8);", "level (5 6);"),
        ("((0.025 8) (0.1 7))", "((0.025 6) (0.1 5))"),
        ("((1E15 5))", "((1E15 3))"),
        ("((1E15 6))", "((1E15 4))"),
        ("((1E15 7))", "((1E15 5))"),
        ("maxGlobalCells 30000000", "maxGlobalCells 1400000"),
        ("minMedianAxisAngle", "minMedialAxisAngle"),
    ]:
        text = text.replace(before, after)
    path.write_text(text)
    path = case / "system/controlDict"
    path.write_text(
        path.read_text().replace('#include "streamLines"', "").replace('#include "cuttingPlane"', "")
    )
    foam.write(
        case / "system/surfaceFeatureExtractDict",
        """
ahmed_25deg_m.stl {extractionMethod extractFromSurface;
extractFromSurfaceCoeffs {includedAngle 150;} writeObj no;}
""",
    )
    path = case / "system/decomposeParDict"
    path.write_text(re.sub(r"numberOfSubdomains\s+\d+;", "numberOfSubdomains 4;", path.read_text()))
    path.write_text(path.read_text().replace("(3 2 1)", "(2 2 1)"))
    path = case / "system/meshQualityDict"
    path.write_text(
        path.read_text().replace("caseDicts/mesh/generation/meshQualityDict", "caseDicts/meshQualityDict")
    )
    path.write_text(path.read_text() + "\nnSmoothScale 4;\nerrorReduction 0.75;\n")
    (case / "case.foam").touch()
    timings = {}
    for args in [
        ["surfaceFeatureExtract"],
        ["blockMesh"],
        ["snappyHexMesh", "-overwrite"],
        ["checkMesh", "-allTopology"],
        ["decomposePar", "-force"],
        parallel("potentialFoam"),
        parallel("simpleFoam"),
        ["reconstructPar", "-newTimes"],
    ]:
        command(case, args, timings)
    (ROOT / "upstream-timings.json").write_text(json.dumps(timings, indent=2))


def matched():
    source = ROOT / "upstream-coarse"
    project_id, run_id = storage.identifier(), storage.identifier()
    folder = storage.directory("projects", project_id) / "geometry"
    folder.mkdir(parents=True)
    mesh = trimesh.load_mesh(source / "constant/triSurface/ahmed_25deg_m.stl")
    data = geometry.persist_parts(folder, [("Ahmed 25 degrees", mesh, "body", None)])
    if data["errors"]:
        raise ValueError(data["errors"])
    settings = Settings(
        speed_kmh=144,
        reference_area=0.115032,
        density=1.225,
        moving_ground=True,
        wheels=False,
        geometry_confirmed=True,
    )
    project = dict(
        id=project_id,
        name="Ahmed 25° · shared-mesh verification",
        created=storage.now(),
        geometry=data,
        geometry_dir="geometry",
        settings=settings.model_dump(),
    )
    storage.save("projects", project)
    root = storage.directory("runs", run_id)
    root.mkdir()
    shutil.copytree(folder, root / "geometry")
    run = dict(
        id=run_id,
        project_id=project_id,
        name=project["name"],
        created=storage.now(),
        settings=settings.model_dump(),
        geometry=data,
        status="running",
        stage="Verification",
        iteration=0,
        image=foam.IMAGE,
        processes=4,
        cpus=4,
        pipeline_hash=hashlib.sha256(
            (runner.PIPELINE_HASH + REVISION + "shared-mesh-v1").encode()
        ).hexdigest(),
        reference_case="nathanrooy-25-shared-mesh",
        verification_script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    )
    storage.save("runs", run)
    (ROOT / "matched.json").write_text(json.dumps(run, indent=2))
    case = root / "case-medium"
    meta = foam.generate(case, root / "geometry", data, settings)
    # Preserve upstream coordinates and exact mesh. Only patch names change.
    shutil.copytree(source / "constant/polyMesh", case / "constant/polyMesh")
    path = case / "constant/polyMesh/boundary"
    text = path.read_text()
    for old, new in [
        ("frontAndBack", "sides"),
        ("upperWall", "top"),
        ("lowerWall", "ground"),
        ("ahmed_body", "part0"),
    ]:
        text = text.replace(old, new)
    path.write_text(text)
    for name in ["fvSchemes", "fvSolution", "decomposeParDict"]:
        shutil.copy2(source / "system" / name, case / "system" / name)
    for field in ["U", "p", "k", "omega", "nut"]:
        path = case / "0" / field
        text = path.read_text()
        if field == "omega":
            text = re.sub(r"uniform [\deE.+-]+", "uniform 1.78", text)
        for name in ["sides", "top"]:
            condition = "type calculated; value uniform 0;" if field == "nut" else "type slip;"
            text = re.sub(rf"{name}\s*\{{[^}}]*\}}", f"{name} {{{condition}}}", text)
        if field == "U":
            text = text.replace("inletValue uniform (40 0 0)", "inletValue uniform (0 0 0)")
        path.write_text(text)
    path = case / "system/controlDict"
    path.write_text(path.read_text().replace("endTime 1000", "endTime 500"))
    meta.update(
        domain=[-5, 15, -4, 4, 0, 8],
        tunnel_cross_section=64,
        blockage_ratio=settings.reference_area / 64,
        verification="Shared upstream mesh, boundaries, numerics; EasyCFD field/force pipeline",
        upstream_revision=REVISION,
    )
    (case / "metadata.json").write_text(json.dumps(meta, indent=2))
    # Save the actual mesh recipe rather than leaving generated, unused dictionaries.
    for name in ["blockMeshDict", "snappyHexMeshDict", "surfaceFeatureExtractDict"]:
        shutil.copy2(source / "system" / name, case / "system" / (name + ".upstream"))
    timings = {}
    try:
        for args in [
            ["checkMesh", "-allTopology"],
            ["decomposePar", "-force"],
            parallel("potentialFoam"),
            parallel("simpleFoam"),
            ["reconstructPar", "-newTimes"],
        ]:
            command(case, args, timings)
        result = results.process(case, root / "results", run, meta)
        result.update(
            timings=timings,
            mesh_ok="Mesh OK." in (case / "log.checkMesh").read_text(),
            preset="medium",
            layer_coverage=None,
        )
        result["warnings"].append(
            "Controlled verification: upstream mesh, boundary conditions and numerical schemes, 500 iterations. This is not the standard Medium preset or an experimental validation."
        )
        (root / "results/summary.json").write_text(json.dumps(result, indent=2))
        storage.update(
            "runs",
            run_id,
            result=result,
            status="completed",
            stage="Complete",
            iteration=500,
            finished=storage.now(),
            disk_bytes=runner.disk_bytes(root),
        )
        print(json.dumps({"run_id": run_id, "cd": result["cd"], "cl": result["cl"]}), flush=True)
    except Exception as error:
        storage.update("runs", run_id, status="failed", stage="Failed", error=str(error))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["native", "precise", "upstream", "matched"])
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    {"native": native, "precise": lambda: native("precise"), "upstream": upstream, "matched": matched}[
        args.mode
    ]()
