"""Eddy-resolving recording and native-mesh sections, bounded independently of the viewer."""

import hashlib
import math
from pathlib import Path
import numpy as np
from . import foam

FRAMES = 192
WARMUP_PASSES = 8
RECORD_PASSES = 4
MAX_SECTION_POINTS = 150_000
MODEL = "DDES · k–ω SST"


def sections(geometry, domain):
    low, high = np.array(geometry["bounds"], dtype=float)
    length, width, height = high - low
    origin = np.array([max(domain[0], low[0] - 0.35 * length), max(domain[2], low[1] - 0.45 * length), 0.0])
    end = np.array(
        [
            min(domain[1], high[0] + 1.5 * length),
            min(domain[3], high[1] + 0.45 * length),
            min(domain[5], high[2] + 0.2 * length),
        ]
    )
    result = []
    for name, label, axis, position in [
        ("top", "Body height", 2, low[2] + 0.45 * height),
        ("upper", "Upper body", 2, low[2] + 0.8 * height),
        ("side", "Centreline", 1, (low[1] + high[1]) / 2),
        ("wheels", "Wheel wake", 1, low[1] + 0.1 * width),
    ]:
        lo, hi = origin.copy(), end.copy()
        lo[axis] = hi[axis] = position
        ext = hi - lo
        h = max(length / 240, math.sqrt(float(np.prod(ext[ext > 0])) / (MAX_SECTION_POINTS - 2000)))
        dims = [1 if a == axis else max(2, math.ceil(ext[a] / h) + 1) for a in range(3)]
        spacing = [1.0 if a == axis else ext[a] / (dims[a] - 1) for a in range(3)]
        if math.prod(dims) > MAX_SECTION_POINTS:
            raise ValueError("Detailed section exceeded its point budget.")
        result.append(
            dict(
                id=name,
                label=label,
                axis=axis,
                position=float(position),
                origin=lo.tolist(),
                spacing=spacing,
                dims=dims,
            )
        )
    return result


def configure(case, geometry, meta, length, freestream):
    warmup = WARMUP_PASSES * length / freestream
    clip = RECORD_PASSES * length / freestream
    interval = clip / (FRAMES - 1)
    preset = meta.get("preset", dict(cell=0.5, surface=4))
    background = preset["cell"] * length / 4.2
    widths = np.diff(np.array(meta["domain"]).reshape(3, 2), axis=1).ravel()
    wake_spacing = float(np.min(widths / np.ceil(widths / background))) / 2 ** preset["surface"]
    # Implicit pressure coupling can tolerate the limiting RANS wall cells at a
    # larger Courant number. A separate wake-cell cap protects resolved motion.
    max_delta = min(interval / 2, 0.35 * wake_spacing / freestream)
    planes = sections(geometry, meta["domain"])
    descriptions = []
    for p in planes:
        normal = [0, 0, 0]
        normal[p["axis"]] = 1
        descriptions.append(f"""{p["id"]} {{type cuttingPlane; planeType pointAndNormal;
pointAndNormalDict {{point {foam.vec(p["origin"])}; normal {foam.vec(normal)};}}
interpolate true;}}""")
    foam.write(
        case / "system/controlDict",
        f"""
application pimpleFoam; startFrom startTime; startTime 0; stopAt endTime;
endTime {warmup + clip:.12g}; deltaT {interval / 4:.12g};
adjustTimeStep yes; maxCo 2; maxDeltaT {max_delta:.12g};
writeControl adjustableRunTime; writeInterval {2 * length / freestream:.12g}; purgeWrite 2;
writeFormat binary; writePrecision 10; writeCompression off;
timeFormat general; timePrecision 12; runTimeModifiable true;
libs (turbulenceModelSchemes);
functions {{ fineSections {{type surfaces; libs (sampling);
executeControl timeStep; executeInterval 1;
writeControl runTime; writeInterval {interval:.12g}; timeStart {warmup:.12g};
surfaceFormat vtk; interpolationScheme cellPoint; fields (U p k);
surfaces {{ {" ".join(descriptions)} }}
}} }}
""",
    )
    # Use the model/delta combination shipped in the pinned v2412 wallMountedHump tutorial.
    foam.write(
        case / "constant/turbulenceProperties",
        """
simulationType LES;
LES {LESModel kOmegaSSTDDES; turbulence on; printCoeffs on;
kOmegaSSTDDESCoeffs {useSigma true;} delta DeltaOmegaTilde; DeltaOmegaTildeCoeffs {}}
""",
    )
    foam.write(
        case / "system/fvSchemes",
        f"""
ddtSchemes {{default backward;}}
gradSchemes {{default Gauss linear;}}
divSchemes {{default none;
div(phi,U) Gauss DEShybrid linear linearUpwind grad(U) delta 0.65 {freestream:.9g} {length:.9g} 0 1 1 10;
div(phi,k) Gauss limitedLinear 1; div(phi,omega) Gauss limitedLinear 1;
div((nuEff*dev2(T(grad(U))))) Gauss linear;}}
laplacianSchemes {{default Gauss linear limited 0.5;}}
interpolationSchemes {{default linear;}} snGradSchemes {{default limited 0.5;}}
wallDist {{method meshWave;}}
""",
    )
    solution = case / "system/fvSolution"
    solution.write_text(
        solution.read_text()
        .replace("nOuterCorrectors 2", "nOuterCorrectors 1")
        .replace("tolerance 1e-7", "tolerance 1e-6")
    )
    return dict(
        duration=warmup + clip,
        interval=interval,
        warmup=warmup,
        sections=planes,
        frames=FRAMES,
        model=MODEL,
        integration=dict(
            max_courant=2,
            wake_courant_cap=0.35,
            wake_spacing=wake_spacing,
            max_delta_t=max_delta,
            pressure_tolerance=1e-6,
        ),
        source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        dictionaries_sha256={
            name: hashlib.sha256((case / name).read_bytes()).hexdigest()
            for name in (
                "system/controlDict",
                "system/fvSchemes",
                "system/fvSolution",
                "constant/turbulenceProperties",
            )
        },
    )
