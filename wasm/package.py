#!/usr/bin/env python3
"""Ship only static assets, each smaller than Cloudflare Pages' 25 MiB limit."""
import hashlib
import gzip
import json
import pathlib
import shutil
import sys
import tarfile
import tempfile

foam, dest = map(pathlib.Path, sys.argv[1:])
dest.mkdir(parents=True, exist_ok=True)
bin = foam / 'platforms/linux64EmscriptenDPInt32Opt/bin'
manifest = {'version': 'OpenFOAM-v2512', 'precision': 'double', 'mpi': False, 'modules': {}}
for app in ['blockMesh', 'snappyHexMesh', 'checkMesh', 'browserFoam']:
    (dest / (app + '.js')).write_text((bin / app).read_text() + '\nexport default createOpenFOAM;\n')
    data = (bin / (app + '.wasm')).read_bytes()
    chunks = []
    for i, start in enumerate(range(0, len(data), 8 * 1024 * 1024)):
        name = f'{app}.{i}.wasm.bin'
        (dest / name).write_bytes(data[start:start + 8 * 1024 * 1024])
        chunks.append(name)
    compressed=gzip.compress(data,compresslevel=9,mtime=0)
    gzip_chunks=[]
    for i,start in enumerate(range(0,len(compressed),8*1024*1024)):
        name=f'{app}.{i}.wasm.gz.bin';(dest/name).write_bytes(compressed[start:start+8*1024*1024]);gzip_chunks.append(name)
    manifest['modules'][app] = {'chunks': chunks, 'gzipChunks': gzip_chunks, 'gzipBytes': len(compressed), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
shutil.copyfile(foam / 'etc/controlDict', dest / 'controlDict')
shutil.copyfile(foam / 'etc/cellModels', dest / 'cellModels')
shutil.copyfile(foam / 'COPYING', dest / 'COPYING.OpenFOAM')

# Corresponding source for the shipped GPL binaries, served alongside them.
# Source is downloaded only on request, and obeys the same static asset size limit.
with tempfile.TemporaryDirectory() as temp:
    source = pathlib.Path(temp) / 'openfoam-wasm-source.tar.gz'
    def source_only(info):
        parts = pathlib.PurePosixPath(info.name).parts
        if 'lnInclude' in parts or '.git' in parts or '__pycache__' in parts:
            return None
        return info
    with tarfile.open(source, 'w:gz', compresslevel=6) as archive:
        for name in ['src', 'applications', 'wmake', 'etc', 'COPYING', 'META-INFO']:
            archive.add(foam / name, arcname='OpenFOAM-v2512/' + name, filter=source_only)
        archive.add(pathlib.Path(__file__).parent, arcname='easycfd-wasm-build', filter=source_only)
    chunks=[]
    with source.open('rb') as stream:
        i=0
        while data:=stream.read(8*1024*1024):
            name=f'source.{i}.tar.gz.bin';(dest/name).write_bytes(data);chunks.append(name);i+=1
    manifest['source']={'chunks':chunks,'filename':'openfoam-wasm-source.tar.gz'}
(dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(dest / 'source.html').write_text('''<!doctype html><meta charset="utf-8"><title>OpenFOAM source</title>
<h1>OpenFOAM WebAssembly source and license</h1>
<p>OpenFOAM v2512 is GPL-3.0-or-later. These are the corresponding patched sources and build scripts for the browser binaries.</p>
<p><a href="COPYING.OpenFOAM">Read the license</a></p><button id="download">Download corresponding source</button><p id="status"></p>
<script type="module">
document.querySelector('#download').onclick=async()=>{
  const status=document.querySelector('#status');status.textContent='Downloading source archive…';
  try{const m=await (await fetch('manifest.json')).json();const parts=await Promise.all(m.source.chunks.map(async name=>{const r=await fetch(name);if(!r.ok)throw Error('Download failed');return r.arrayBuffer();}));
    const url=URL.createObjectURL(new Blob(parts,{type:'application/gzip'}));const a=document.createElement('a');a.href=url;a.download=m.source.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='Source archive downloaded.';
  }catch(e){status.textContent=e.message;}
};
</script>
''')
