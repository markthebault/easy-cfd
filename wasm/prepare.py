#!/usr/bin/env python3
"""Prepare the pinned OpenFOAM tree for the serial browser build."""
import pathlib
import sys

foam = pathlib.Path(sys.argv[1]).resolve()
here = pathlib.Path(__file__).parent.resolve()
def write(path, text):
    if not path.exists() or path.read_text() != text:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

for source in (here / 'browserFoam').rglob('*'):
    if source.is_file():
        write(foam / 'applications/solvers/incompressible/browserFoam' / source.relative_to(here / 'browserFoam'), source.read_text())

# snappyHexMesh v2512 also references the standalone voxel search helpers.
write(foam / 'src/mesh/snappyHexMesh/easycfdVoxelMeshSearch.C',
      (foam / 'src/overset/cellCellStencil/trackingInverseDistance/voxelMeshSearch.C').read_text())
files = foam / 'src/mesh/snappyHexMesh/Make/files'
text = files.read_text()
if 'easycfdVoxelMeshSearch.C' not in text:
    write(files, 'easycfdVoxelMeshSearch.C\n' + text)
options = foam / 'src/mesh/snappyHexMesh/Make/options'
text = options.read_text()
if '-I$(LIB_SRC)/mesh/blockMesh/lnInclude' not in text:
    write(options, text.replace('EXE_INC = \\\n', 'EXE_INC = \\\n    -I$(LIB_SRC)/mesh/blockMesh/lnInclude \\\n'))

# Stock snappyHexMesh, with serial decomposition methods instead of MPI/Scotch.
options = foam / 'applications/utilities/mesh/generation/snappyHexMesh/Make/options'
text = options.read_text()
prefix = text.split('EXE_LIBS =')[0]
write(options, prefix + '''EXE_LIBS = \\
    -Wl,--whole-archive \\
    -lsnappyHexMesh -ldecompose -lreconstruct -ldistributed \\
    -ldecompositionMethods -ldynamicMesh -lsampling -llagrangian \\
    -lfiniteVolume -lmeshTools -lfileFormats -lsurfMesh -lblockMesh \\
    -Wl,--no-whole-archive
''')

# Register only the models offered by the browser. Their implementations are stock.
models = foam / 'src/TurbulenceModels/incompressible/turbulentTransportModels/turbulentTransportModels.C'
text = models.read_text()
text = text[:text.index('// Laminar')]
write(models, text + '''// Laminar and RANS models supported by this build
#include "Stokes.H"
makeLaminarModel(Stokes);
#include "kOmegaSST.H"
makeRASModel(kOmegaSST);
''')
files = foam / 'src/TurbulenceModels/incompressible/Make/files'
write(files, '''incompressibleTurbulenceModel.C
turbulentTransportModels/turbulentTransportModels.C
LIB = $(FOAM_LIBBIN)/libincompressibleTurbulenceModels
''')

# Plain core compilation: upstream's optional registry inspection isn't needed.
files = foam / 'src/finiteVolume/Make/files'
write(files, '\n'.join(line for line in files.read_text().splitlines() if 'registryDump' not in line) + '\n')

options = foam / 'applications/utilities/mesh/manipulation/checkMesh/Make/options'
text = options.read_text()
prefix = text.split('EXE_LIBS =')[0]
write(options, prefix + '''EXE_LIBS = \\
    -Wl,--whole-archive \\
    -lfiniteVolume -lmeshTools -lfileFormats -lsurfMesh -ldynamicMesh \\
    -Wl,--no-whole-archive
''')
