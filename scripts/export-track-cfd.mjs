// Export saved OpenFOAM output using the SAME field/surface endpoints as the wind-tunnel workspace.
// node scripts/export-track-cfd.mjs [backend URL] [completed run ID]
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const backend=process.argv[2]||'http://127.0.0.1:8780';
const runId=process.argv[3]||'d6cf04cb0d504706a73c9c19a45623fe';
const out=new URL('../web/public/track-cfd/',import.meta.url);
await mkdir(out,{recursive:true});
async function request(path,init){const r=await fetch(`${backend}/api/runs/${runId}${path}`,init);if(!r.ok)throw Error(`${path}: ${r.status} ${await r.text()}`);return r;}
const run=await (await request('')).json();
if(run.status!=='completed')throw Error('A completed OpenFOAM run is required');
const [low,high]=run.geometry.bounds,L=high[0]-low[0],W=high[1]-low[1],d=run.domain;
// vizBoxFor / vizGrid from solver/extract.ts, with the main workspace's 900,000-point target.
const origin=[Math.max(d[0],low[0]-.6*L),Math.max(d[2],low[1]-.25*W-.25*L),0];
const end=[Math.min(d[1],high[0]+2.2*L),Math.min(d[3],high[1]+.25*W+.25*L),Math.min(d[5],high[2]+.45*L)];
const extent=end.map((x,i)=>x-origin[i]),h=Math.cbrt(extent.reduce((a,b)=>a*b,1)/900000);
const dims=extent.map(x=>Math.max(8,Math.round(x/h))),spacing=extent.map((x,i)=>x/(dims[i]-1));
const hashes={};
async function save(name,data){const bytes=ArrayBuffer.isView(data)?Buffer.from(data.buffer,data.byteOffset,data.byteLength):Buffer.from(data);await writeFile(new URL(name+'.gz',out),gzipSync(bytes));hashes[name]=createHash('sha256').update(bytes).digest('hex');return name+'.gz';}
console.log('Sampling saved volume',dims);
const field=await save('field.bin',await (await request('/viz-field',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,spacing,dims})})).arrayBuffer());
const parts=[];
for(const p of run.geometry.parts.filter(p=>p.enabled!==false)){
 console.log('Sampling solved geometry and wall pressure',p.id);
 const stl=await (await request(`/geometry/${p.id}.stl`)).arrayBuffer();const v=new DataView(stl),count=v.getUint32(80,true),positions=new Float32Array(count*9);
 for(let t=0;t<count;t++)for(let k=0;k<9;k++)positions[t*9+k]=v.getFloat32(84+t*50+12+k*4,true);
 const surface=await (await request(`/surface-samples?version=2&part_id=${p.id}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:positions})).arrayBuffer();
 const header=new Uint32Array(surface,0,4);if(header[0]!==0x53464345||header[1]!==2||header[2]!==positions.length/3)throw Error('Invalid wall data');
 parts.push({id:p.id,name:p.name,role:p.role,wheel:p.wheel,vertices:positions.length/3,positions:await save(p.id+'-positions.bin',positions),cp:await save(p.id+'-cp.bin',new Uint8Array(surface,16,header[2]*4))});
}
await writeFile(new URL('manifest.json',out),JSON.stringify({version:1,engine:'openfoam',runId,created:run.created,sourceName:run.name,settings:{speed_kmh:run.settings.speed_kmh,yaw_deg:run.settings.yaw_deg,density:run.settings.density,reference_area:run.settings.reference_area,moving_ground:run.settings.moving_ground,wheels:run.settings.wheels},bounds:{low,high},field:{file:field,origin,spacing,dims,freestream:run.result.freestream,inlet:run.result.mesh_recipe.velocity,length:L},parts,cpRange:[-1.5,1],speedMax:run.result.ranges.Speed[1],result:{cd:run.result.cd,cl:run.result.cl,cells:run.result.cells,forceSettled:run.result.force_settled,residualConverged:run.result.residual_converged,warnings:run.result.warnings,provenance:run.result.provenance},hashes},null,2)+'\n');
console.log('Export complete; float32 samples preserved, lossless gzip, SHA-256 manifest.');
