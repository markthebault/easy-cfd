#!/usr/bin/env python3
"""Short real-container guards; never treats an interrupted run as qualified CFD."""

import argparse
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--mode", choices=["cancel", "timeout", "advanced1", "advanced2"], required=True)
    args = parser.parse_args()

    def call(path, data=None, method=None):
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(
            args.backend + "/api" + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        return json.load(urllib.request.urlopen(req, timeout=15))

    project = call("/projects/" + args.project)
    original = project["settings"]
    settings = {
        **original,
        "quality": "fast" if args.mode in ("cancel", "timeout") else "medium",
        "profile": args.mode if args.mode.startswith("advanced") else None,
        "max_seconds": 30 if args.mode == "timeout" else 90 if args.mode.startswith("advanced") else 120,
    }
    call("/projects/" + args.project + "/settings", settings, "PUT")
    try:
        run = call("/projects/" + args.project + "/runs", {}, "POST")
        start = time.monotonic()
        cancelled_at = None
        computation_started = None
        while run["status"] in ("queued", "running"):
            run = call("/runs/" + run["id"])
            if run["status"] == "running" and computation_started is None:
                computation_started = time.monotonic()
            if args.mode == "cancel" and cancelled_at is None and "Meshing" in run.get("stage", ""):
                cancelled_at = time.monotonic()
                call("/runs/" + run["id"] + "/cancel", {}, "POST")
            if (
                computation_started is not None
                and time.monotonic() - computation_started > settings["max_seconds"] + 20
            ):
                call("/runs/" + run["id"] + "/cancel", {}, "POST")
                raise RuntimeError("The guarded run stayed active beyond its deadline reserve.")
            time.sleep(0.2)
        evidence = {
            "mode": args.mode,
            "elapsed_seconds": time.monotonic() - start,
            "cancellation_seconds": None if cancelled_at is None else time.monotonic() - cancelled_at,
            "qualification": "Resource/termination check only; no aerodynamic accuracy claim.",
            "run": run,
            "logs": call("/runs/" + run["id"] + "/logs"),
        }
        dest = ROOT / "docs/aerodynamic-analysis" / f"runtime-{args.mode}.json"
        dest.write_text(json.dumps(evidence, indent=2))
        print(
            json.dumps(
                {k: evidence[k] for k in ["mode", "elapsed_seconds", "cancellation_seconds"]}, indent=2
            )
        )
        print(run["status"], run.get("error", ""), flush=True)
    finally:
        call("/projects/" + args.project + "/settings", original, "PUT")


if __name__ == "__main__":
    main()
