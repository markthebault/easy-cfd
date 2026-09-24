"""Generate explicit OpenCFD v2412 dictionaries. No user strings are executed as shell code."""

import math
import shutil
from pathlib import Path
from .models import Settings, resolved_preset

IMAGE = "opencfd/openfoam-default@sha256:1ba02114b1c025c370f2e269a07677c16c9bea8d990fcd75ac8378aff9d41b50"


def domain_bounds(geometry, settings, reference_case=None):
    low, high = geometry["bounds"]
    length = high[0] - low[0]
    if settings.simulation_box is not None:
        box = settings.simulation_box
        bounds = [box.x_min, box.x_max, box.y_min, box.y_max, 0, box.z_max]
    elif reference_case == "ahmedml-run-1":
        from .benchmark import domain

        bounds = domain()
    else:
        bounds = [
            low[0] - 3 * length,
            high[0] + 6 * length,
            low[1] - 2 * length,
            high[1] + 2 * length,
            0,
            high[2] + 2 * length,
        ]
    if settings.simulation_box is not None and not (
        bounds[0] < low[0]
        and bounds[1] > high[0]
        and bounds[2] < low[1]
        and bounds[3] > high[1]
        and bounds[5] > high[2]
        and low[2] > 0
    ):
        raise ValueError(
            "Simulation box must surround the enabled geometry, with space at the inlet, outlet, sides and top. The floor stays at Z = 0."
        )
    return bounds


def mesh_layout(geometry, settings, quality=None, reference_case=None):
    bounds = domain_bounds(geometry, settings, reference_case)
    p = resolved_preset(settings, quality)
    cell = p["cell"] * (geometry["bounds"][1][0] - geometry["bounds"][0][0]) / 4.2
    counts = [math.ceil((bounds[2 * i + 1] - bounds[2 * i]) / cell) for i in range(3)]
    if math.prod(counts) > p["max_cells"] // 2:
        raise ValueError(
            "Simulation box exceeds the background mesh budget at this resolution. Reduce the box size or choose a coarser mesh."
        )
    return bounds, counts, cell


def vec(values):
    return "(" + " ".join(f"{x:.9g}" for x in values) + ")"


def write(path, content, cls="dictionary", dimensions=None, internal=None):
    header = f"FoamFile {{ version 2.0; format ascii; class {cls}; object {path.name}; }}\n"
    if dimensions is not None:
        header += f"dimensions [{dimensions}];\ninternalField uniform {internal};\n"
    path.write_text(header + content + "\n")


def generate(
    case: Path,
    geometry_folder: Path,
    geometry: dict,
    settings: Settings,
    quality=None,
    reference_case=None,
    processes=4,
):
    p = resolved_preset(settings, quality)
    first_layer = 2 * 100 * 1.5e-5 / (0.05 * settings.speed_kmh / 3.6)
    for name in ("0", "system", "constant/triSurface"):
        (case / name).mkdir(parents=True, exist_ok=True)
    for part in geometry["parts"]:
        shutil.copy2(geometry_folder / f"{part['id']}.stl", case / "constant/triSurface")
    low, high = geometry["bounds"]
    length = high[0] - low[0]
    width = high[1] - low[1]
    bounds, counts, cell = mesh_layout(geometry, settings, quality, reference_case)
    xmin, xmax, ymin, ymax, _, zmax = bounds
    cross_section = (ymax - ymin) * zmax
    blockage_ratio = settings.reference_area / cross_section
    vertices = [
        (xmin, ymin, 0),
        (xmax, ymin, 0),
        (xmax, ymax, 0),
        (xmin, ymax, 0),
        (xmin, ymin, zmax),
        (xmax, ymin, zmax),
        (xmax, ymax, zmax),
        (xmin, ymax, zmax),
    ]
    write(
        case / "system/blockMeshDict",
        f"""
scale 1;
vertices ({" ".join(vec(v) for v in vertices)});
blocks (hex (0 1 2 3 4 5 6 7) {vec(counts)} simpleGrading (1 1 1));
edges ();
boundary (
inlet {{type patch; faces ((0 4 7 3));}}
outlet {{type patch; faces ((1 2 6 5));}}
sides {{type patch; faces ((0 1 5 4) (3 7 6 2));}}
top {{type symmetryPlane; faces ((4 5 6 7));}}
ground {{type wall; faces ((0 3 2 1));}}
);
mergePatchPairs ();
""",
    )
    surfaces = "\n".join(
        f"{part['id']}.stl {{type triSurfaceMesh; name {part['id']};}}" for part in geometry["parts"]
    )
    refinement_entries = []
    for part in geometry["parts"]:
        # Resolve an estimated thin dimension with at least two cells. This estimate
        # cannot detect every small local feature, so results still need mesh review.
        thickness = part.get("minimum_extent", min(b - a for a, b in zip(*part["bounds"])))
        level = max(p["surface"], math.ceil(math.log2(2 * cell / max(thickness, 1e-9))))
        if level > 7:
            raise ValueError(
                f"{part['name']} is too thin for this preset's automatic mesh. Simplify the geometry."
            )
        refinement_entries.append(f"{part['id']} {{level ({level} {level}); patchInfo {{type wall;}}}}")
    refinements = "\n".join(refinement_entries)
    # checkMesh's basic geometry check uses skewness 4 even on boundary faces.
    # Enforce that during meshing too, instead of allowing faces the final gate rejects.
    write(
        case / "system/snappyHexMeshDict",
        f"""
castellatedMesh true; snap true; addLayers {"true" if p["layers"] else "false"};
geometry {{
{surfaces}
wake {{type searchableBox; min {vec([low[0] - 0.3 * length, low[1] - 0.35 * width, 0.001])};
max {vec([high[0] + 2 * length, high[1] + 0.35 * width, high[2] + 0.4 * length])};}}
}}
castellatedMeshControls {{
maxLocalCells {p["max_cells"]}; maxGlobalCells {p["max_cells"]}; minRefinementCells 0;
maxLoadUnbalance .1; nCellsBetweenLevels 3; features ();
refinementSurfaces {{{refinements}}}
resolveFeatureAngle 30;
refinementRegions {{wake {{mode inside; levels ((1e15 {p["wake"]}));}}}}
locationInMesh {vec([xmin + 0.314 * min(cell, low[0] - xmin), ymin + 0.271 * min(cell, low[1] - ymin), 0.419 * cell])};
allowFreeStandingZoneFaces true;
}}
snapControls {{nSmoothPatch 3; tolerance 2; nSolveIter 30; nRelaxIter 5;
nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false;}}
addLayersControls {{
relativeSizes false;
layers {{"part.*" {{nSurfaceLayers {p["layers"]};}}}}
expansionRatio 1.25; firstLayerThickness {first_layer}; minThickness {first_layer * 0.8};
nGrow 0; featureAngle 60; slipFeatureAngle 30; nRelaxIter 5;
nSmoothSurfaceNormals 3; nSmoothNormals 5; nSmoothThickness 10;
maxFaceThicknessRatio .5; maxThicknessToMedialRatio .3; minMedialAxisAngle 90;
nBufferCellsNoExtrude 1; nLayerIter 100; nRelaxedIter 100;
}}
meshQualityControls {{
maxNonOrtho 65; maxBoundarySkewness 4; maxInternalSkewness 4;
maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1;
minTwist .02; minDeterminant .001; minFaceWeight .02; minVolRatio .01; minTriangleTwist -1;
nSmoothScale 4; errorReduction .75;
}}
writeFlags (scalarLevels layerSets layerFields);
mergeTolerance 1e-6;
""",
    )
    speed = settings.speed_kmh / 3.6
    yaw = math.radians(settings.yaw_deg)
    # X is longitudinal drag, Z is lift. The ground travels with road speed, not crosswind.
    velocity = [speed, speed * math.tan(yaw), 0]
    mag = math.hypot(velocity[0], velocity[1])
    k = 1.5 * (mag * 0.01) ** 2  # 1% inlet turbulence, recorded as an assumption.
    omega = math.sqrt(k) / (0.09**0.25 * 0.07 * length)
    if reference_case == "ahmedml-run-1":
        k, omega = 0.000054 * speed**2, 14.4 * speed
    patches = " ".join(part["id"] for part in geometry["parts"])
    # Per-role integrated forces give the body/wheel and pressure/viscous split.
    # The groups always partition every car patch, so their sum must reconcile
    # with the total coefficients; results.py checks that agreement.
    role_functions = ""
    for name, group in (
        ("forcesBody", " ".join(p["id"] for p in geometry["parts"] if p["role"] != "wheel")),
        ("forcesWheels", " ".join(p["id"] for p in geometry["parts"] if p["role"] == "wheel")),
    ):
        if group:
            role_functions += f"""{name} {{type forces; libs (forces); patches ({group});
p p; U U; rho rhoInf; rhoInf {settings.density}; CofR (0 0 0);
writeControl timeStep; writeInterval 1; log false;}}
"""
    write(
        case / "system/controlDict",
        f"""
application simpleFoam; startFrom startTime; startTime 0; stopAt endTime;
endTime {p["iterations"]}; deltaT 1; writeControl timeStep; writeInterval {p["iterations"] if (quality or settings.quality) == "custom" else 100};
purgeWrite 2; writeFormat binary; writePrecision 10; writeCompression off;
timeFormat general; timePrecision 6; runTimeModifiable false;
functions {{
coefficients {{type forceCoeffs; libs (forces); patches ({patches});
p p; U U; rho rhoInf; rhoInf {settings.density};
CofR (0 0 0); liftDir (0 0 1); dragDir (1 0 0); pitchAxis (0 1 0);
magUInf {mag}; lRef {length}; Aref {settings.reference_area};
writeControl timeStep; writeInterval 1; log true;}}
{role_functions}yPlus {{type yPlus; libs (fieldFunctionObjects); writeControl writeTime;}}
}}
""",
    )
    write(
        case / "system/meshQualityDict",
        """
maxNonOrtho 65; maxBoundarySkewness 4; maxInternalSkewness 4;
maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1;
minTwist .02; minDeterminant .001; minFaceWeight .02; minVolRatio .01; minTriangleTwist -1;
""",
    )
    write(case / "system/decomposeParDict", f"numberOfSubdomains {processes}; method scotch;")
    write(
        case / "system/fvSchemes",
        """
ddtSchemes {default steadyState;}
gradSchemes {default Gauss linear; grad(U) cellLimited Gauss linear 1;}
divSchemes {default none; div(phi,U) bounded Gauss linearUpwindV grad(U);
div(phi,k) bounded Gauss upwind; div(phi,omega) bounded Gauss upwind;
div((nuEff*dev2(T(grad(U))))) Gauss linear;}
laplacianSchemes {default Gauss linear limited 0.5;}
interpolationSchemes {default linear;}
snGradSchemes {default limited 0.5;}
wallDist {method meshWave;}
""",
    )
    # Fixed iteration budget lets us assess force stability separately from residual convergence.
    write(
        case / "system/fvSolution",
        """
solvers {
p {solver GAMG; tolerance 1e-7; relTol .05; smoother GaussSeidel;}
"(U|k|omega)" {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol .1;}
}
SIMPLE {nNonOrthogonalCorrectors 1; consistent yes;}
relaxationFactors {fields {p .3;} equations {U .7; k .7; omega .7;}}
""",
    )
    write(case / "constant/transportProperties", "transportModel Newtonian;\nnu [0 2 -1 0 0 0 0] 1.5e-5;")
    write(
        case / "constant/turbulenceProperties",
        "simulationType RAS;\nRAS {RASModel kOmegaSST; turbulence on; printCoeffs on;}",
    )
    for field, dim, initial in [
        ("U", "0 1 -1 0 0 0 0", vec(velocity)),
        ("p", "0 2 -2 0 0 0 0", "0"),
        ("k", "0 2 -2 0 0 0 0", str(k)),
        ("omega", "0 0 -1 0 0 0 0", str(omega)),
        ("nut", "0 2 -1 0 0 0 0", "0"),
    ]:
        if field == "U":
            boundaries = f"inlet {{type fixedValue; value uniform {initial};}}\noutlet {{type inletOutlet; inletValue uniform {initial}; value uniform {initial};}}\nsides {{type freestream; freestreamValue uniform {initial};}}\n"
        elif field == "p":
            boundaries = "inlet {type zeroGradient;}\noutlet {type fixedValue; value uniform 0;}\nsides {type freestreamPressure; freestreamValue uniform 0;}\n"
        elif field in ("k", "omega"):
            boundaries = f"inlet {{type fixedValue; value uniform {initial};}}\noutlet {{type inletOutlet; inletValue uniform {initial}; value uniform {initial};}}\nsides {{type inletOutlet; inletValue uniform {initial}; value uniform {initial};}}\n"
        else:
            boundaries = "inlet {type calculated; value uniform 0;} outlet {type calculated; value uniform 0;} sides {type calculated; value uniform 0;}\n"
        boundaries += "top {type symmetryPlane;}\n"
        for part in [dict(id="ground", role="ground")] + geometry["parts"]:
            if field == "U":
                if part["role"] == "ground":
                    condition = f"type fixedValue; value uniform {vec([speed if settings.moving_ground else 0, 0, 0])};"
                elif part["role"] == "wheel" and settings.wheels and part.get("wheel"):
                    wheel = part["wheel"]
                    condition = f"type rotatingWallVelocity; origin {vec(wheel['center'])}; axis (0 1 0); omega {-speed / wheel['radius']}; value uniform (0 0 0);"
                else:
                    condition = "type noSlip;"
            elif field == "p":
                condition = "type zeroGradient;"
            else:
                walltype = dict(k="kqRWallFunction", omega="omegaWallFunction", nut="nutkWallFunction")[field]
                condition = f"type {walltype}; value uniform {initial};"
            boundaries += f"{part['id']} {{{condition}}}\n"
        write(
            case / "0" / field,
            "boundaryField {\n" + boundaries + "}",
            "volVectorField" if field == "U" else "volScalarField",
            dim,
            initial,
        )
    (case / "case.foam").touch()
    return dict(
        domain=[xmin, xmax, ymin, ymax, 0, zmax],
        velocity=velocity,
        freestream=mag,
        base_cells=math.prod(counts),
        preset=p,
        processes=processes,
        tunnel_cross_section=cross_section,
        blockage_ratio=blockage_ratio,
    )
