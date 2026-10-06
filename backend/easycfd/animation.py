"""A separate physical-time continuation; steady force/surface snapshots stay untouched."""

import re
import shutil
from pathlib import Path
from . import foam

FRAMES = 48
PASSES = 12
POINTS = 120_000


def prepare(source: Path, case: Path, length: float, freestream: float):
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
    foam.write(case / "system/controlDict", f"""
application pimpleFoam; startFrom startTime; startTime 0; stopAt endTime;
endTime {duration:.12g}; deltaT {interval / 10:.12g};
adjustTimeStep yes; maxCo 0.5; maxDeltaT {interval / 2:.12g};
writeControl adjustableRunTime; writeInterval {interval:.12g}; purgeWrite 0;
writeFormat binary; writePrecision 10; writeCompression off;
timeFormat general; timePrecision 12; runTimeModifiable true;
functions {{}}
""")
    schemes = (case / "system/fvSchemes").read_text().replace("default steadyState;", "default backward;")
    (case / "system/fvSchemes").write_text(schemes.replace("bounded Gauss", "Gauss"))
    foam.write(case / "system/fvSolution", """
solvers {
p {solver GAMG; tolerance 1e-7; relTol .01; smoother GaussSeidel;}
pFinal {$p; relTol 0;}
"(U|k|omega)" {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol .1;}
"(U|k|omega)Final" {$U; relTol 0;}
}
PIMPLE {nOuterCorrectors 2; nCorrectors 2; nNonOrthogonalCorrectors 1; momentumPredictor yes;}
relaxationFactors {equations {".*" 1;}}
""")
    (case / "case.foam").touch()
    return dict(duration=duration, interval=interval)


def record(key, source, output, run, metadata, length):
    from . import runner

    case = source.parent / "animation-case"
    prepare(source, case, length, metadata["freestream"])
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
