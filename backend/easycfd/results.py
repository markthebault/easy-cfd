"""Extract real OpenFOAM fields; never substitute illustrative physics."""

from pathlib import Path
import math
import re
import numpy as np
import vtk
from vtk.util.numpy_support import vtk_to_numpy, numpy_to_vtk


def write_poly(poly, path):
    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(poly)
    writer.SetHeaderTypeToUInt64()
    writer.SetDataModeToBinary()
    writer.SetCompressorTypeToNone()
    if not writer.Write():
        raise RuntimeError("Could not write visualization data")


def named_blocks(root):
    for i in range(root.GetNumberOfBlocks()):
        block = root.GetBlock(i)
        if block is None:
            continue
        name = root.GetMetaData(i).Get(vtk.vtkCompositeDataSet.NAME()) or ""
        if isinstance(block, vtk.vtkMultiBlockDataSet):
            yield from named_blocks(block)
        else:
            yield name, block


def add_fields(dataset, density):
    converted = vtk.vtkCellDataToPointData()
    converted.SetInputData(dataset)
    converted.PassCellDataOn()
    converted.Update()
    result = converted.GetOutput().NewInstance()
    result.DeepCopy(converted.GetOutput())
    for attrs in (result.GetPointData(), result.GetCellData()):
        for source, name, factor in [("p", "Pressure", density), ("k", "Turbulence", 1)]:
            a = attrs.GetArray(source)
            if a is not None:
                values = vtk_to_numpy(a) * factor
                if not np.isfinite(values).all():
                    raise RuntimeError("Solver produced non-finite fields; results cannot be displayed.")
                b = numpy_to_vtk(values, deep=True)
                b.SetName(name)
                attrs.AddArray(b)
        u = attrs.GetArray("U")
        if u is not None:
            values = np.linalg.norm(vtk_to_numpy(u), axis=1)
            if not np.isfinite(values).all():
                raise RuntimeError("Solver produced non-finite velocity.")
            b = numpy_to_vtk(values, deep=True)
            b.SetName("Speed")
            attrs.AddArray(b)
            attrs.SetActiveVectors("U")
    return result


def coefficients(case, settings, freestream):
    candidates = list((case / "postProcessing/coefficients").glob("*/coefficient.dat"))
    if not candidates:
        raise RuntimeError("OpenFOAM did not produce force coefficients.")
    lines = candidates[0].read_text().splitlines()
    header = next((line.lstrip("# ").split() for line in lines if line.startswith("# Time")), None)
    if header is None:
        raise RuntimeError("Unrecognized OpenFOAM coefficient header.")
    rows = np.array([[float(x) for x in line.split()] for line in lines if line and not line.startswith("#")])
    if not np.isfinite(rows).all() or len(rows) < 2:
        raise RuntimeError("Force results are missing or non-finite.")
    cd, cl = rows[:, header.index("Cd")], rows[:, header.index("Cl")]
    q_area = 0.5 * settings["density"] * freestream**2 * settings["reference_area"]
    n = min(50, len(rows))
    mean_cd, mean_cl = float(cd[-n:].mean()), float(cl[-n:].mean())
    spread_cd, spread_cl = float(np.ptp(cd[-n:])), float(np.ptp(cl[-n:]))
    settled = (
        len(rows) >= 100
        and spread_cd < 0.02 * max(abs(mean_cd), 0.01)
        and spread_cl < 0.02 * max(abs(mean_cl), 0.01)
    )
    history = [
        dict(
            iteration=float(row[0]),
            cd=float(d),
            cl=float(lift),
            drag=float(d * q_area),
            downforce=float(-lift * q_area),
        )
        for row, d, lift in zip(rows, cd, cl)
    ]
    return dict(
        cd=mean_cd,
        cl=mean_cl,
        drag=mean_cd * q_area,
        downforce=-mean_cl * q_area,
        force_settled=bool(settled),
        cd_span=spread_cd,
        cl_span=spread_cl,
        averaging_iterations=n,
        history=history,
    )


def role_forces(case, settings, freestream):
    """Mean pressure/viscous force vectors per role group over the last 50 rows.

    OpenFOAM v2412 writes postProcessing/<name>/*/force.dat with flat columns:
    time, total xyz, pressure xyz, viscous xyz. The header is checked explicitly
    so a different solver output format fails loudly instead of misparsing.
    """
    q_area = 0.5 * settings["density"] * freestream**2 * settings["reference_area"]
    groups = {}
    for name, role in (("forcesBody", "body"), ("forcesWheels", "wheels")):
        candidates = list((case / f"postProcessing/{name}").glob("*/force.dat"))
        if not candidates:
            continue
        lines = candidates[0].read_text().splitlines()
        header = " ".join(line for line in lines if line.startswith("#"))
        if not all(key in header for key in ("total_x", "pressure_x", "viscous_x")):
            raise RuntimeError(f"Unrecognized OpenFOAM force output format in {name}.")
        rows = []
        for line in lines:
            if not line or line.startswith("#"):
                continue
            try:
                nums = [float(x) for x in line.split()]
            except ValueError:
                continue
            if len(nums) == 10:
                rows.append(nums)
        data = np.array(rows)
        if len(rows) < 2 or not np.isfinite(data).all():
            raise RuntimeError(f"Force breakdown ({name}) is missing or non-finite.")
        tail = data[-min(50, len(rows)) :]
        pressure, viscous = tail[:, 4:7].mean(axis=0), tail[:, 7:10].mean(axis=0)
        drag = float(pressure[0] + viscous[0])
        lift = float(pressure[2] + viscous[2])
        groups[role] = dict(
            drag=drag,
            downforce=-lift,
            cd=drag / q_area,
            cl=lift / q_area,
            pressure_drag=float(pressure[0]),
            viscous_drag=float(viscous[0]),
            pressure_downforce=float(-pressure[2]),
            viscous_downforce=float(-viscous[2]),
        )
    return groups


def process(case, output, run, metadata):
    output.mkdir(exist_ok=True)
    reader = vtk.vtkOpenFOAMReader()
    reader.SetFileName(str(case / "case.foam"))
    reader.EnableAllCellArrays()
    reader.UpdateInformation()
    reader.EnableAllPatchArrays()
    times = reader.GetTimeValues()
    if not times or times.GetNumberOfValues() < 1:
        raise RuntimeError("No solved time directory found.")
    last = times.GetValue(times.GetNumberOfValues() - 1)
    if last <= 0:
        raise RuntimeError("No solved fields found.")
    reader.UpdateTimeStep(last)
    reader.Update()
    volume, surfaces = None, vtk.vtkAppendPolyData()
    for name, block in named_blocks(reader.GetOutput()):
        if name == "internalMesh":
            volume = add_fields(block, run["settings"]["density"])
        elif name.startswith("part"):
            surface = vtk.vtkGeometryFilter()
            surface.SetInputData(add_fields(block, run["settings"]["density"]))
            surface.Update()
            surfaces.AddInputData(surface.GetOutput())
    if volume is None or surfaces.GetNumberOfInputConnections(0) == 0:
        raise RuntimeError("Missing volume or car surface results.")
    surfaces.Update()
    write_poly(surfaces.GetOutput(), output / "surface.vtp")
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(output / "volume.vtu"))
    writer.SetInputData(volume)
    writer.Write()
    ranges = {}
    for name in ("Pressure", "Speed", "Turbulence"):
        arrays = [obj.GetPointData().GetArray(name) for obj in (volume, surfaces.GetOutput())]
        valid = [a.GetRange() for a in arrays if a is not None]
        if valid:
            ranges[name] = [min(r[0] for r in valid), max(r[1] for r in valid)]
    low, high = run["geometry"]["bounds"]
    length = high[0] - low[0]
    points = vtk.vtkPoints()
    for y in np.linspace(low[1] - 0.5, high[1] + 0.5, 13):
        for z in np.linspace(0.08, high[2] + 0.5, 8):
            points.InsertNextPoint(low[0] - 0.5 * length, y, z)
    seeds = vtk.vtkPolyData()
    seeds.SetPoints(points)
    tracer = vtk.vtkStreamTracer()
    tracer.SetInputData(volume)
    tracer.SetSourceData(seeds)
    tracer.SetInputArrayToProcess(0, 0, 0, 0, "U")
    tracer.SetIntegratorTypeToRungeKutta45()
    tracer.SetIntegrationDirectionToForward()
    tracer.SetMaximumPropagation(5 * length)
    tracer.SetInitialIntegrationStep(0.2)
    tracer.SetMaximumNumberOfSteps(2500)
    tracer.Update()
    write_poly(tracer.GetOutput(), output / "streamlines.vtp")
    values = coefficients(case, run["settings"], metadata["freestream"])
    breakdown_roles = role_forces(case, run["settings"], metadata["freestream"])
    pressure_drag = sum(g["pressure_drag"] for g in breakdown_roles.values())
    viscous_drag = sum(g["viscous_drag"] for g in breakdown_roles.values())
    # The role groups partition every car patch, so their summed drag must
    # reconcile with the total coefficient drag. If not, the split is unusable.
    consistent = abs(pressure_drag + viscous_drag - values["drag"]) <= 0.05 * max(
        abs(values["drag"]), 1.0
    )
    breakdown = {
        **breakdown_roles,
        "pressure_drag": pressure_drag,
        "viscous_drag": viscous_drag,
        "consistent": consistent,
    }
    blockage = float(metadata.get("blockage_ratio", 0))
    log = (case / "log.simpleFoam").read_text(errors="replace")
    residuals = {}
    final_iteration_log = log.rsplit("\nTime = ", 1)[-1]
    for variable, value in re.findall(
        r"Solving for (\w+), Initial residual = ([\deE.+-]+)", final_iteration_log
    ):
        residuals[variable] = max(residuals.get(variable, 0), float(value))
    converged = all(
        residuals.get(v, math.inf) <= metadata["preset"]["residual"]
        for v in ("p", "Ux", "Uy", "Uz", "k", "omega")
    )
    warnings = []
    if not converged:
        warnings.append("Residuals have not reached this preset's target. Forces are provisional.")
    if not values["force_settled"]:
        warnings.append("Drag or lift is still changing. Do not rank designs from this run.")
    if run["settings"]["quality"] == "fast":
        warnings.append(
            "Fast uses a coarse mesh without prism layers. Use it for setup and flow exploration."
        )
    warnings.append(
        "No experimental validation for this car. Mesh refinement and physical testing are still needed."
    )
    if blockage > 0.05:
        warnings.append(
            f"Tunnel blockage is {blockage:.1%}, above the ~5% guideline. "
            "Confinement may inflate forces; use a larger domain or correct for blockage."
        )
    if not consistent:
        warnings.append(
            "Force breakdown does not reconcile with total drag. "
            "Treat the body/wheel and pressure/viscous split as unreliable."
        )
    yplus = []
    for file in (case / "postProcessing/yPlus").glob("*/yPlus.dat"):
        for line in file.read_text().splitlines():
            if line and not line.startswith("#"):
                fields = line.split()
                if len(fields) >= 5 and fields[1].startswith("part"):
                    yplus.append(
                        dict(
                            patch=fields[1],
                            minimum=float(fields[2]),
                            maximum=float(fields[3]),
                            mean=float(fields[4]),
                        )
                    )
    wall_array = surfaces.GetOutput().GetPointData().GetArray("yPlus")
    wall_fraction = None
    if wall_array is not None:
        vals = vtk_to_numpy(wall_array)
        wall_fraction = float(np.mean((vals >= 30) & (vals <= 300)))
        if wall_fraction < 0.8:
            warnings.append(
                f"Only {wall_fraction:.0%} of sampled wall points fall within the target y+ range 30–300. Near-wall resolution needs review."
            )
    else:
        warnings.append("Near-wall y+ coverage could not be assessed.")
    return dict(
        **values,
        breakdown=breakdown,
        blockage_ratio=blockage,
        wall_target_fraction=wall_fraction,
        residuals=residuals,
        residual_converged=converged,
        ranges=ranges,
        iteration=last,
        cells=volume.GetNumberOfCells(),
        warnings=warnings,
        y_plus=yplus[-len(run["geometry"]["parts"]) :],
        slice_bounds=[
            low[0] - length,
            high[0] + 2 * length,
            low[1] - 0.5,
            high[1] + 0.5,
            0.02,
            high[2] + 0.7,
        ],
    )


def slice_field(output: Path, axis: str, fraction: int, bounds):
    path = output / f"slice-{axis}-{fraction}.vtp"
    if path.exists():
        return path
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(output / "volume.vtu"))
    reader.Update()
    index = "xyz".index(axis)
    origin, normal = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    normal[index] = 1
    origin[index] = bounds[2 * index] + fraction / 100 * (bounds[2 * index + 1] - bounds[2 * index])
    plane = vtk.vtkPlane()
    plane.SetOrigin(origin)
    plane.SetNormal(normal)
    cutter = vtk.vtkCutter()
    cutter.SetCutFunction(plane)
    cutter.SetInputConnection(reader.GetOutputPort())
    cutter.Update()
    box = vtk.vtkBox()
    box.SetBounds(bounds)
    clip = vtk.vtkClipPolyData()
    clip.SetInputConnection(cutter.GetOutputPort())
    clip.SetClipFunction(box)
    clip.InsideOutOn()
    clip.Update()
    write_poly(clip.GetOutput(), path)
    return path
