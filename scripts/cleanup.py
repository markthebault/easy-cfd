"""Reclaim disk space from runs saved before per-rank cleanup: uv run python scripts/cleanup.py.

Removes OpenFOAM processor* folders from completed runs (their reconstructed case
holds the same data) and leftover run.zip exports. Failed and cancelled runs keep
their processor folders, which may hold the only solver output. Reports only;
pass --apply to delete.
"""

import argparse
import shutil
from easycfd import runner, storage

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--apply", action="store_true", help="delete the listed folders and files")
args = parser.parse_args()


def size(path):
    return path.stat().st_size if path.is_file() else runner.disk_bytes(path)


total = 0
for run in storage.all_records("runs"):
    root = storage.directory("runs", run["id"])
    targets = [root / "run.zip"] if (root / "run.zip").exists() else []
    if run["status"] == "completed":
        targets += sorted(root.glob("case-*/processor*"))
    if not targets:
        continue
    freed = sum(size(path) for path in targets)
    total += freed
    print(f"{run['id']}  {run['name'][:40]:40}  {freed / 1024**2:8.1f} MB  ({len(targets)} items)")
    if args.apply:
        for path in targets:
            shutil.rmtree(path) if path.is_dir() else path.unlink()
        if run["status"] == "completed":
            storage.update("runs", run["id"], disk_bytes=runner.disk_bytes(root))
print(f"{'Freed' if args.apply else 'Reclaimable'}: {total / 1024**3:.2f} GB")
if not args.apply and total:
    print("Run again with --apply to delete.")
