"""Build a reusable, common-mesh OpenFOAM speed/yaw map. Saved geometry is never changed.
Run using the existing EasyCFD Python/VTK runtime with PYTHONPATH=backend.
Raw cases stay in EASYCFD_DATA; only losslessly sampled playback data goes into web/public.
"""
import gzip, hashlib, json, math, os, re, shutil, sys, threading, time, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.setdefault('EASYCFD_DATA', '/Volumes/SSD512/persospace/easy-cfd/.easycfd/track-map-fast-20261106'))
ROOT.mkdir(parents=True, exist_ok=True)
from easycfd import foam, runner, storage
from easycfd.models import Settings
from easycfd.webview import FieldRequest, sample_field, sample_surface
import numpy as np

OUT = REPO/'web/public/track-cfd'
BASE = json.loads((OUT/'manifest.json').read_text())
SOURCE = Path('/Volumes/SSD512/persospace/easy-cfd/.easycfd/runs')/BASE['runId']
source = json.loads((SOURCE/'record.json').read_text())
geometry = source['geometry']
QUALITY = os.environ.get('TRACK_MAP_QUALITY', 'fast')
if QUALITY not in ('fast','medium'): raise ValueError('Use fast or medium')
SPEEDS = [40, 240]
YAWS = [-10, 0, 10]
stop = threading.Event()
lease_error = []

def lease():
    req = urllib.request.Request('http://127.0.0.1:8780/api/compute-lease', data=b'{"owner":"track-cfd-map"}', headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=10) as r: r.read()
def renew():
    while not stop.wait(30):
        try: lease()
        except Exception as e: lease_error.append(str(e)); runner.STOP.set(); return

def status(**extra):
    (ROOT/'status.json').write_text(json.dumps(extra, indent=2))
    print(json.dumps(extra), flush=True)

def record(speed, yaw, suffix):
    key = hashlib.sha256(('track-map-v2-'+QUALITY+'-'+suffix).encode()).hexdigest()[:32]
    settings = Settings(**{**source['settings'], 'profile':'basic' if QUALITY == 'fast' else 'regular', 'quality':QUALITY, 'speed_kmh':speed, 'yaw_deg':yaw, 'flow_animation':False, 'flow_detail':'standard', 'max_seconds':300 if QUALITY == 'fast' else 1200})
    run = dict(id=key, project_id=source['project_id'], name=f'MX-5 NC track map / {speed} kmh / {yaw} deg', created=storage.now(), status='running', settings=settings.model_dump(), geometry=geometry, image=foam.IMAGE, pipeline_hash=runner.PIPELINE_HASH, processes=4, cpus=4, deadline_seconds=settings.max_seconds, reference_case=None, assumptions=source.get('assumptions',{}))
    folder=storage.directory('runs',key);folder.mkdir(parents=True,exist_ok=True)
    if not (folder/'geometry').exists(): shutil.copytree(SOURCE/'geometry',folder/'geometry')
    storage.save('runs',run); runner.DEADLINES[key]=time.monotonic()+settings.max_seconds
    case=folder/('case-'+QUALITY)
    meta=foam.generate(case,folder/'geometry',geometry,settings,QUALITY,processes=4)
    (case/'metadata.json').write_text(json.dumps(meta))
    return run,case,meta

def stage(run, case, args, label):
    if lease_error: raise RuntimeError('Compute lease lost: '+lease_error[-1])
    return runner.stage(run['id'],case,args,label,4,4)

def check(run,case):
    stage(run,case,['checkMesh','-meshQuality','-allTopology'],'Checking common mesh')
    log=(case/'log.checkMesh').read_text()
    if 'Mesh OK.' not in log: raise RuntimeError('Common mesh failed checkMesh')
    count=int(re.search(r'cells:\s+(\d+)',log)[1])
    if count > meta_limit: raise RuntimeError('Mesh exceeds preset budget')
    boundary=(case/'constant/polyMesh/boundary').read_text(errors='replace')
    for p in geometry['parts']:
        m=re.search(r'\b'+p['id']+r'\s*\{[^}]*nFaces\s+(\d+)',boundary)
        if not m or int(m[1])<6: raise RuntimeError('A part disappeared from the mesh')
    return count

def save(file,raw):
    path=OUT/file;path.parent.mkdir(exist_ok=True,parents=True)
    path.write_bytes(gzip.compress(raw,compresslevel=6))
    return hashlib.sha256(raw).hexdigest()

def force_metadata(run):
    result, settings = run['result'], run['settings']
    return dict(cl=result['cl'],cd=result['cd'],downforceN=result['downforce'],density=settings['density'],referenceArea=settings['reference_area'])

lease();threading.Thread(target=renew,daemon=True).start()
try:
    mesh,mesh_case,meta=record(120,0,'common-mesh')
    meta_limit=meta['preset']['max_cells']
    if not (mesh_case/'log.checkMesh').exists() or 'Mesh OK.' not in (mesh_case/'log.checkMesh').read_text():
        status(stage='meshing',speed=120,yaw=0)
        stage(mesh,mesh_case,['blockMesh'],'Building common wind tunnel')
        stage(mesh,mesh_case,['snappyHexMesh','-overwrite'],'Meshing baseline MX-5 once')
        check(mesh,mesh_case)
    if meta['preset']['layers']:
        layers=re.findall(r'Extruding (\d+) out of (\d+) faces',(mesh_case/'log.snappyHexMesh').read_text())
        if not layers or int(layers[-1][0])/max(1,int(layers[-1][1])) < .2: raise RuntimeError('Medium failed boundary-layer coverage; no map exported. Request Fast explicitly for an exploratory map.')
    mesh_hash=hashlib.sha256(b''.join((mesh_case/'constant/polyMesh'/n).read_bytes() for n in ['points','faces','owner','neighbour','boundary'])).hexdigest()
    samples=[]
    for speed in SPEEDS:
        for yaw in YAWS:
            name=f'v{speed}-yaw{yaw}'
            cached=OUT/'map'/name/'sample.json'
            if cached.exists():
                sample=json.loads(cached.read_text())
                if sample['meshHash']!=mesh_hash or sample.get('pipelineHash')!=runner.PIPELINE_HASH: raise RuntimeError('Cached sample mesh or solver pipeline differs; regenerate the stale cache')
                sample['loads']=force_metadata(json.loads((storage.directory('runs',sample['runId'])/'record.json').read_text()))
                cached.write_text(json.dumps(sample,indent=2))
                samples.append(sample);continue
            run,case,meta=record(speed,yaw,name)
            for relative in ['constant/polyMesh','0/polyMesh']:
                if (mesh_case/relative).exists(): shutil.copytree(mesh_case/relative,case/relative,dirs_exist_ok=True)
            cells=check(run,case)
            status(stage='solving',speed=speed,yaw=yaw,complete=len(samples),total=len(SPEEDS)*len(YAWS),cells=cells)
            stage(run,case,['decomposePar','-force'],'Partitioning common mesh')
            stage(run,case,['mpirun','--allow-run-as-root','--oversubscribe','-np','4','simpleFoam','-parallel'],'Solving speed/yaw sample')
            stage(run,case,['reconstructPar','-newTimes'],'Reassembling solved field')
            for folder in runner.redundant_processor_copies(case): shutil.rmtree(folder)
            output=case.parent/'results';output.mkdir(exist_ok=True)
            result=runner.extract_case(run['id'],case,output,run)
            result.update(cells=cells,mesh_ok=True,preset=QUALITY,mesh_recipe=meta)
            storage.update('runs',run['id'],status='completed',result=result,finished=storage.now())
            status(stage='sampling',speed=speed,yaw=yaw,complete=len(samples),total=len(SPEEDS)*len(YAWS))
            grid={k:BASE['field'][k] for k in ['origin','spacing','dims']}
            hashes={};field_file=f'map/{name}/field.bin.gz'
            hashes[field_file]=save(field_file,sample_field(output,FieldRequest(**grid)))
            cps={}
            for p in BASE['parts']:
                positions=np.frombuffer(gzip.decompress((OUT/p['positions']).read_bytes()),dtype='<f4').astype(np.float64)
                payload=sample_surface(output,positions,meta['freestream'])
                cp_file=f'map/{name}/{p["id"]}-cp.bin.gz';hashes[cp_file]=save(cp_file,payload[:p['vertices']*4]);cps[p['id']]=cp_file
            sample=dict(pipelineHash=runner.PIPELINE_HASH,image=foam.IMAGE,id=name,runId=run['id'],speedKmh=speed,yawDeg=yaw,field=field_file,cp=cps,meshHash=mesh_hash,cells=cells,freestream=meta['freestream'],inlet=meta['velocity'],speedMax=result['ranges']['Speed'][1],forceSettled=result['force_settled'],residualConverged=result['residual_converged'],warnings=result['warnings'],hashes=hashes)
            sample['loads']=force_metadata(dict(result=result,settings=run['settings']))
            cached.write_text(json.dumps(sample,indent=2));samples.append(sample)
            status(stage='sample-complete',speed=speed,yaw=yaw,complete=len(samples),total=len(SPEEDS)*len(YAWS))
    catalog=dict(pipelineHash=runner.PIPELINE_HASH,image=foam.IMAGE,version=1,engine='openfoam',quality=QUALITY,method='steady speed/yaw map',speeds=SPEEDS,yaws=YAWS,meshHash=mesh_hash,samples=samples,grid=BASE['field'],cpRange=BASE['cpRange'],geometryHashes={p['id']:BASE['hashes'][p['positions'][:-3]] for p in BASE['parts']},speedMax=max(s['speedMax'] for s in samples),limitations=['Steady straight-flow cases; interpolation is a quasi-steady approximation, not a rotating-frame cornering solve.','Each case retains its convergence warnings.','Unsolved accessory packages are not covered.'])
    (OUT/'map.json').write_text(json.dumps(catalog,indent=2)+'\n')
    status(stage='complete',complete=len(samples),total=len(samples))
finally:
    stop.set()
    try: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8780/api/compute-lease/track-cfd-map',method='DELETE'),timeout=10).read()
    except Exception: pass
