// Independent follow-up campaign. The original 100-trial archive is never rewritten.
import {readFileSync,writeFileSync,readdirSync} from "node:fs";
import {dirname,resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {comparison} from "./accuracy-metrics.mjs";

const repository=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const evidence=join(repository,"docs/webgpu-openfoam-algorithm");
const read=file=>JSON.parse(readFileSync(join(evidence,file),"utf8"));
const manifest=read("campaign.json"), references=read("references.json");
const suite=read("source-audit.json").acceptance.suite;
const records=readdirSync(join(evidence,"iterations")).filter(f=>/^\d{3}\.json$/.test(f)).sort().map(f=>read("iterations/"+f));
if(manifest.limit!==50 || manifest.tolerance!==.05 || records.length>50) throw new Error("Campaign budget changed or exceeded");
if(records.some((r,i)=>r.iteration!==i+1)) throw new Error("Missing or duplicate attempted iteration");
const evaluated=records.map(r=>({...r,comparison:r.status==="completed"?comparison(r.result,references[r.model],manifest.tolerance):null}));
const final=evaluated.filter(r=>r.key.startsWith("final-") && !r.key.includes("repeat"));
const modelInputs=new Set(["speed_kmh","yaw_deg","reference_area","density","moving_ground","wheels"]);
const numericalSignature=r=>JSON.stringify({settings:Object.fromEntries(Object.entries(r.settings).filter(([key])=>!modelInputs.has(key)).sort(([a],[b])=>a.localeCompare(b))),solver:r.spec.solver,source:r.source,revision:r.sourceRevision});
const sameFinalConfiguration=final.length>0 && new Set(final.map(numericalSignature)).size===1;
if(final.length && !sameFinalConfiguration)throw new Error("Final cases do not use one common numerical configuration and source");
const allFinal=suite.length===final.length && suite.every(model=>final.some(r=>r.model===model && r.status==="completed" && r.result.cells===500000));
const agrees=allFinal && final.every(r=>r.comparison.agrees);
const healthy=allFinal && final.every(r=>r.comparison.stable && r.comparison.finite && r.comparison.conserved);
const completed=evaluated.filter(r=>r.status==="completed");
const failures=evaluated.filter(r=>r.status==="failed");
const best=suite.map(model=>completed.filter(r=>r.model===model && r.result.cells===500000).sort((a,b)=>Math.max(a.comparison.cdError,a.comparison.clError)-Math.max(b.comparison.cdError,b.comparison.clError))[0]).filter(Boolean);
const sameModel=evaluated.find(r=>r.key==="final-sample-repeat");
const firstSample=final.find(r=>r.model==="sample");
const repeat=sameModel?.status==="completed" && firstSample?.status==="completed"?{
  cdRelativeDifference:Math.abs(sameModel.result.cd-firstSample.result.cd)/Math.max(Math.abs(firstSample.result.cd),.01),
  clRelativeDifference:Math.abs(sameModel.result.cl-firstSample.result.cl)/Math.max(Math.abs(firstSample.result.cl),.01),
}:null;
let selection=null, fields=[];
try {selection=read("selection.json");} catch(error) {if(error.code!=="ENOENT")throw error;}
try {fields=read("field-comparisons.json").filter(r=>r.iteration>=42);} catch(error) {if(error.code!=="ENOENT")throw error;}
const summary={...manifest,attempts:records.length,completed:completed.length,failed:failures.length,
  budgetExhausted:records.length===manifest.limit && records.every(r=>r.status!=="running"),
  finalSuiteComplete:allFinal,sameFinalConfiguration,finalCoefficientAgreement:agrees,finalHealthyFields:healthy,
  bothCoefficientsBelowTarget:completed.filter(r=>r.result.cells===500000 && r.comparison.agrees).length,
  finalPassingCases:final.filter(r=>r.comparison?.agrees).length,
  targetMet:agrees && healthy,physicallyQualified:allFinal && final.every(r=>r.comparison.qualified),
  final:final.map(r=>({iteration:r.iteration,key:r.key,model:r.model,algorithm:r.result?.algorithm,transportResiduals:r.result?.transportResiduals,cells:r.result?.cells,fluidCells:r.result?.diagnostics?.fluidCount,cd:r.result?.cd,cl:r.result?.cl,comparison:r.comparison,reference:references[r.model]})),
  bestPerModel:best.map(r=>({iteration:r.iteration,model:r.model,cd:r.result.cd,cl:r.result.cl,comparison:r.comparison})),repeat,selection};
writeFileSync(join(evidence,"evaluation.json"),JSON.stringify(summary,null,2)+"\n");
const columns=["iteration","key","model","status","cells","fluidCells","passes","algorithm","cd","cl","cdErrorPct","clErrorPct","stable","finite","conserved","wallSeconds","sourceSnapshot","source"];
const csv=[columns.join(","),...evaluated.map(r=>{
  const data={...r,cells:r.result?.cells,fluidCells:r.result?.diagnostics?.fluidCount,passes:r.settings.custom_passes,algorithm:r.result?.algorithm,cd:r.result?.cd,cl:r.result?.cl,cdErrorPct:100*r.comparison?.cdError,clErrorPct:100*r.comparison?.clError,stable:r.comparison?.stable,finite:r.comparison?.finite,conserved:r.comparison?.conserved,wallSeconds:r.result?.wallSeconds};
  return columns.map(key=>JSON.stringify(data[key]??"")).join(",");
})].join("\n")+"\n";
writeFileSync(join(evidence,"trials.csv"),csv);
const pct=x=>Number.isFinite(x)?(100*x).toFixed(1)+"%":"—";
const num=x=>Number.isFinite(x)?x.toFixed(5):"—";
const table=rows=>"| Model | Native Cd | WebGPU Cd | Drag error | Native Cl | WebGPU Cl | Lift error | Stable, finite, conserved |\n|---|---:|---:|---:|---:|---:|---:|---|\n"+rows.map(r=>`| ${r.model} | ${num(references[r.model]?.cd)} | ${num(r.result?.cd)} | ${pct(r.comparison?.cdError)} | ${num(references[r.model]?.cl)} | ${num(r.result?.cl)} | ${pct(r.comparison?.clError)} | ${r.comparison?.stable && r.comparison?.finite && r.comparison?.conserved?"yes":"no"} |`).join("\n");
const text=`# WebGPU / OpenFOAM algorithm study: 5% target, 50-attempt limit

${summary.budgetExhausted?"Stopped at the requested 50 attempted simulations.":`Campaign in progress: ${records.length}/50 attempts.`} ${completed.length} completed; ${failures.length} failed. ${summary.targetMet?"The final eight-case suite meets the requested coefficient and field-health gates.":"The final suite has not met the requested target."} ${summary.finalPassingCases}/8 final cases meet both coefficient bounds. Both drag and signed lift must have a relative error strictly below 5%; opposite-sign lift cannot pass. A relative-error denominator floor of 0.01 applies near zero.

This follow-up is separate from the [previous 100-attempt, 3% study](../webgpu-accuracy/README.md). The new campaign manifest fixes its limit and tolerance on first use; resuming cannot raise either. Every attempted model solve, including failed initialization or divergent flow, uses one slot. Raw attempts, geometry SHA-256 values, solver settings, source SHA-256 values and wake samples remain in [iterations](iterations/). Attempts 14–25 used a per-trial source snapshot. A queued batch captured an incomplete shader interface after a live source edit and attempts 19–25 failed initialization; those seven failures remain in the count. From attempt 26 onward, Vite loads all TypeScript sources from one committed revision for the whole plan, and the runner stops at the first kernel initialization failure. The recorded [kernel validation](kernel-validation.json) compiles both momentum paths and checks the SST scalar operator with zero fluid steps before a new revision is used. Earlier attempts used a fresh document/device and disabled HMR, with the source digest captured immediately before launch.

## What the source review changed

The audit uses the source installed in the pinned OpenFOAM v2412 image, not a different online release. [Source identities and case dictionaries](source-audit.json) retain the exact image digest and hashes of the inspected files. The native case uses bounded linearUpwindV momentum convection, cellLimited Gauss velocity gradients, implicit upwind SST transport, limited non-orthogonal diffusion, SIMPLE consistent=yes, momentum/k/omega relaxation 0.7 and pressure relaxation 0.3.

The experimental WebGPU path independently implements an implicit staggered finite-volume momentum matrix, relaxed at assembly. Linear upwind corrections are deferred to its source. Jacobi sweeps solve the momentum predictor with the previous pressure. Its pressure mobility comes from the same matrix diagonal, and the Galerkin pressure hierarchy is rebuilt on the GPU. The SIMPLEC option uses the diagonal minus the neighbour-coefficient sum, and includes the old-pressure correction in the predictor before solving for the new pressure. Pseudo-time damping stabilizes difficult starts without importing native fields.

The implicit SST option assembles bounded upwind transport, diffusion and destruction into relaxed scalar matrices. It solves omega first, uses the new omega in the k destruction term and production cap, then updates eddy viscosity. Independent affine manufactured solutions check the GPU scalar solver and this omega-to-k coupling, including an active production cap. These checks validate the operator, not aerodynamic accuracy.\n\nOther source-derived changes interpolate SST effective diffusivity at faces; use deviatoric production and conservative flux divergence for SST source terms; limit velocity gradients; use signed-distance wall geometry for SST blending; and match direction-dependent side pressure mixing and inlet/outlet velocity/turbulence conditions. Pressure integration uses the actual cell when pressure merging is disabled. Rotating-wall velocity is projected onto the tangent plane for SST gradients. An optional clipped-tetrahedron geometry method integrates fluid volume and centroid and uses compatible clipped-triangle face areas. Road shear and SST wall distance can use the fluid centroid height rather than half the full cell width; a configurable floor avoids overstating wall distance in sliver cells.

**Correction to the earlier study:** its claim that stepwise omega blending matched this case's default was wrong. The dictionary constructor in v2412 selects binomial blending of exponent two. This campaign keeps binomial blending.

The formulas and algorithms can be implemented on WebGPU. This experimental implementation still differs in discretization: it uses a Cartesian staggered cut-cell mesh, estimated dual-cell apertures, Cartesian diffusion and pressure coordinates, scalar convection limiting and fixed Jacobi sweeps. Native OpenFOAM uses a conforming collocated polyhedral mesh with wall layers, vector convection limiting, non-orthogonal corrections and residual-controlled matrix solves. Native pressure field relaxation of 0.3 and its separate collocated flux construction are also still absent. Copying turbulence formulas alone does not reproduce the native matrices on a different mesh. The source audit records these remaining differences.

## Final 500,000-cell comparison

${table(final)}

Each final run uses 40 flow passes on exactly 500,000 interior Cartesian grid cells, including solid cells and excluding ghosts. Development runs grew from 125,000 and 250,000 cells to 500,000 cells, then increased from 20 to 30 and 40 passes. Actual fluid counts are recorded separately in evaluation.json and each attempt. Geometry, speed, yaw, reference area, density, moving ground and wheel settings match each native reference. [Actual native STL and input checks](geometry-input-audit.json) verify all eight pairs. [Domain bounds](domain-audit.json) compare the actual native tunnel to the browser tunnel, with a 1e-5 metre tolerance for imported float32 geometry. Native meshes have their own fluid-cell counts. All GPU solves start from freestream plus an initial divergence-free projection; no OpenFOAM velocity, pressure or turbulence result is supplied to the solver.

${selection?`The final configuration was selected using ${selection.criterion}. Selected: **${selection.selected}**. Selection is based on the recorded comparisons, not per-model fitted correction factors. The selected final path retains projection momentum and uses implicit SST with ${selection.finalSstSweeps} scalar sweeps, four pressure multigrid cycles, 24 coarse sweeps, geometric cut fractions and fluid-centroid road distances. The eight-case full implicit momentum/SIMPLEC suite is retained as attempts 34–41.`:"Final configuration selection is pending."}

${repeat?`The independent sample repeat differed by ${(100*repeat.cdRelativeDifference).toFixed(4)}% in Cd and ${(100*repeat.clRelativeDifference).toFixed(4)}% in Cl. Exact differences are in evaluation.json.`:"The independent final sample repeat is pending."}

![All attempted coefficient comparisons](iterations.png)

![Final native and WebGPU coefficients](final-comparison.png)

## Best individual 500,000-cell attempts

The rows below may use different settings. They describe the search, not one qualified general-purpose solver.

${table(best)}

## Wake fields and reference limits

${fields.length?"| Case / iteration | Valid wake points | Velocity relative L2 error | Cp absolute RMS error |\n|---|---:|---:|---:|\n"+fields.map(r=>`| ${r.model} / ${r.iteration} | ${r.validPoints}/${r.points} | ${pct(r.velocityRelativeL2)} | ${r.pressureCpRms.toFixed(4)} |`).join("\n"):"Final wake field comparisons are pending."}

Coefficient agreement is checked separately from physical qualification. Healthy fields require finite values, no velocity clipping, relative divergence at most 0.001, settled forces and final force bands at most 1%. The native sample reference still has unresolved force/residual and mesh-convergence limits; native MX-5 still has unresolved residual/mesh-convergence limits; Ahmed has settled forces and converged residuals but no demonstrated mesh independence. None of these are promoted to a physical 5% accuracy claim. The pinned native references were reused from the preceding campaign; no changed geometry or numerical target was introduced to manufacture agreement.

## Validation and reproduction

[Recorded checks](checks.json) retain the production build, 53 passing CPU tests, Python and JavaScript checks, kernel compilation and independent GPU scalar-operator validation. These software checks passed; the CFD target did not. Native input and field audits are separate records.

The plans and every raw attempt retain their settings. Reproducing a committed experiment requires its recorded sourceRevision; using the final source for an earlier plan changes the experiment. Attempts 1–25 include uncommitted development snapshots identified by source digests, so those historical versions are not advertised as fully reproducible from the final commit.

To reproduce the final suite in a separate folder from web/ (the archived 50 attempts are immutable):

\`\`\`sh
mkdir -p ../docs/webgpu-openfoam-reproduction
cp ../docs/webgpu-openfoam-algorithm/references.json ../docs/webgpu-openfoam-reproduction/references.json
node validation/run-accuracy.mjs --plan ../docs/webgpu-openfoam-algorithm/plan-kernel-check.json --output docs/webgpu-openfoam-reproduction --limit 50 --tolerance 0.05 --validate-only true --revision ${final[0]?.sourceRevision ?? 'f93de24'}
node validation/run-accuracy.mjs --plan ../docs/webgpu-openfoam-algorithm/plan-final.json --output docs/webgpu-openfoam-reproduction --limit 50 --tolerance 0.05 --revision ${final[0]?.sourceRevision ?? 'f93de24'}
\`\`\`

The source tree must include the retained local geometry fixtures referenced by validation/models.json. The source hash, reference hashes, domains and input settings are separate checks. Resuming skips attempted keys, including failures. Hardware WebGPU is required; software adapters are rejected. No experimental numerical option is enabled in the application's production defaults.
`;
writeFileSync(join(evidence,"README.md"),text);
console.log(JSON.stringify({attempts:summary.attempts,completed:summary.completed,failed:summary.failed,targetMet:summary.targetMet,budgetExhausted:summary.budgetExhausted,finalSuiteComplete:summary.finalSuiteComplete,bothCoefficientsBelowTarget:summary.bothCoefficientsBelowTarget}));
