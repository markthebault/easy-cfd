from pathlib import Path
import hashlib, urllib.request, tarfile
root=Path(__file__).resolve().parent
build=root/'build'
build.mkdir(exist_ok=True)
packages=[('clapack','https://www.netlib.org/clapack/clapack-3.2.1-CMAKE.tgz','clapack-3.2.1-CMAKE','0b3f782bc24845d85f36bafbff0f2f1384dc72df730fda4e7924ec1a70baca5a'),('lua','https://vvflow.github.io/vvflow-deps/lua-5.2.4.tar.gz','lua-5.2.4','b9e2e4aad6789b3b63a056d442f7b39f0ecfca3ae0f1fc0ae4e9614401b69f4b')]
for name,url,directory,expected in packages:
    archive=build/(name+'.tgz')
    if not archive.exists(): urllib.request.urlretrieve(url,archive)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != expected: raise RuntimeError(f'{name}: download checksum mismatch')
    print(name,digest)
    if not (build/directory).exists():
        with tarfile.open(archive) as t: t.extractall(build,filter='data')
s=(root/'vendor/libvvhd/src/TSpace.cpp').read_text()
s=s.replace('#define H5_USE_18_API\n#include <hdf5.h>','').replace('#include "vvhdf.h"','')
s=s[:s.index('void Space::load(')]+s[s.index('FILE* Space::open_file'):]
(build/'TSpace.cpp').write_text(s)
m=(root/'vendor/libvvhd/src/TMatrix.cpp').read_text()
# CLAPACK subroutines return int; Fortran declarations return void. The return
# value is unused, but WASM enforces an exact function signature.
m=m.replace('void dgesv_', 'int dgesv_').replace('void dgetrf_', 'int dgetrf_').replace('void dgetri_', 'int dgetri_')
(build/'TMatrix.cpp').write_text(m)
# Keep more computed domains at higher density; preserve the upstream default.
e=(root/'vendor/libvvhd/src/MEpsilonFast.cpp').read_text()
e=e.replace('using std::vector;', 'extern double vv_merge_scale;\nusing std::vector;')
e=e.replace('0.16 * nearestAtt->dl.abs2()', '0.16 * vv_merge_scale * nearestAtt->dl.abs2()')
(build/'MEpsilonFast.cpp').write_text(e)
