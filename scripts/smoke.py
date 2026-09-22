"""Run a real sample through the running local API: uv run python scripts/smoke.py.

The server owns the queue; this script cannot start a competing solver worker.
Use --quality medium or --quality precise for a longer verification.
"""

import argparse
import json
import time
import httpx

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--quality", choices=["fast", "medium", "precise"], default="fast")
parser.add_argument("--wing", action="store_true")
args = parser.parse_args()
with httpx.Client(base_url="http://127.0.0.1:8000/api", timeout=60) as client:
    response = client.post(
        "/projects",
        json={"name": f"Sample car · {args.quality} verification", "sample": True, "wing": args.wing},
    )
    response.raise_for_status()
    project = response.json()
    response = client.put(
        f"/projects/{project['id']}/settings",
        json={**project["settings"], "quality": args.quality, "geometry_confirmed": True},
    )
    response.raise_for_status()
    response = client.post(f"/projects/{project['id']}/runs")
    response.raise_for_status()
    key = response.json()["id"]
    print(f"Run {key}", flush=True)
    previous = ""
    try:
        while True:
            run = client.get(f"/runs/{key}").json()
            status = f"{run['stage']}: iteration {run['iteration']}"
            if status != previous:
                print(status, flush=True)
                previous = status
            if run["status"] not in ("queued", "running"):
                break
            time.sleep(2)
    except KeyboardInterrupt:
        client.post(f"/runs/{key}/cancel").raise_for_status()
        raise
    print(json.dumps(run.get("result", run.get("error", run["status"])), indent=2))
    raise SystemExit(0 if run["status"] == "completed" else 1)
