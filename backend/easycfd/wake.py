"""Display-only wake streamtubes from saved velocity fields."""

import numpy as np
import vtk
from .results import write_poly


def tubes(output, geometry):
    path = output / "wake-v2.vtp"
    if path.exists():
        return path
    low, high = np.asarray(geometry["bounds"])
    length = high[0] - low[0]
    width = high[1] - low[1]
    height = high[2] - low[2]
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(output / "volume.vtu"))
    reader.Update()
    points = vtk.vtkPoints()
    # Inlet rake for flow around the body, plus local wake seeds that can
    # reveal recirculation unreachable by streamlines started at the inlet.
    for x, ny, nz in [(low[0] - 0.35 * length, 7, 4),
                      (high[0] + 0.08 * length, 5, 4),
                      (high[0] + 0.35 * length, 5, 4)]:
        for y in np.linspace(low[1] - 0.2 * width, high[1] + 0.2 * width, ny):
            for z in np.linspace(max(0.02 * length, low[2]), high[2] + 0.25 * height, nz):
                points.InsertNextPoint(x, y, z)
    seeds = vtk.vtkPolyData()
    seeds.SetPoints(points)
    tracer = vtk.vtkStreamTracer()
    tracer.SetInputConnection(reader.GetOutputPort())
    tracer.SetSourceData(seeds)
    tracer.SetInputArrayToProcess(0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_POINTS, "U")
    tracer.SetIntegratorTypeToRungeKutta45()
    tracer.SetIntegrationDirectionToBoth()
    tracer.SetMaximumPropagation(4 * length)
    tracer.SetMaximumNumberOfSteps(1600)
    tracer.SetInitialIntegrationStep(0.08)
    tracer.SetMaximumIntegrationStep(0.2)
    tracer.SetComputeVorticity(False)
    tube = vtk.vtkTubeFilter()
    tube.SetInputConnection(tracer.GetOutputPort())
    tube.SetRadius(length * 0.0018)
    tube.SetNumberOfSides(8)
    tube.CappingOn()
    tube.Update()
    if not tube.GetOutput().GetNumberOfPoints():
        raise ValueError("No wake paths could be traced in this saved velocity field.")
    temporary = output / "wake-v2.tmp.vtp"
    write_poly(tube.GetOutput(), temporary)
    temporary.replace(path)
    return path
