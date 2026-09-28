# Centreline (|y| small) surface pressure, top and bottom, ours vs OpenFOAM surface.vtp.
import vtk, numpy as np, json, sys
from vtk.util.numpy_support import vtk_to_numpy as v2n
run, planes = sys.argv[1], sys.argv[2]
r=vtk.vtkXMLPolyDataReader(); r.SetFileName(f'../.easycfd/runs/{run}/results/surface.vtp'); r.Update()
pd=r.GetOutput()
nf=vtk.vtkPolyDataNormals(); nf.SetInputData(pd); nf.ComputePointNormalsOn(); nf.SplittingOff(); nf.AutoOrientNormalsOn(); nf.Update()
o=nf.GetOutput(); pts=v2n(o.GetPoints().GetData()); P=v2n(o.GetPointData().GetArray('Pressure')); N=v2n(o.GetPointData().GetArray('Normals'))
d=json.load(open(planes)); W=np.array(d['wallCells'])
hy=np.median(np.diff(np.unique(np.round(W[:,1],4))))
lo,hi=pts[:,0].min(),pts[:,0].max(); bins=np.linspace(lo,hi,17)
def prof(x,p,sel):
    idx=np.digitize(x[sel],bins); return [p[sel][idx==i].mean() if (idx==i).any() else np.nan for i in range(1,len(bins))]
mo=np.abs(pts[:,1])<0.03; mw=np.abs(W[:,1])<0.6*hy
top_of=prof(pts[:,0],P,mo&(N[:,2]>0.3)); bot_of=prof(pts[:,0],P,mo&(N[:,2]<-0.3))
top_w=prof(W[:,0],W[:,7]*1.225,mw&(W[:,5]<0)); bot_w=prof(W[:,0],W[:,7]*1.225,mw&(W[:,5]>0))
print('   x    | top OF  ours | bottom OF  ours')
for i in range(len(bins)-1):
    print(f"{0.5*(bins[i]+bins[i+1]):6.2f} | {top_of[i]:6.0f} {top_w[i]:6.0f} | {bot_of[i]:6.0f} {bot_w[i]:6.0f}")
