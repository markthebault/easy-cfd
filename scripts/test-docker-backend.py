#!/usr/bin/env python3
"""Exercise the built API image without logging its generated connection token."""
import argparse
import json
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
    parser.add_argument("--solver", action="store_true", help="Check the real host solver through its Docker socket")
    args = parser.parse_args()
    name = "easycfd-image-test-" + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix=".easycfd-image-test-", dir=Path.home()) as data:
        command = ["run", "-d", "--name", name, "--init", "-p", "127.0.0.1::8000", "-v", f"{data}:/data"]
        if args.solver:
            command += ["-v", "/var/run/docker.sock:/var/run/docker.sock", "-e", f"EASYCFD_HOST_DATA={data}"]
        docker(*command, args.image)
        try:
            port = docker("port", name, "8000/tcp").split(":")[-1]
            base = f"http://127.0.0.1:{port}"

            def request(path, token="", method="GET"):
                req = Request(base + path, method=method, headers={"Origin": "https://easy-cfd.mthracelab.com", "Authorization": "Bearer " + token})
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
            assert token in docker("logs", name)  # URL is printed, but never echoed by this test.
            assert request("/api/health", "wrong")[0] == 401
            status, headers, health = request("/api/health", token)
            assert status == 200 and headers["access-control-allow-origin"] == "*"
            if args.solver:
                assert health["ready"], health.get("message")
            assert request("/api/runs", token)[0] == 200
            assert request("/", token)[0] == 404
            preflight = Request(base + "/api/projects", method="OPTIONS", headers={
                "Origin": "https://easy-cfd.mthracelab.com", "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            })
            with urlopen(preflight, timeout=10) as response:
                assert response.status == 200 and response.headers["access-control-allow-origin"] == "*"
            docker("restart", name)
            # Docker may allocate a new host port for an ephemeral binding on restart.
            port = docker("port", name, "8000/tcp").split(":")[-1]
            base = f"http://127.0.0.1:{port}"
            ready()
            assert docker("exec", name, "python", "-c", "from pathlib import Path; print(Path('/data/.api-token').read_text().strip())") == token
            assert request("/api/health", token)[0] == 200
            print(json.dumps({"image": args.image, "authenticatedApi": "passed", "rejectsBadTokens": "passed",
                "cors": "passed", "persistentToken": "passed", "apiOnly": "passed", "solverReady": health["ready"]}))
        finally:
            docker("rm", "-f", name)


if __name__ == "__main__":
    main()
