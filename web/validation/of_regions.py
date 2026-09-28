# Regional pressure-force breakdown of the sample car body: OpenFOAM surface.vtp vs our wall cells.
import vtk, numpy as np, json, sys
from vtk.util.numpy_support import vtk_to_numpy as v2n
run = sys.argv[1] if len(sys.argv) > 1 else '3f7ff23196a04a1695bcd6dc55124009'
r=vtk.vtkXMLPolyDataReader(); r.SetFileName(f'.easycfd/runs/{run}/results/surface.vtp'); r.Update()
pd=r.GetOutput(); pts=v2n(pd.GetPoints().GetData()); P=v2n(pd.GetPointData().GetArray('Pressure'))
tri=vtk.vtkTriangleFilter(); tri.SetInputData(pd); tri.Update(); t=tri.GetOutput()
ids=v2n(t.GetPolys().GetData()).reshape(-1,4)[:,1:]
a,b,c=pts[ids[:,0]],pts[ids[:,1]],pts[ids[:,2]]
An=0.5*np.cross(b-a,c-a)   # area vector (orientation as stored)
ctr=(a+b+c)/3; pc=P[ids].mean(1)
x,y,z=ctr.T
body=(np.abs(y)<0.82)&(z>0.3)
# orient outward: body centroid ~ (0,0,0.8)
s=np.sign(((ctr-np.array([0,0,0.8]))*An).sum(1)); s[s==0]=1
An=An*s[:,None]
F=-(pc[:,None])*An
def regions(x,y,z):
  return {'front x<-2.0':x<-2.0,'nose slope':(x>=-2.0)&(x<-1.6)&(z>0.5),'bonnet':(x>=-1.6)&(x<-0.3)&(z>0.5),'roof+ws':(x>=-0.3)&(x<0.9)&(z>0.5),'rear slope':(x>=0.9)&(x<2.05)&(z>0.5),'base x>2.05':x>=2.05,'underside':(z<0.4)&(x>-2.0)&(x<2.05),'sides':(np.abs(y)>0.75)&(z>=0.4)&(x>-2.0)&(x<2.05)}
d=json.load(open('web/validation/results/slices/sample-planes.json'))
W=np.array(d['wallCells']); bw=W[W[:,8]==0]
X,Y,Z,ax,ay,az,yw,p,part,th=bw.T; p=p*1.225
R1=regions(x,y,z); R2=regions(X,Y,Z)
print(f"{'region':14s} {'OF Fx':>8s} {'ours Fx':>8s} {'OF Fz':>8s} {'ours Fz':>8s}")
for n in R1:
  m=R1[n]&body; q=R2[n]
  print(f"{n:14s} {F[m,0].sum():8.1f} {(p*ax)[q].sum():8.1f} {F[m,2].sum():8.1f} {(p*az)[q].sum():8.1f}")
print(f"{'total':14s} {F[body,0].sum():8.1f} {(p*ax).sum():8.1f} {F[body,2].sum():8.1f} {(p*az).sum():8.1f}")
