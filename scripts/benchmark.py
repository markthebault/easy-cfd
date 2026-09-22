"""Download and run AhmedML case 1 through the local queue; print reference discrepancies.

Requires the local server. Downloads only one 7.5 MB geometry, force coefficients,
and the dataset license into the ignored data directory. Does not download the dataset.
"""

import argparse
import hashlib
import json
import time
import httpx
from easycfd import geometry, storage
from easycfd.benchmark import REFERENCE
from easycfd.models import ImportOptions, Settings

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--quality", choices=["fast", "medium", "precise"], default="medium")
args = parser.parse_args()
root = storage.ROOT / "reference/ahmedml-run-1"
root.mkdir(parents=True, exist_ok=True)
base = "https://huggingface.co/datasets/neashton/ahmedml/resolve/main/"
for remote, local, expected in [
    ("run_1/ahmed_1.stl", "ahmed_1.stl", REFERENCE["geometry_sha256"]),
    ("run_1/force_mom_1.csv", "force_mom_1.csv", REFERENCE["coefficients_sha256"]),
    ("LICENSE.txt", "LICENSE.txt", None),
]:
    path = root / local
    if not path.exists():
        response = httpx.get(base + remote, follow_redirects=True, timeout=60)
        response.raise_for_status()
        path.write_bytes(response.content)
    if expected and hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f"Reference file hash mismatch: {local}")
key = storage.identifier()
folder = storage.directory("projects", key) / "geometry"
folder.mkdir(parents=True)
data = geometry.import_files([root / "ahmed_1.stl"], folder, ImportOptions(clearance=REFERENCE["clearance"]))
if data["errors"]:
    raise RuntimeError(data["errors"])
project = dict(
    id=key,
    name="AhmedML run 1 · reference comparison",
    created=storage.now(),
    geometry=data,
    geometry_dir="geometry",
    reference_case="ahmedml-run-1",
    settings=Settings(
        speed_kmh=REFERENCE["speed_kmh"],
        density=1,
        reference_area=REFERENCE["reference_area"],
        quality=args.quality,
        moving_ground=False,
        wheels=False,
        geometry_confirmed=True,
    ).model_dump(),
)
storage.save("projects", project)
with httpx.Client(base_url="http://127.0.0.1:8000/api", timeout=60) as client:
    response = client.post(f"/projects/{key}/runs")
    response.raise_for_status()
    run = response.json()
    key = run["id"]
    print(f"Reference run: {key}", flush=True)
    previous = ""
    try:
        while run["status"] in ("queued", "running"):
            if run["stage"] != previous:
                previous = run["stage"]
                print(previous, flush=True)
            time.sleep(2)
            run = client.get(f"/runs/{key}").json()
    except KeyboardInterrupt:
        client.post(f"/runs/{key}/cancel")
        raise
    report = {k: run.get(k) for k in ["id", "status", "settings", "error"]}
    report["result"] = run.get("result")
    (root / "comparison.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if run["status"] == "completed" else 1)
