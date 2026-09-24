import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy
from easycfd import wake


def test_wake_tubes_follow_saved_uniform_velocity_and_keep_fields(tmp_path):
    grid = vtk.vtkImageData()
    grid.SetDimensions(25, 13, 9)
    grid.SetOrigin(-3, -3, 0)
    grid.SetSpacing(0.5, 0.5, 0.5)
    n = grid.GetNumberOfPoints()
    for name, values in [('U', np.tile([10., 0., 0.], (n, 1))),
                         ('Speed', np.full(n, 10.)), ('Pressure', np.full(n, 42.))]:
        array = numpy_to_vtk(values, deep=True)
        array.SetName(name)
        grid.GetPointData().AddArray(array)
    append = vtk.vtkAppendFilter()
    append.AddInputData(grid)
    append.Update()
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(tmp_path / 'volume.vtu'))
    writer.SetInputData(append.GetOutput())
    writer.Write()
    geometry = {'bounds': [[-1, -0.5, 0.1], [1, 0.5, 1.1]]}
    path = wake.tubes(tmp_path, geometry)
    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(path))
    reader.Update()
    data = reader.GetOutput()
    assert data.GetNumberOfCells() > 0
    assert np.allclose(vtk_to_numpy(data.GetPointData().GetArray('Pressure')), 42)
    assert np.allclose(vtk_to_numpy(data.GetPointData().GetArray('U')), [10, 0, 0])
    modified = path.stat().st_mtime_ns
    assert wake.tubes(tmp_path, geometry).stat().st_mtime_ns == modified
