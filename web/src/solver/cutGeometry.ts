// Exact clipping of piecewise-linear signed distance on a consistently triangulated cube.
// Moments are integrated over clipped tetrahedra, avoiding sample quantization in thin gaps.
type Point = [number, number, number];
type Moment = [number, number, number, number]; // volume, integral x, integral y, integral z
const vertices: Point[] = Array.from({length:8},(_,i)=>[i&1,(i>>1)&1,(i>>2)&1]);
const tetrahedra = [[0,1,3,7],[0,3,2,7],[0,2,6,7],[0,6,4,7],[0,4,5,7],[0,5,1,7]];

function tetra(a:Point,b:Point,c:Point,d:Point): Moment {
  const u=b.map((v,i)=>v-a[i]), v=c.map((v,i)=>v-a[i]), w=d.map((v,i)=>v-a[i]);
  const volume=Math.abs(u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]))/6;
  return [volume,...[0,1,2].map(i=>volume*(a[i]+b[i]+c[i]+d[i])/4)] as Moment;
}
function add(a:Moment,b:Moment,scale=1): Moment { return a.map((v,i)=>v+scale*b[i]) as Moment; }
function intersection(a:Point,b:Point,sa:number,sb:number): Point {
  const t=sa/(sa-sb);
  return a.map((v,i)=>v+t*(b[i]-v)) as Point;
}
function clipTetra(ids:number[],s:number[]): Moment {
  const positive=ids.filter(i=>s[i]>0), negative=ids.filter(i=>s[i]<=0);
  const whole=()=>tetra(...ids.map(i=>vertices[i]) as [Point,Point,Point,Point]);
  const edge=(a:number,b:number)=>intersection(vertices[a],vertices[b],s[a],s[b]);
  if (!positive.length) return [0,0,0,0];
  if (positive.length===4) return whole();
  if (positive.length===1) {
    const p=positive[0];
    return tetra(vertices[p],...negative.map(n=>edge(p,n)) as [Point,Point,Point]);
  }
  if (positive.length===3) {
    const n=negative[0];
    return add(whole(),tetra(vertices[n],...positive.map(p=>edge(n,p)) as [Point,Point,Point]),-1);
  }
  const [p,q]=positive, [n,m]=negative;
  const a=edge(p,n),b=edge(p,m),c=edge(q,n),d=edge(q,m);
  return add(add(tetra(vertices[p],vertices[q],c,d),tetra(vertices[p],c,a,d)),tetra(vertices[p],a,b,d));
}

/** Fluid volume and first moments inside the unit cube, with node order x + 2y + 4z. */
export function clippedCube(s:number[]): {volume:number;centroid:Point} {
  let moment:Moment=[0,0,0,0];
  for (const ids of tetrahedra) moment=add(moment,clipTetra(ids,s));
  const volume=Math.max(0,Math.min(1,moment[0]));
  return {volume,centroid:volume>1e-15 ? moment.slice(1).map(v=>v/volume) as Point : [.5,.5,.5]};
}

const faceVertices:Point[]=[[0,0,0],[1,0,0],[0,1,0],[1,1,0]];
function triangleArea(a:Point,b:Point,c:Point):number { return Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2; }
/** Open area on a unit face, split along the (0,0)-(1,1) diagonal shared by adjacent cubes. */
export function clippedFace(a:number,b:number,c:number,d:number):number {
  const s=[a,b,c,d];
  let area=0;
  for (const ids of [[0,1,3],[0,3,2]]) {
    const positive=ids.filter(i=>s[i]>0), negative=ids.filter(i=>s[i]<=0);
    const edge=(p:number,n:number)=>intersection(faceVertices[p],faceVertices[n],s[p],s[n]);
    if (positive.length===3) area+=.5;
    else if (positive.length===1) {const p=positive[0];area+=triangleArea(faceVertices[p],edge(p,negative[0]),edge(p,negative[1]));}
    else if (positive.length===2) {const n=negative[0];area+=.5-triangleArea(faceVertices[n],edge(n,positive[0]),edge(n,positive[1]));}
  }
  return Math.max(0,Math.min(1,area));
}
