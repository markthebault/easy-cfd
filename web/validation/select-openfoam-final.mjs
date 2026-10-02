// Choose one common final configuration from measured shared cases; never fit force multipliers.
import {readFileSync,writeFileSync,readdirSync} from "node:fs";
import {dirname,resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {comparison} from "./accuracy-metrics.mjs";

const evidence=resolve(dirname(fileURLToPath(import.meta.url)),"../../docs/webgpu-openfoam-algorithm");
const read=file=>JSON.parse(readFileSync(join(evidence,file),"utf8"));
const suite=read("source-audit.json").acceptance.suite, refs=read("references.json");
const records=readdirSync(join(evidence,"iterations")).filter(f=>/^\d{3}\.json$/.test(f)).sort().map(f=>read("iterations/"+f));
if(records.length!==41 || records.some(r=>r.status==="running")) throw new Error("Finish the 41 development attempts before selecting the final suite");
const shared=["sample","mx5"];
const candidates=["implicit-sst-projection","implicit-sst-simplec","geometric-projection","long-geometric-simplec"].map(key=>{
  const rows=shared.map(model=>records.find(r=>r.key===`${key}-${model}`));
  const valid=rows.every(r=>r?.status==="completed");
  const metrics=valid?rows.map(r=>comparison(r.result,refs[r.model],.05)):[];
  const eligible=valid && metrics.every(c=>c.finite && c.conserved);
  return {key,eligible,meanRelativeError:eligible?metrics.reduce((sum,c)=>sum+c.cdError+c.clError,0)/(2*shared.length):null,
    worstRelativeError:valid?Math.max(...metrics.flatMap(c=>[c.cdError,c.clError])):null,
    iterations:rows.map(r=>r?.iteration),forceSettled:valid && metrics.every(c=>c.stable),
    settings:rows[0]?.settings,solver:rows[0]?.spec.solver};
});
const selected=candidates.filter(c=>c.eligible).sort((a,b)=>a.meanRelativeError-b.meanRelativeError)[0];
if(!selected)throw new Error("No finite, conserved common candidate available");
const long=records.filter(r=>r.key.startsWith("long-") && r.status==="completed");
const checks=long.map(r=>({iteration:r.iteration,model:r.model,residuals:r.result.transportResiduals}));
const fourSweepsAdequate=long.length===8 && checks.every(c=>["k","omega"].every(component=>c.residuals?.[component]?.reduction<.1));
const settings={...selected.settings,custom_passes:40,max_seconds:1800};
for(const key of ["speed_kmh","yaw_deg","reference_area","density","moving_ground","wheels","quality"])delete settings[key];
const solver={...selected.solver,sstSweeps:fourSweepsAdequate?4:8};
const make=(model,key)=>({key,model,hypothesis:"One common lower-error source-derived configuration, longer runtime, final exact 500,000-cell check; new-omega production cap applied to every model",settings:{...settings},solver:{...solver},maxExtension:1});
const plan=[...suite.map(model=>make(model,`final-${model}`)),make("sample","final-sample-repeat")];
const selection={criterion:"mean relative drag and signed-lift error on the matched sample and MX-5 cases, requiring finite conserved fields; longest available run per candidate",
  sharedModels:shared,candidates,selected:selected.key,finalPasses:40,finalCells:500000,finalSstSweeps:solver.sstSweeps,
  linearSolver:{nativeRelativeTolerance:.1,fourSweepsAdequate,checks},
  note:"This chooses one measured candidate for all final models. Force settling and the 5 percent coefficient gate are checked independently on the final suite. Candidate screens have 20 passes; the full implicit geometry suite has 30. Final source also corrects the omega-dependent k production cap and reduces buffer copying; it must pass kernel validation before use."};
writeFileSync(join(evidence,"selection.json"),JSON.stringify(selection,null,2)+"\n");
writeFileSync(join(evidence,"plan-final.json"),JSON.stringify(plan,null,2)+"\n");
console.log(JSON.stringify({selected:selection.selected,meanRelativeError:selected.meanRelativeError,finalSstSweeps:solver.sstSweeps}));
