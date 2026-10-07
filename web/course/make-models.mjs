// Original synthetic teaching geometry. No production-car fitment or aerodynamic claim.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ShapeUtils, Vector2 } from 'three';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/course/models');
mkdirSync(out, { recursive: true });
async function loadTS(path) {
  const code = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { sampleCar } = await loadTS('src/geometry/sample.ts');
const { writeSTL } = await loadTS('src/geometry/stl.ts');

// Handles concave profiles; a convex hull would erase the diffuser's flat throat.
function extrude(profile, y0, y1) {
  // The side-wall ordering below requires a counterclockwise X/Z profile.
  // Earcut normalizes cap order independently; normalizing here keeps caps and sides consistent.
  if(ShapeUtils.isClockWise(profile.map(p=>new Vector2(...p))))profile=[...profile].reverse();
  const triangles = [], v = (i, y) => [profile[i][0], y, profile[i][1]];
  for (const [a, b, c] of ShapeUtils.triangulateShape(profile.map(p => new Vector2(...p)), [])) {
    triangles.push(...v(a, y0), ...v(b, y0), ...v(c, y0), ...v(a, y1), ...v(c, y1), ...v(b, y1));
  }
  for (let i = 0; i < profile.length; i++) {
    const j = (i + 1) % profile.length;
    triangles.push(...v(i, y0), ...v(i, y1), ...v(j, y1), ...v(i, y0), ...v(j, y1), ...v(j, y0));
  }
  let volume = 0;
  for (let i = 0; i < triangles.length; i += 9) {
    const [a,b,c,d,e,f,g,h,k] = triangles.slice(i, i+9);
    volume += a*(e*k-f*h)-b*(d*k-f*g)+c*(d*h-e*g);
  }
  if (volume < 0) for (let i = 0; i < triangles.length; i += 9) for (let j = 0; j < 3; j++) [triangles[i+3+j], triangles[i+6+j]] = [triangles[i+6+j], triangles[i+3+j]];
  return new Float32Array(triangles);
}
const roof = [[-2.1,.14],[-2.1,.6],[-1.65,.83],[-.7,.91],[-.28,1.32],[.85,1.32],[1.65,.86],[2.1,.72]];
function body(angle) {
  return extrude([...roof, [2.1,.14+.95*Math.tan(angle*Math.PI/180)], ...(angle ? [[1.15,.14]] : [])], -.81, .81);
}
function wing(angle) {
  const c=.32, m=.04, p=.4, t=.12, theta=angle*Math.PI/180;
  const top=[], bottom=[];
  for (let i=0;i<=64;i++) {
    const x=(1-Math.cos(i*Math.PI/64))/2;
    const yt=5*t*(.2969*Math.sqrt(x)-.126*x-.3516*x*x+.2843*x*x*x-.1036*x**4);
    const yc=x<p ? m/(p*p)*(2*p*x-x*x) : m/((1-p)**2)*(1-2*p+2*p*x-x*x);
    const dy=x<p ? 2*m/(p*p)*(p-x) : 2*m/((1-p)**2)*(p-x);
    const a=Math.atan(dy);
    const place=(xc,zc)=>[1.4+c*(xc*Math.cos(theta)+zc*Math.sin(theta)),1.5+c*(xc*Math.sin(theta)-zc*Math.cos(theta))];
    top.push(place(x-yt*Math.sin(a),yc+yt*Math.cos(a)));
    bottom.push(place(x+yt*Math.sin(a),yc-yt*Math.cos(a)));
  }
  return extrude([...top, ...bottom.reverse().slice(1,-1)], -.85, .85);
}
const merge=(...arrays)=>new Float32Array(arrays.flatMap(a=>[...a]));
const plate=(x0,x1,z0,z1,y0,y1)=>extrude([[x0,z0],[x1,z0],[x1,z1],[x0,z1]],y0,y1);
const specs = [
  { file:'body_flat.stl', name:'Flat-floor body', base:true, group:'g:body', positions:body(0), role:'body' },
  ...sampleCar().slice(1).map((p,i)=>({file:['wheel_front_left.stl','wheel_front_right.stl','wheel_rear_left.stl','wheel_rear_right.stl'][i],name:p.name,base:true,positions:p.positions,role:'wheel',wheel:p.wheel})),
  {file:'body_diffuser_7.stl',name:'Diffuser body 7 deg',positions:body(7),role:'body',replaces:'body_flat.stl'},
  {file:'body_diffuser_14.stl',name:'Diffuser body 14 deg',positions:body(14),role:'body',replaces:'body_flat.stl'},
  {file:'rear_wing_6.stl',name:'Rear wing 6 deg',positions:wing(6),role:'body'},
  {file:'rear_wing_12.stl',name:'Rear wing 12 deg',positions:wing(12),role:'body'},
  {file:'front_splitter.stl',name:'Front splitter',positions:plate(-2.30,-1.4,.12,.14,-.91,.91),role:'body'},
  {file:'canard_pair.stl',name:'Canard pair',positions:merge(extrude([[-2.03,.48],[-1.78,.525],[-1.78,.535],[-2.03,.49]],.80,1.06),extrude([[-2.03,.48],[-1.78,.525],[-1.78,.535],[-2.03,.49]],-1.06,-.80)),role:'body'},
  {file:'side_skirts.stl',name:'Side skirts',positions:merge(plate(-1.95,1.15,.04,.15,.80,.815),plate(-1.95,1.15,.04,.15,-.815,-.80)),role:'body'},
];
// Fail before shipping an open/non-manifold STL. Edge counts use exact Float32 vertices.
function validateClosedMesh(positions,name) {
  const edges=new Map();let volume=0;
  for(let i=0;i<positions.length;i+=9) {
    const p=[...positions.slice(i,i+9)];if(p.some(v=>!Number.isFinite(v)))throw new Error(`${name}: non-finite vertex`);
    const points=[p.slice(0,3).join(','),p.slice(3,6).join(','),p.slice(6,9).join(',')];
    for(let e=0;e<3;e++){const a=points[e],b=points[(e+1)%3];if(a===b)throw new Error(`${name}: degenerate edge`);const key=a<b?`${a}|${b}`:`${b}|${a}`,record=edges.get(key)??{count:0,direction:0};record.count++;record.direction+=a<b?1:-1;edges.set(key,record);}
    const [a,b,c,d,e,f,g,h,k]=p;volume+=(a*(e*k-f*h)-b*(d*k-f*g)+c*(d*h-e*g))/6;
  }
  if([...edges.values()].some(e=>e.count!==2||e.direction!==0))throw new Error(`${name}: mesh is open or inconsistently wound`);
  if(!(volume>0))throw new Error(`${name}: non-positive signed volume`);
  return volume;
}
const fileRecords=specs.map(({positions,...s})=>{
  const volume=validateClosedMesh(positions,s.file),bytes=new Uint8Array(writeSTL(positions,s.name));
  writeFileSync(resolve(out,s.file),bytes);
  return {...s,group:s.group??(s.base?'g:wheels':`g:file:${s.file}`),triangles:positions.length/9,sha256:createHash('sha256').update(bytes).digest('hex'),closedMesh:true,signedVolume_m3:volume};
});
const manifest = {version:1,description:'Synthetic teaching car; metres; nose -X; up +Z. Exactly one body must be active. Wing supports omitted.',files:fileRecords};
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(resolve(out,'README.txt'),`EasyCFD car-aerodynamics teaching pack (MIT)\nOriginal synthetic geometry, not a production car or engineered product.\nMetres; nose -X; up +Z; wheel radius .32 m; road gap .01 m.\nImport body_flat and four wheel files first, then add all remaining files.\nTurn optional groups off for baseline. Keep part switches on to retain the common grid.\nFor a diffuser test: turn Flat-floor body group OFF; turn exactly ONE diffuser body ON.\nNever simulate two body shells or two wing versions together.\nWing: inverted NACA 4412, .32 m chord, 1.7 m span, nominal 6/12 degrees.\nDiffuser: .95 m ramp, .14 m throat height, 7/14 degrees, built into alternative body.\nSplitter: .20 m forward overhang, .12 m lower surface; skirts: .04 m lower edge.\nCanards are flat teaching plates, not optimized airfoils. Wing mounts are omitted.\nThese dimensions are exercise parameters, not fitment or construction advice.\n`);
console.log(`Built ${specs.length} teaching meshes.`);
