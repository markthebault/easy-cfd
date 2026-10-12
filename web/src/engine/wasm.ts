import type { SurfaceSample, VizField } from "../solver/extract";
import type { ForceSample, RunResult, Settings, SolverPart } from "../solver/types";
import type { CaseFiles } from "./wasmCase";

export interface WasmProgress {
  stage:"preparing"|"solving"|"saving";
  label:string; iteration:number; iterations:number; cells:number; history:ForceSample[]; elapsed:number;
}
export interface WasmOutcome {result:RunResult;field:VizField;surface:SurfaceSample[];log:string;caseFiles?:CaseFiles}

/** Same viewer contract as the server adapter; computation stays in a dedicated local worker. */
export function runBrowserOpenFoam(parts:SolverPart[],settings:Settings,options:{signal:AbortSignal;onProgress?:(p:WasmProgress)=>void;onSnapshot?:(f:VizField)=>void;includeCaseFiles?:boolean}):Promise<WasmOutcome> {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL("../workers/openfoam.worker.ts",import.meta.url),{type:"module"});
    let done=false;
    const finish=(fn:()=>void)=>{if(done)return;done=true;clearTimeout(timer);options.signal.removeEventListener("abort",abort);worker.terminate();fn();};
    const abort=()=>finish(()=>reject(new DOMException("Simulation cancelled","AbortError")));
    const limit=Math.min(settings.max_seconds??(settings.quality==="fast"?300:600),settings.quality==="fast"?300:600);
    const timer=setTimeout(()=>finish(()=>reject(new Error(`Browser OpenFOAM reached its ${limit}-second whole-job limit. Try Quick, simplify the model, or connect the server.`))),limit*1000);
    options.signal.addEventListener("abort",abort,{once:true});
    if(options.signal.aborted){abort();return;}
    worker.onerror=e=>finish(()=>reject(new Error(e.message||"The OpenFOAM worker stopped unexpectedly.")));
    worker.onmessage=({data})=>{
      if(data.type==="progress")options.onProgress?.(data.value);
      else if(data.type==="snapshot")options.onSnapshot?.(data.value);
      else if(data.type==="done")finish(()=>resolve(data.value));
      else if(data.type==="error")finish(()=>reject(new Error(data.message)));
    };
    const copy=parts.map(p=>({...p,positions:p.positions.slice()}));
    const assetBase=new URL(`${import.meta.env.BASE_URL}openfoam/`,document.baseURI).href;
    worker.postMessage({parts:copy,settings,assetBase,includeCaseFiles:options.includeCaseFiles},copy.map(p=>p.positions.buffer));
  });
}
