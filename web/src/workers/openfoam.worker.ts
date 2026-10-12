/// <reference lib="webworker" />
import { balanceAtAxles, momentOrigin } from "../solver/aero";
import { prepareWasmCase, type CaseFiles } from "../engine/wasmCase";
import { wasmField, wasmResult, wasmSurface } from "../engine/wasmResults";
import type { WasmProgress } from "../engine/wasm";
import type { ForceSample, Settings, SolverPart, Vec3 } from "../solver/types";

interface FS {
  mkdirTree(path:string):void;writeFile(path:string,data:Uint8Array):void;readFile(path:string):Uint8Array;
  readdir(path:string):string[];stat(path:string):{mode:number};isDir(mode:number):boolean;
}
interface Module { FS:FS; ENV:Record<string,string>; callMain(args:string[]):number }
interface Manifest {modules:Record<string,{chunks:string[];gzipChunks?:string[];bytes:number;sha256:string}>}
const send=(type:string,value:unknown)=>self.postMessage({type,value});

async function fetchBytes(url:string):Promise<Uint8Array>{const r=await fetch(url);if(!r.ok)throw new Error(`Could not load the static OpenFOAM asset (${r.status}): ${url.split("/").at(-1)}`);return new Uint8Array(await r.arrayBuffer());}

function putFiles(fs:FS,files:CaseFiles){for(const [path,bytes] of Object.entries(files)){const full=`/case/${path}`;fs.mkdirTree(full.slice(0,full.lastIndexOf("/")));fs.writeFile(full,bytes);}}
function readTree(fs:FS,path:string,out:CaseFiles,prefix=""){
  for(const name of fs.readdir(path)){
    if(name==="."||name==="..")continue;
    const full=`${path}/${name}`,key=prefix+name;
    if(fs.isDir(fs.stat(full).mode))readTree(fs,full,out,key+"/");else out[key]=fs.readFile(full).slice();
  }
}

self.onmessage=async({data}:{data:{parts:SolverPart[];settings:Settings;assetBase:string;includeCaseFiles?:boolean}})=>{
  const started=performance.now();
  let label="Preparing OpenFOAM case",stage:WasmProgress["stage"]="preparing",iteration=0,cells=0,iterations=0,log="";
  const history:ForceSample[]=[];
  let files:CaseFiles|undefined,module:Module|undefined;
  const progress=()=>send("progress",{stage,label,iteration,iterations,cells,history:history.slice(),elapsed:(performance.now()-started)/1000} satisfies WasmProgress);
  try{
    progress();
    const c=prepareWasmCase(data.parts,data.settings);iterations=c.iterations;
    files=c.files;
    const manifest=JSON.parse(new TextDecoder().decode(await fetchBytes(data.assetBase+"manifest.json"))) as Manifest;
    const [controlDict,cellModels]=await Promise.all([fetchBytes(data.assetBase+"controlDict"),fetchBytes(data.assetBase+"cellModels")]);
    let moduleLog="", lastProgress=0;
    const print=(line:string)=>{
      log+=line+"\n";moduleLog+=line+"\n";
      if(line.startsWith("EASYCFD_CELLS "))cells=Number(line.split(" ")[1]);
      if(line.startsWith("EASYCFD_FORCE ")){
        const a=line.split(/\s+/).slice(1).map(Number);iteration=a[0];
        const aero={force:a.slice(4,7) as Vec3,moment:a.slice(7,10) as Vec3,pressureMoment:a.slice(7,10) as Vec3,frictionMoment:[0,0,0] as Vec3,origin:momentOrigin(data.settings.axles)};
        const balance=balanceAtAxles(aero,data.settings.axles,.5*data.settings.density*c.freestream**2*data.settings.reference_area);
        history.push({time:iteration,step:iteration,cd:a[1],cl:a[2],cs:a[3],pitch:a[8],...(balance?{frontLift:balance.frontLift,rearLift:balance.rearLift}:{})});
      }
      if(line.startsWith("EASYCFD_FIELD ")&&module)send("snapshot",wasmField(c,module.FS.readFile("/case/easycfd/field.bin")));
      if(performance.now()-lastProgress>150){lastProgress=performance.now();progress();}
    };
    for(const [app,title] of [["blockMesh","Building wind tunnel"],["snappyHexMesh","Meshing car in OpenFOAM"],["checkMesh","Checking car mesh"],["browserFoam","Solving OpenFOAM / k–ω SST"]]){
      label=title;stage=app==="browserFoam"?"solving":"preparing";progress();
      const info=manifest.modules[app];if(!info)throw new Error(`Static OpenFOAM build is missing ${app}. Run wasm/build.sh.`);
      const compressed=!!info.gzipChunks && typeof DecompressionStream !== "undefined";
      const chunks=await Promise.all((compressed?info.gzipChunks!:info.chunks).map(name=>fetchBytes(data.assetBase+name)));
      const bytes=compressed
        ? new Uint8Array(await new Response(new Blob(chunks).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
        : new Uint8Array(await new Blob(chunks).arrayBuffer());
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
      if(bytes.length!==info.bytes||hash!==info.sha256)throw new Error(`OpenFOAM ${app} download failed its integrity check. Reload and try again.`);
      const create=(await import(/* @vite-ignore */ data.assetBase+app+".js")).default;
      module=await create({wasmBinary:bytes,print,printErr:print,noInitialRun:true,
        preRun:[(m:Module)=>{m.ENV.WM_PROJECT_DIR="/foam";m.ENV.FOAM_ETC="/foam/etc";m.ENV.FOAM_MPI="dummy";m.ENV.HOME="/home/wasm";m.FS.mkdirTree("/foam/etc");m.FS.mkdirTree("/home/wasm");m.FS.writeFile("/foam/etc/controlDict",controlDict);m.FS.writeFile("/foam/etc/cellModels",cellModels);}]}) as Module;
      putFiles(module.FS,files);moduleLog="";
      const args=["-case","/case",...(app==="snappyHexMesh"?["-overwrite"]:app==="checkMesh"?["-allTopology","-meshQuality"]:[])];
      let status=0;
      try{status=module.callMain(args);}catch(e){
        if(e && typeof e==="object" && "status" in e)status=Number(e.status);else throw e;
      }
      if(status!==0 || /FOAM FATAL/.test(moduleLog))throw new Error(`${title} failed. ${moduleLog.slice(-2400)}`);
      // Layer extrusion can write moved points/fields in 0/polyMesh as well as
      // constant/polyMesh. Preserve OpenFOAM's instance selection across tools.
      files={};readTree(module.FS,"/case",files);
      if(app==="snappyHexMesh" && /reached.*(?:limit|maxGlobalCells)|maximum number of cells/i.test(moduleLog))throw new Error("Car meshing reached the light preset's cell budget. Choose Fast or connect the OpenFOAM server.");
      if(app==="checkMesh"){
        if(!moduleLog.includes("Mesh OK."))throw new Error(`The car mesh failed OpenFOAM's quality checks. Try Fast or a server mesh. ${moduleLog.slice(-1800)}`);
        cells=Number(moduleLog.match(/^\s*cells:\s*(\d+)/m)?.[1]??0);
        if(!cells||cells>c.maxCells)throw new Error("The car mesh exceeds the browser cell budget.");
      }
      // Keep one module's heap at a time; mesh files are the boundary between tools.
      if(app!=="browserFoam")module=undefined;
    }
    stage="saving";label="Sampling computed airflow and surface pressure";progress();
    if(!module)throw new Error("OpenFOAM solver did not finish.");
    const fs=module.FS;
    const meshFiles=Object.entries(files).filter(([name])=>/polyMesh\/(points|faces|owner|neighbour|boundary)$/.test(name)).sort(([a],[b])=>a.localeCompare(b));
    const meshBytes=new Uint8Array(meshFiles.reduce((n,[,bytes])=>n+bytes.length,0));
    let meshOffset=0;for(const [,bytes] of meshFiles){meshBytes.set(bytes,meshOffset);meshOffset+=bytes.length;}
    const meshHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",meshBytes)),v=>v.toString(16).padStart(2,"0")).join("");
    const grid=`openfoam-wasm:${meshHash}`;
    const result=wasmResult(c,data.settings,new TextDecoder().decode(fs.readFile("/case/easycfd/history.tsv")),log,(performance.now()-started)/1000,cells,grid);
    const field=wasmField(c,fs.readFile("/case/easycfd/field.bin"));
    const surface=wasmSurface(c,c.patches.map(p=>fs.readFile(`/case/easycfd/${p}.bin`)),data.settings,result.steps,grid);
    result.wallSeconds=(performance.now()-started)/1000;
    if(data.includeCaseFiles){readTree(fs,"/case",files);files["wasm.log"]=new TextEncoder().encode(log);}
    send("done",{result,field,surface,log,...(data.includeCaseFiles?{caseFiles:files}:{})});
  }catch(e){
    const message=e instanceof Error?e.message:`OpenFOAM stopped (${String(e)}). ${log.slice(-2400)}`;
    const caseFiles:CaseFiles={};
    if(data.includeCaseFiles && module){try{readTree(module.FS,"/case",caseFiles);}catch{/* Preserve the primary error. */}}
    self.postMessage({type:"error",message,...(data.includeCaseFiles?{caseFiles,log}:{})});
  }
};
