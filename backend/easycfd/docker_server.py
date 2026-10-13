"""Start the published server with its pinned solver available on the Docker host."""

import os
import subprocess
import sys

from .foam import IMAGE


def main():
    try:
        cached = subprocess.run(
            ["docker", "image", "inspect", IMAGE],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
        )
        if cached.returncode:
            print("Downloading OpenFOAM for first use. This can take a few minutes…", flush=True)
            # Stream Docker's progress to the user's terminal. No network access is
            # needed on later startups while this exact pinned image is cached.
            subprocess.run(["docker", "pull", IMAGE], check=True, timeout=1800)
        print("OpenFOAM is ready. Starting the EasyCFD server…", flush=True)
    except (OSError, subprocess.SubprocessError):
        print(
            "OpenFOAM setup failed. Check Docker, its socket mount and your internet connection, "
            "then run the startup command again.",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        return 130
    os.execvp("uvicorn", [
        "uvicorn", "easycfd.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log",
    ])


if __name__ == "__main__":
    sys.exit(main())
