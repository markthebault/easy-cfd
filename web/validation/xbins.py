# Pressure drag/lift per streamwise bin: OpenFOAM surface.vtp vs our wall cells (slices JSON).
import vtk, numpy as np, json, sys
from vtk.util.numpy_support import vtk_to_numpy as v2n
run, planes, rho = sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 1.225
r=vtk.vtkXMLPolyDataReader(); r.SetFileName(f'../.easycfd/runs/{run}/results/surface.vtp'); r.Update()
pd=r.GetOutput(); pts=v2n(pd.GetPoints().GetData()); P=v2n(pd.GetPointData().GetArray('Pressure'))
tri=vtk.vtkTriangleFilter(); tri.SetInputData(pd); tri.Update(); t=tri.GetOutput()
ids=v2n(t.GetPolys().GetConnectivityArray()).reshape(-1,3)
a,b,c=pts[ids[:,0]],pts[ids[:,1]],pts[ids[:,2]]
An=0.5*np.cross(b-a,c-a); ctr=(a+b+c)/3; pc=P[ids].mean(1)
# orient outward using our wall normals is hard; use signed volume per connected surface: assume stored outward
if (ctr*An).sum() < 0: An=-An
F=-(pc[:,None])*An
d=json.load(open(planes)); W=np.array(d['wallCells'])
X=W[:,0]; Aw=W[:,3:6]; p=W[:,7]*rho
lo,hi=min(ctr[:,0].min(),X.min()),max(ctr[:,0].max(),X.max())
bins=np.linspace(lo,hi+1e-6,13)
print(f"{'x bin':>14s} {'OF Fx':>8s} {'our Fx':>8s} {'OF Fz':>8s} {'our Fz':>8s}")
for i in range(12):
  m=(ctr[:,0]>=bins[i])&(ctr[:,0]<bins[i+1]); q=(X>=bins[i])&(X<bins[i+1])
  print(f"{bins[i]:6.2f}..{bins[i+1]:5.2f} {F[m,0].sum():8.1f} {(p*Aw[:,0])[q].sum():8.1f} {F[m,2].sum():8.1f} {(p*Aw[:,2])[q].sum():8.1f}")
print(f"{'total':>14s} {F[:,0].sum():8.1f} {(p*Aw[:,0]).sum():8.1f} {F[:,2].sum():8.1f} {(p*Aw[:,2]).sum():8.1f}")
