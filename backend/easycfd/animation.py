"""A separate physical-time continuation; steady force/surface snapshots stay untouched."""

import hashlib
import json
import re
import shutil
from pathlib import Path
from . import foam

FRAMES = 48
PASSES = 12
POINTS = 120_000


def prepare(source: Path, case: Path, length: float, freestream: float, run=None, metadata=None):
    times = [p for p in source.iterdir() if p.is_dir() and re.fullmatch(r"[\d.eE+-]+", p.name)]
    solved = max(times, key=lambda p: float(p.name))
    if float(solved.name) <= 0:
        raise ValueError("Flow animation needs a solved warm-up field.")
    for name in ("constant", "system"):
        shutil.copytree(source / name, case / name)
    shutil.copytree(solved, case / "0")
    # A steady checkpoint carries its iteration clock; never reuse it as physical time.
    shutil.rmtree(case / "0/uniform", ignore_errors=True)
    duration = PASSES * length / freestream
    interval = duration / (FRAMES - 1)
    # Adaptive physical time, bounded Courant number, all requested frames retained.
    foam.write(
        case / "system/controlDict",
        f"""
application pimpleFoam; startFrom startTime; startTime 0; stopAt endTime;
endTime {duration:.12g}; deltaT {interval / 10:.12g};
adjustTimeStep yes; maxCo 0.5; maxDeltaT {interval / 2:.12g};
writeControl adjustableRunTime; writeInterval {interval:.12g}; purgeWrite 0;
writeFormat binary; writePrecision 10; writeCompression off;
timeFormat general; timePrecision 12; runTimeModifiable true;
functions {{}}
""",
    )
    schemes = (case / "system/fvSchemes").read_text().replace("default steadyState;", "default backward;")
    (case / "system/fvSchemes").write_text(schemes.replace("bounded Gauss", "Gauss"))
    foam.write(
        case / "system/fvSolution",
        """
solvers {
p {solver GAMG; tolerance 1e-7; relTol .01; smoother GaussSeidel;}
pFinal {$p; relTol 0;}
"(U|k|omega)" {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol .1;}
"(U|k|omega)Final" {$U; relTol 0;}
}
PIMPLE {nOuterCorrectors 2; nCorrectors 2; nNonOrthogonalCorrectors 1; momentumPredictor yes;}
relaxationFactors {equations {".*" 1;}}
""",
    )
    (case / "case.foam").touch()
    if run and run["settings"].get("flow_detail") == "fine":
        from .fineflow import configure

        return configure(case, run["geometry"], metadata, length, freestream)
    return dict(duration=duration, interval=interval)


def record(key, source, output, run, metadata, length):
    from . import runner

    case = output.parent / "animation-case"
    plan = prepare(source, case, length, metadata["freestream"], run, metadata)
    if run.get("recording_source"):
        plan["continuation"] = dict(
            source_run=run["recording_source"], initialization="steady", physical_time=0
        )
    (case / "recording.json").write_text(json.dumps(plan))
    runner.patch(key, recording_time_seconds=0, recording_duration_seconds=plan["duration"])
    ranks, cpus = run.get("processes", 4), run.get("cpus", 4)
    memory = metadata["preset"]["memory_gb"]
    (case / "metadata.json").write_text((source / "metadata.json").read_text())
    for command in [
        ["decomposePar", "-force"],
        ["mpirun", "--allow-run-as-root", "--oversubscribe", "-np", str(ranks), "pimpleFoam", "-parallel"],
        ["reconstructPar", "-newTimes"],
    ]:
        runner.stage(key, case, command, "Recording flow animation", memory, cpus)
    for folder in runner.redundant_processor_copies(case):
        shutil.rmtree(folder)
    runner.patch(key, stage="Preparing flow animation")
    return runner.extract_case(key, case, output, run, module="easycfd.animation_worker")


def physical_checkpoint(case: Path):
    def complete(folder):
        return {
            float(p.name)
            for p in folder.iterdir()
            if p.is_dir()
            and re.fullmatch(r"[\d.eE+-]+", p.name)
            and all((p / name).is_file() for name in ("U", "p", "k", "omega"))
        }

    times = complete(case)
    processors = sorted(p for p in case.glob("processor*") if p.is_dir())
    if processors:
        times |= set.intersection(*(complete(p) for p in processors))
    if not times or max(times) <= 0:
        raise ValueError("Detailed recording has no complete physical-time checkpoint to continue.")
    return max(times)


def prepare_resume(source: Path, case: Path, source_key: str):
    """Clone a physical checkpoint and its native sections; never modify its parent."""
    checkpoint = physical_checkpoint(source)
    shutil.copytree(source, case, ignore=shutil.ignore_patterns("log.*"))
    plan = json.loads((case / "recording.json").read_text())
    control = case / "system/controlDict"
    text = re.sub(r"startFrom\s+\w+;", "startFrom latestTime;", control.read_text())
    text = re.sub(r"stopAt\s+\w+;", "stopAt endTime;", text)
    control.write_text(text)
    # Recompute sections newer than the checkpoint in the child. Keeping their
    # jittered timestamps would otherwise duplicate frames after a restart.
    for folder in [case, *case.glob("processor*"), case / "postProcessing/fineSections"]:
        if folder.is_dir():
            for p in folder.iterdir():
                if p.is_dir() and re.fullmatch(r"[\d.eE+-]+", p.name) and float(p.name) > checkpoint + 1e-12:
                    shutil.rmtree(p)
    plan["continuation"] = dict(
        source_run=source_key,
        physical_time=checkpoint,
        control_sha256=hashlib.sha256(control.read_bytes()).hexdigest(),
    )
    (case / "recording.json").write_text(json.dumps(plan))
    (case / "case.foam").touch()
    return plan


def continue_recording(key, run):
    from . import runner, storage

    root = storage.directory("runs", key)
    parent = storage.directory("runs", run["recording_source"])
    if run.get("recording_restart"):
        source = parent / "case-medium"
        result = json.loads((root / "results/summary.json").read_text())
        metadata = json.loads((source / "metadata.json").read_text())
        length = run["geometry"]["bounds"][1][0] - run["geometry"]["bounds"][0][0]
        result["flow_animation"] = record(key, source, root / "animation", run, metadata, length)
        result["flow_animation"]["continuation"] = dict(
            source_run=run["recording_source"], initialization="steady", physical_time=0
        )
        return result
    source = parent / "animation-case"
    case = root / "animation-case"
    plan = prepare_resume(source, case, run["recording_source"])
    runner.patch(
        key,
        recording_time_seconds=plan["continuation"]["physical_time"],
        recording_duration_seconds=plan["duration"],
    )
    ranks, cpus = run["processes"], run["cpus"]
    memory = 6
    if list(case.glob("processor*")):
        runner.stage(key, case, ["reconstructPar", "-latestTime"], "Recovering flow checkpoint", memory, cpus)
    if plan["continuation"]["physical_time"] < plan["duration"] - 1e-9:
        for command in [
            ["decomposePar", "-force", "-latestTime"],
            [
                "mpirun",
                "--allow-run-as-root",
                "--oversubscribe",
                "-np",
                str(ranks),
                "pimpleFoam",
                "-parallel",
            ],
            ["reconstructPar", "-newTimes"],
        ]:
            runner.stage(key, case, command, "Continuing detailed flow recording", memory, cpus)
    for folder in runner.redundant_processor_copies(case):
        shutil.rmtree(folder)
    runner.patch(key, stage="Preparing detailed flow recording")
    result = json.loads((root / "results/summary.json").read_text())
    result["flow_animation"] = runner.extract_case(
        key, case, root / "animation", run, module="easycfd.animation_worker"
    )
    result["flow_animation"]["continuation"] = plan["continuation"]
    return result
