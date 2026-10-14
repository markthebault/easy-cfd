#!/usr/bin/env python3
"""Exercise the built API image without logging its generated connection token."""
import argparse
import json
import math
import os
import re
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--simulate", action="store_true", help="Run the sample car with four bundled MPI ranks")
    parser.add_argument("--cancel", action="store_true", help="Cancel a second case while its MPI solver is active")
    parser.add_argument("--wing", action="store_true", help="Use the sample with its wing assembly")
    parser.add_argument("--keep", help="Keep the test server and write private connection details to this file")
    parser.add_argument("--data-parent", type=Path, default=Path.home(), help="Parent directory for temporary saved data")
    parser.add_argument("--named-volume", action="store_true", help="Use temporary Docker-managed data rather than a host folder")
    args = parser.parse_args()
    assert not args.cancel or args.simulate, "Cancellation requires the simulation check"
    name = "easycfd-image-test-" + uuid.uuid4().hex[:10]
    data = name + "-data" if args.named_volume else tempfile.mkdtemp(prefix=".easycfd-image-test-", dir=args.data_parent)
    command = ["run", "-d", "--name", name, "--init", "-p", "127.0.0.1::8000", "-v", f"{data}:/data"]
    docker(*command, args.image)
    keep_server = False
    try:
        port = docker("port", name, "8000/tcp").split(":")[-1]
        base = f"http://127.0.0.1:{port}"

        def request(path, token="", method="GET", body=None):
            req = Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json", "Origin": "https://easy-cfd.mthracelab.com", "Authorization": "Bearer " + token})
            try:
                with urlopen(req, timeout=10) as response:
                    return response.status, response.headers, json.load(response)
            except HTTPError as error:
                return error.code, error.headers, json.load(error)

        def ready():
            for _ in range(90):
                try:
                    if request("/api/health")[0] == 401:
                        return
                except (URLError, TimeoutError, ConnectionError):
                    pass
                time.sleep(1)
            raise RuntimeError("Image API did not become ready within 90 seconds")

        ready()
        token = docker("exec", name, "python", "-c", "from pathlib import Path; print(Path('/data/.api-token').read_text().strip())")
        assert len(token) >= 32
        logs = docker("logs", name)  # URL is printed, but never echoed by this test.
        assert token in logs
        assert request("/api/health", "wrong")[0] == 401
        status, headers, health = request("/api/health", token)
        assert status == 200 and headers["access-control-allow-origin"] == "*"
        assert health["ready"] and health["runtime"] == "local", health.get("message")
        assert docker("exec", name, "python", "-c", "import shutil; from pathlib import Path; print(shutil.which('docker') is None and not Path('/var/run/docker.sock').exists())") == "True"
        assert not json.loads(docker("inspect", name))[0]["HostConfig"]["Privileged"]
        assert len(json.loads(docker("inspect", name))[0]["Mounts"]) == 1
        assert request("/api/runs", token)[0] == 200
        assert request("/", token)[0] == 404
        preflight = Request(base + "/api/projects", method="OPTIONS", headers={
            "Origin": "https://easy-cfd.mthracelab.com", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        with urlopen(preflight, timeout=10) as response:
            assert response.status == 200 and response.headers["access-control-allow-origin"] == "*"
        evidence = {}
        completed_key = None
        if args.simulate:
            def write_api(path, method, body=None):
                status, _, payload = request(path, token, method, body)
                assert status in (200, 201, 202), payload
                return payload

            project = write_api("/api/projects", "POST", {"name": "Bundled MPI verification", "sample": True, "wing": args.wing})
            settings = {**project["settings"], "quality": "fast", "geometry_confirmed": True, "max_seconds": 1200}
            write_api(f"/api/projects/{project['id']}/settings", "PUT", settings)
            run = write_api(f"/api/projects/{project['id']}/runs", "POST")
            completed_key = run["id"]

            def wait_run(key, predicate, seconds=1200):
                deadline = time.monotonic() + seconds
                previous = ""
                while time.monotonic() < deadline:
                    current = request(f"/api/runs/{key}", token)[2]
                    stage = current["stage"]
                    if stage != previous:
                        print(stage, flush=True)
                        previous = stage
                    if predicate(current):
                        return current
                    assert current["status"] in ("queued", "running"), current.get("error", current["status"])
                    time.sleep(1)
                raise RuntimeError("Timed out waiting for the bundled MPI run")

            started = time.monotonic()
            complete = wait_run(completed_key, lambda value: value["status"] == "completed")
            result = complete["result"]
            assert complete["processes"] == 4
            assert math.isfinite(result["cd"]) and math.isfinite(result["cl"]) and result["cd"] > 0
            solver_log = docker("exec", name, "cat", f"/data/runs/{completed_key}/case-fast/log.simpleFoam")
            assert re.search(r"nProcs\s*:\s*4", solver_log)
            evidence = {"cells": result["cells"], "iterations": complete["iteration"], "cd": result["cd"], "cl": result["cl"], "ranks": 4,
                        "elapsedSeconds": round(time.monotonic() - started, 3), "mpiLog": "passed", "wing": args.wing}
            assert evidence["iterations"] == 300
            if args.cancel:
                write_api(f"/api/projects/{project['id']}/settings", "PUT", {**settings, "quality": "custom", "custom_mesh": "fast", "custom_iterations": 20000})
                second = write_api(f"/api/projects/{project['id']}/runs", "POST")
                wait_run(second["id"], lambda value: "Solving airflow" in value["stage"] and value["iteration"] > 0)
                affinity = docker("exec", name, "python", "-c", "import psutil; allowed=set(psutil.Process().cpu_affinity()[:4]); ranks=[p for p in psutil.process_iter(['name']) if p.info['name']=='simpleFoam']; print(len(ranks)==4 and all(set(p.cpu_affinity())<=allowed for p in ranks))")
                assert affinity == "True", "MPI ranks exceeded the job CPU allocation"
                evidence["mpiCpuAllocation"] = "passed"
                write_api(f"/api/runs/{second['id']}/cancel", "POST")
                wait_run(second["id"], lambda value: value["status"] == "cancelled", 30)
                remaining = docker("exec", name, "python", "-c", "import psutil; print([p.info['name'] for p in psutil.process_iter(['name']) if p.info['name'] in ('mpirun', 'simpleFoam', 'pimpleFoam', 'orted', 'orterun') and p.status() != psutil.STATUS_ZOMBIE])")
                assert remaining == "[]", "MPI processes survived cancellation"
                evidence["mpiCancellation"] = "passed"
        docker("restart", name)
        # Docker may allocate a new host port for an ephemeral binding on restart.
        port = docker("port", name, "8000/tcp").split(":")[-1]
        base = f"http://127.0.0.1:{port}"
        ready()
        assert docker("exec", name, "python", "-c", "from pathlib import Path; print(Path('/data/.api-token').read_text().strip())") == token
        assert request("/api/health", token)[0] == 200
        if completed_key:
            assert request(f"/api/runs/{completed_key}", token)[2]["result"]["cd"] == evidence["cd"]
            evidence["resultAfterRestart"] = "passed"
        if args.keep:
            descriptor = os.open(args.keep, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                json.dump(dict(name=name, data=data, base=base, token=token, run=completed_key), stream)
            keep_server = True
        print(json.dumps({"image": args.image, "authenticatedApi": "passed", "rejectsBadTokens": "passed",
            "cors": "passed", "persistentToken": "passed", "apiOnly": "passed", "solverReady": health["ready"],
            "noDockerSocket": "passed", "noDockerCli": "passed", "mpiSimulation": evidence}))
    finally:
        if not keep_server:
            try:
                docker("stop", "-t", "30", name)
                if not args.named_volume:
                    docker("run", "--rm", "--entrypoint", "python", "-v", f"{data}:/data", args.image,
                           "-c", "from pathlib import Path; import shutil; [shutil.rmtree(p) for p in Path('/data').iterdir() if p.is_dir()]")
            finally:
                docker("rm", "-f", name)
                if args.named_volume:
                    docker("volume", "rm", data)
                else:
                    shutil.rmtree(data)


if __name__ == "__main__":
    main()
