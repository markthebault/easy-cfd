# Compare centreline wake profiles: OpenFOAM volume.vtu vs our slice JSON.
import vtk, numpy as np, json, sys
from vtk.util.numpy_support import vtk_to_numpy as v2n
run = sys.argv[1]; planes = sys.argv[2]
xs_q = [float(v) for v in (sys.argv[3] if len(sys.argv) > 3 else '2.2,2.6,3.0,3.5,4.5,6.5').split(',')]
zq = [0.1,0.3,0.5,0.7,0.9,1.1,1.3,1.5]
r=vtk.vtkXMLUnstructuredGridReader(); r.SetFileName(f'.easycfd/runs/{run}/results/volume.vtu'); r.Update(); g=r.GetOutput()
d=json.load(open(planes)); pl=[p for p in d['planes'] if p['axis']=='y' and abs(p['at'])<1e-6][0]
W,H=pl['width'],pl['height']; F={k:np.array(v,float).reshape(H,W) for k,v in pl['fields'].items()}
xs=np.array(pl['colCoord']); zs=np.array(pl['rowCoord'])
pts=vtk.vtkPoints(); q=[]
for x in xs_q:
  for z in zq: pts.InsertNextPoint(x,0,z); q.append((x,z))
poly=vtk.vtkPolyData(); poly.SetPoints(pts)
pr=vtk.vtkProbeFilter(); pr.SetInputData(poly); pr.SetSourceData(g); pr.Update()
o=pr.GetOutput().GetPointData(); U=v2n(o.GetArray('U')); P=v2n(o.GetArray('Pressure')); k=v2n(o.GetArray('k')); nut=v2n(o.GetArray('nut'))
print('   x    z |  OF Ux    ours|U| |  OF p  ours p |  OF k ours k | OF nut ours nut')
for i,(x,z) in enumerate(q):
  ci=np.argmin(abs(xs-x)); ri=np.argmin(abs(zs-z))
  print(f"{x:4.1f} {z:4.1f} | {U[i,0]:6.1f} {F['speed'][ri,ci]:8.1f} | {P[i]:5.0f} {F['p'][ri,ci]*1.225:6.0f} | {k[i]:5.2f} {F['k'][ri,ci]:5.2f} | {nut[i]:.4f} {F['nut'][ri,ci]:.4f}")
