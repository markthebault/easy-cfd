"""Reclaim disk space from runs saved before per-rank cleanup: uv run python scripts/cleanup.py.

Removes leftover run.zip exports, and OpenFOAM processor* folders of completed
runs once every time they hold also exists in the reconstructed case. Runs from
earlier versions reconstructed only the latest time, so their processor folders
still hold the only copy of an earlier one; they are kept unless --reconstruct
first rebuilds those times in the solver container. Failed and cancelled runs
are never touched. Reports only; pass --apply to change anything.
"""

import argparse
import shutil
import subprocess
from easycfd import runner, storage
from easycfd.models import PRESETS

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--apply", action="store_true", help="delete the listed folders and files")
parser.add_argument(
    "--reconstruct",
    action="store_true",
    help="with --apply, reconstruct unreconstructed times (needs Docker) before deleting their copies",
)
args = parser.parse_args()


def size(path):
    return path.stat().st_size if path.is_file() else runner.disk_bytes(path)


def reconstruct(run, case):
    tier = case.name.removeprefix("case-")
    cpus = min(4, int(runner.health().get("cpus") or 4))
    with (case / "log.reconstructPar.cleanup").open("w") as log:
        command = runner.container(
            f"easycfd-cleanup-{run['id']}", case, ["reconstructPar", "-newTimes"], PRESETS[tier]["memory_gb"], cpus
        )
        return subprocess.run(command, stdout=log, stderr=subprocess.STDOUT).returncode == 0


total, kept = 0, 0
for run in storage.all_records("runs"):
    root = storage.directory("runs", run["id"])
    before = runner.disk_bytes(root)
    targets = [root / "run.zip"] if (root / "run.zip").exists() else []
    unique = []
    if run["status"] == "completed":
        for case in sorted(root.glob("case-*")):
            copies = runner.redundant_processor_copies(case)
            if copies:
                targets += copies
            elif any(case.glob("processor*")):
                unique.append(case)
    if args.apply and args.reconstruct:
        for case in unique:
            print(f"{run['id']}  reconstructing {case.name}…", flush=True)
            if reconstruct(run, case) and (copies := runner.redundant_processor_copies(case)):
                targets += copies
            else:
                print(f"{run['id']}  {case.name}: reconstruction incomplete; see log.reconstructPar.cleanup")
        unique = [case for case in unique if not runner.redundant_processor_copies(case)]
    for case in unique:
        kept += sum(size(path) for path in case.glob("processor*"))
        print(f"{run['id']}  {case.name}: kept, processor folders hold unreconstructed times")
    if not targets:
        continue
    freed = sum(size(path) for path in targets)
    if args.apply:
        for path in targets:
            shutil.rmtree(path) if path.is_dir() else path.unlink()
        after = runner.disk_bytes(root)
        # Net of any times reconstructed above, which take their own space.
        freed = before - after
        if run["status"] == "completed":
            storage.update("runs", run["id"], disk_bytes=after)
    total += freed
    print(f"{run['id']}  {run['name'][:40]:40}  {freed / 1024**2:8.1f} MB  ({len(targets)} items)")
print(f"{'Freed' if args.apply else 'Reclaimable'}: {total / 1024**3:.2f} GB")
if kept:
    print(f"Kept {kept / 1024**3:.2f} GB of processor folders holding unreconstructed times.")
    print("Use --apply --reconstruct to rebuild those times first, then remove the copies.")
if not args.apply and total:
    print("Run again with --apply to delete.")
