import * as T from 'three';
import { ElevationProfile } from './elevation';
import { airConditions, type Wind } from './aeroMap';
import { TrackPath } from './trackPath';
import { gripCalibration, lateralCapacity, vehicleLoads, type VehicleAero } from './vehicleAero';
import type { Setup } from './settings';
export { initial, type Setup } from './settings';
export function solve(points: T.Vector3[], s: Setup, aero: VehicleAero | null = null, base: VehicleAero | null = aero, wind: Wind = { speed: 0, bearing: 0 }) {
 const n=points.length, ds=points.map((p,i)=>p.distanceTo(points[(i+1)%n]));
 const curvature=points.map((p,i)=>{const a=points[(i+n-3)%n],b=points[(i+3)%n];const u=p.clone().sub(a),v=b.clone().sub(p);return 2*Math.sin(u.angleTo(v)/2)/Math.max(1,(u.length()+v.length())/2);});
 const path=new TrackPath(points);
 const forward=points.map((_,i)=>path.atDistance(path.distances[i]).forward);
 const signedCurvature=curvature.map((k,i)=>k*Math.sign(new T.Vector3().crossVectors(path.atDistance(path.distances[i]-6).forward,path.atDistance(path.distances[i]+6).forward).y));
 const calibration=gripCalibration(base,s.mass);
 const conditions=(v:number,i:number)=>airConditions(v,forward[i],signedCurvature[i],(aero?.wheelbase ?? 2.33)/2,wind);
 const loads=(v:number,i:number)=>aero ? vehicleLoads(aero,conditions(v,i)) : {netLiftN:0,dragN:.5*1.225*.65*v*v,covered:true};
 const capacity=(v:number,i:number,g=s.grip)=>lateralCapacity(g,s.mass,calibration,loads(v,i).netLiftN)/s.mass;
 const speed=curvature.map((k,i)=>{let lo=0,hi=80;for(let j=0;j<24;j++){const v=(lo+hi)/2;if(v*v*k<=capacity(v,i))lo=v;else hi=v;}return Math.max(2,lo);});
 // Multiple passes propagate braking and power constraints across the start/finish seam.
 for(let pass=0;pass<12;pass++) {
 for(let i=n-1;i>=0;i--){const j=(i+1)%n; speed[i]=Math.min(speed[i],Math.sqrt(speed[j]**2+2*capacity(speed[j],j,s.brake)*ds[i]));}
 for(let i=0;i<n;i++){const j=(i+1)%n,v=speed[i],limit=capacity(v,i),lat=v*v*curvature[i]/Math.max(.001,limit);const traction=limit*Math.sqrt(Math.max(0,1-Math.min(1,lat)**2));const acc=Math.min(traction,s.power*1000/Math.max(v,8)/s.mass)-loads(v,i).dragN/s.mass; speed[j]=Math.min(speed[j],Math.sqrt(Math.max(4,v*v+2*acc*ds[i])));}
 }
 const time=ds.map((d,i)=>2*d/(speed[i]+speed[(i+1)%n]));return {speed,ds,curvature,signedCurvature,forward,calibration,time,lap:time.reduce((a,b)=>a+b,0),length:ds.reduce((a,b)=>a+b,0),outsideCoverage:speed.some((v,i)=>!loads(v,i).covered)};
}
export function trackPoints(data:any, elevation = true): T.Vector3[] {
 const coords=data.features.find((f:any)=>f.properties.role==='trace').geometry.coordinates as number[][];
 const [lon,lat]=coords[0]; const raw=coords.map(c=>new T.Vector3((c[0]-lon)*111320*Math.cos(lat*Math.PI/180),0,-(c[1]-lat)*111320));
 if(raw[0].distanceTo(raw[raw.length-1])<1)raw.pop();
 const curve=new T.CatmullRomCurve3(raw,true,'centripetal');
 // Integrate each source span in metres. A fixed parameter-space lookup table is inaccurate
 // when the OSM control spans vary from centimetres to hundreds of metres.
 const dense: T.Vector3[] = [], arc = [0];
 raw.forEach((p,i) => {
  const steps = Math.max(16, Math.ceil(p.distanceTo(raw[(i+1)%raw.length])/.25));
  for(let j=0;j<steps;j++)dense.push(curve.getPoint((i+j/steps)/raw.length));
 });
 dense.push(dense[0].clone());
 for(let i=1;i<dense.length;i++)arc.push(arc[i-1]+dense[i].distanceTo(dense[i-1]));
 const length = arc.at(-1)!, n = Math.round(length/4), points:T.Vector3[] = [];
 let cursor=0;
 for(let i=0;i<n;i++){
  const d=i/n*length;
  while(cursor<arc.length-2 && arc[cursor+1]<d)cursor++;
  const f=(d-arc[cursor])/Math.max(1e-12,arc[cursor+1]-arc[cursor]);
  points.push(dense[cursor].clone().lerp(dense[cursor+1],f));
 }
 const stations=[0];
 points.forEach((p,i)=>stations.push(stations[i]+p.distanceTo(points[(i+1)%points.length])));
 const elevations=data.metadata?.model3d?.elevation as number[][]|undefined;
 if(elevation && elevations?.length){
  const total=data.metadata.model3d.referenceLengthM||length;
  const profile = new ElevationProfile(elevations, total);
  const base = profile.at(0);
  points.forEach((p,i) => { p.y = profile.at(stations[i]/stations.at(-1)!*total) - base; });
 }
 return points;
}
