import { add, balanceAtAxles, momentOrigin } from "../solver/aero";
import { estimateTyreLoads } from "../solver/tyreLoads";
import type { SurfaceSample, VizField } from "../solver/extract";
import type { ForceSample, PartForce, RunResult, Settings, Vec3 } from "../solver/types";
import type { WasmCase } from "./wasmCase";

export function wasmField(c: WasmCase, bytes: Uint8Array): VizField {
  const n=c.viz.dims.reduce((a,b)=>a*b,1);
  if (bytes.byteLength!==21*n) throw new Error("OpenFOAM returned an invalid flow field.");
  const buffer=bytes.slice().buffer;
  const f=(i:number)=>new Float32Array(buffer,4*n*i,n).slice();
  const valid=new Uint8Array(buffer,20*n,n);
  return {...c.viz,u:f(0),v:f(1),w:f(2),p:f(3),k:f(4),solid:valid.map(v=>v?0:1),freestream:c.freestream,inlet:c.inlet,length:c.length};
}

export function wasmResult(c:WasmCase,s:Settings,tsv:string,log:string,seconds:number,cells:number,meshId:string):RunResult {
  const rows=tsv.trim().split("\n").map(line=>line.trim().split(/\s+/).map(Number));
  if (!rows.length || rows.some(r=>r.length!==1+12*c.parts.length || r.some(v=>!Number.isFinite(v)))) throw new Error("OpenFOAM did not return finite, complete wall integrals.");
  const q=.5*s.density*c.freestream**2, qA=q*s.reference_area, origin=momentOrigin(s.axles);
  const vectors=(row:number[],i:number) => [0,1,2,3].map(k=>row.slice(1+12*i+3*k,4+12*i+3*k) as Vec3);
  const total=(row:number[]) => {
    let force:Vec3=[0,0,0], pressureMoment:Vec3=[0,0,0], frictionMoment:Vec3=[0,0,0];
    for (let i=0;i<c.parts.length;i++) { const [p,f,pm,fm]=vectors(row,i); force=add(force,add(p,f));pressureMoment=add(pressureMoment,pm);frictionMoment=add(frictionMoment,fm); }
    return {force,moment:add(pressureMoment,frictionMoment),pressureMoment,frictionMoment,origin};
  };
  const history:ForceSample[]=rows.map(row=>{
    const aero=total(row), balance=balanceAtAxles(aero,s.axles,qA);
    return {time:row[0],step:row[0],cd:aero.force[0]/qA,cl:aero.force[2]/qA,cs:aero.force[1]/qA,pitch:aero.moment[1],...(balance?{frontLift:balance.frontLift,rearLift:balance.rearLift}:{})};
  });
  const averagingIterations=Math.min(50,rows.length), tail=rows.slice(-averagingIterations);
  const average=(i:number)=>tail.reduce((sum,row)=>sum+row[i],0)/tail.length;
  const mean=rows[0].map((_,i)=>average(i));
  const aero=total(mean), balance=balanceAtAxles(aero,s.axles,qA);
  const partForces:PartForce[]=c.parts.map((p,i)=>{
    const [pressure,friction,pressureMoment,frictionMoment]=vectors(mean,i);
    return {id:p.id,name:p.name,group:p.group,pressure,friction,pressureMoment,frictionMoment};
  });
  const role=(role:"body"|"wheel",key:"pressure"|"friction")=>partForces.reduce((v,p,i)=>c.parts[i].role===role?add(v,p[key]):v,[0,0,0] as Vec3);
  const end=history.at(-1)!.step, last=history.slice(-averagingIterations);
  const span=(key:"cd"|"cl")=>Math.max(...last.map(h=>h[key]))-Math.min(...last.map(h=>h[key]));
  const cdSpan=span("cd"),clSpan=span("cl");
  const residuals:Record<string,number>={};
  for (const m of log.matchAll(/Solving for (\w+), Initial residual = ([-+\d.eE]+)/g)) residuals[m[1]]=Number(m[2]);
  const residualConverged=["p","Ux","Uy","Uz","k","omega"].every(k=>Number.isFinite(residuals[k]) && residuals[k]<(k==="k"||k==="omega"?1e-3:1e-4));
  const layerRows=[...log.matchAll(/Extruding (\d+) out of (\d+) faces/g)];
  const layer=layerRows.at(-1), layerCoverage=layer?Number(layer[1])/Math.max(1,Number(layer[2])):0;
  const warnings=["Light browser mesh: check mesh sensitivity with the connected OpenFOAM backend before relying on aerodynamic loads."];
  if (!c.layers) warnings.push("Quick uses wall functions without prism layers; near-wall resolution is limited.");
  else if (layerCoverage<.2) warnings.push("Prism layers cover less than 20% of the car wall; use the server for detailed near-wall analysis.");
  const settled=cdSpan<Math.max(.004,Math.abs(aero.force[0]/qA)*.03) && clSpan<Math.max(.008,Math.abs(aero.force[2]/qA)*.05);
  if (!settled) warnings.push("Forces are still changing over the last 50 iterations; this result is provisional.");
  if (!residualConverged) warnings.push("Solver residuals remain above target at the light preset's iteration limit.");
  const area=(c.domain[3]-c.domain[2])*c.domain[5], blockage=s.reference_area/area;
  if (blockage>.05) warnings.push("The tunnel's estimated blockage exceeds 5%; enlarge the simulation box.");
  return {
    engine:"openfoam",cd:aero.force[0]/qA,cl:aero.force[2]/qA,cs:aero.force[1]/qA,drag:aero.force[0],side:aero.force[1],lift:aero.force[2],downforce:-aero.force[2],
    aero,balance,tyreLoads:estimateTyreLoads(balance,s),partForces,
    breakdown:{bodyPressure:role("body","pressure"),bodyViscous:role("body","friction"),wheelPressure:role("wheel","pressure"),wheelViscous:role("wheel","friction")},
    history,settled,cdSpan,clSpan,cdBand:cdSpan/2,clBand:clSpan/2,cells,steps:end,simulatedTime:end,wallSeconds:seconds,
    freestream:c.freestream,dynamicPressure:q,domain:c.domain,blockage,warnings,length:c.length,gridId:meshId,
    reconciliation:{complete:true,forceError:0,momentError:0,forceTolerance:1e-8,momentTolerance:1e-8},
    provenance:{version:"openfoam-wasm-wall-integrals-1",averaging:{start:tail[0][0],end,unit:"iteration"},origin,qualification:"exploratory",mesh:meshId,pipeline:"OpenFOAM-v2512 / serial SIMPLE / kOmegaSST / double precision"},
    openfoam:{runtime:"wasm",run:meshId,iterations:end,averagingIterations,residuals,residualConverged,meshOk:true,layerCoverage,offset:[0,0,0]},
  };
}

interface Node { face:number;axis:number;left?:Node;right?:Node }

/** Patch-specific nearest finite-volume face; never borrow pressure from another part. */
export function wasmSurface(c:WasmCase,faces:Uint8Array[],settings:Settings,iteration:number,grid:string):SurfaceSample[] {
  return c.parts.map((part,pi)=>{
    const a=new Float32Array(faces[pi].slice().buffer), count=a.length/14;
    if (!Number.isInteger(count) || count<6 || a.some(v=>!Number.isFinite(v))) throw new Error(`${part.name} has invalid OpenFOAM surface values.`);
    const build=(ids:number[],depth=0):Node|undefined=>{
      if (!ids.length) return;
      const axis=depth%3;ids.sort((i,j)=>a[14*i+axis]-a[14*j+axis]);const mid=ids.length>>1;
      return {face:ids[mid],axis,left:build(ids.slice(0,mid),depth+1),right:build(ids.slice(mid+1),depth+1)};
    };
    const tree=build(Array.from({length:count},(_,i)=>i));
    const closest=(p:number[])=>{
      let best=-1,d2=Infinity;
      const visit=(n:Node|undefined)=>{
        if (!n) return;
        const base=n.face*14,d=(a[base]-p[0])**2+(a[base+1]-p[1])**2+(a[base+2]-p[2])**2;
        if(d<d2){d2=d;best=n.face;}
        const delta=p[n.axis]-a[base+n.axis];
        visit(delta<0?n.left:n.right);if(delta*delta<d2)visit(delta<0?n.right:n.left);
      };visit(tree);return {face:best,d2};
    };
    const cp=new Float32Array(part.positions.length/3).fill(NaN), shear=new Float32Array(part.positions.length), wallStress=new Float32Array(part.positions.length), stressValid=new Uint8Array(cp.length);
    for(let t=0;t<part.positions.length;t+=9){
      const p=[0,1,2].map(k=>(part.positions[t+k]+part.positions[t+3+k]+part.positions[t+6+k])/3);
      const near=closest(p),o=14*near.face;
      if(near.d2>Math.max(9*a[o+13],(c.h/2**2)**2*4))continue;
      const n=a.subarray(o+3,o+6), vel=a.subarray(o+10,o+13), dot=vel[0]*n[0]+vel[1]*n[1]+vel[2]*n[2];
      for(let v=0;v<3;v++){
        const i=t/3+v;cp[i]=a[o+6];stressValid[i]=1;
        for(let k=0;k<3;k++){wallStress[3*i+k]=a[o+7+k];shear[3*i+k]=vel[k]-dot*n[k];}
      }
    }
    return {cp,shear,wallStress,stressValid,snapshot:{iteration,grid,unit:"Pa",dynamicPressure:.5*settings.density*c.freestream**2}};
  });
}
