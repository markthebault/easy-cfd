"""Start the self-contained OpenFOAM/MPI backend without a Docker socket."""

import os
import sys

from . import local_solver


def main():
    status = local_solver.health()
    if not status["ready"]:
        print(status["message"], file=sys.stderr)
        return 1
    print("Bundled OpenFOAM v2412 and MPI are ready. Starting EasyCFD…", flush=True)
    os.execvp("uvicorn", [
        "uvicorn", "easycfd.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log",
    ])


if __name__ == "__main__":
    sys.exit(main())
