// OpenFOAM case files in the same world frame, units and boundary conventions as the server.
import { writeSTL } from "../geometry/stl";
import { momentOrigin } from "../solver/aero";
import { automaticDomain } from "../solver/grid";
import { vizBoxFor, vizGrid } from "../solver/extract";
import type { Settings, SolverPart, Vec3 } from "../solver/types";
import { isWasmQuality, WASM_PRESETS } from "./wasmPresets";

export type CaseFiles = Record<string, Uint8Array>;
export interface WasmCase {
  files: CaseFiles;
  parts: SolverPart[];
  patches: string[];
  low: Vec3; high: Vec3;
  domain: [number, number, number, number, number, number];
  inlet: Vec3; freestream: number; length: number;
  viz: ReturnType<typeof vizGrid>;
  iterations: number; maxCells: number; h: number; layers: number;
}

const vec = (v: readonly number[]) => `(${v.join(" ")})`;
const header = (object: string, cls = "dictionary") => `FoamFile {version 2.0; format ascii; class ${cls}; object ${object};}\n`;

export function prepareWasmCase(input: SolverPart[], s: Settings): WasmCase {
  const parts = input.filter(p => p.active !== false);
  if (!parts.length) throw new Error("Enable at least one car part.");
  if (parts.length > 64) throw new Error("Browser OpenFOAM supports up to 64 parts. Connect the server for larger models.");
  if (!isWasmQuality(s.quality)) throw new Error("Choose Quick, Fast or Detailed for browser OpenFOAM. Custom meshes require a connected server.");
  if (s.flow_animation) throw new Error("Recording physical-time flow requires the connected OpenFOAM server. Steady airflow views are available in the browser.");
  if (![s.speed_kmh,s.yaw_deg,s.density,s.reference_area].every(Number.isFinite) || s.speed_kmh<=0 || s.density<=0 || s.reference_area<=0 || Math.abs(s.yaw_deg)>=80)
    throw new Error("Check speed, yaw, density and reference area before running OpenFOAM.");
  const preset=WASM_PRESETS[s.quality];
  const low:Vec3=[Infinity,Infinity,Infinity], high:Vec3=[-Infinity,-Infinity,-Infinity];
  let triangles=0;
  for (const p of parts) {
    triangles+=p.positions.length/9;
    if (p.positions.length%9 || !p.positions.length) throw new Error(`${p.name} has no usable triangles.`);
    for (let i=0;i<p.positions.length;i++) {
      const v=p.positions[i];
      if (!Number.isFinite(v)) throw new Error(`${p.name} has non-finite geometry.`);
      low[i%3]=Math.min(low[i%3],v); high[i%3]=Math.max(high[i%3],v);
    }
  }
  if (triangles>1_000_000) throw new Error("Browser meshing supports up to one million triangles. Simplify the exterior or connect the server.");
  const length=high[0]-low[0], h=length/preset.cellsPerLength;
  if (!(length>.01) || low[2]<-1e-4) throw new Error("Check the model scale and road position.");
  const b=s.simulation_box;
  const domain:WasmCase["domain"]=b ? [b.x_min,b.x_max,b.y_min,b.y_max,0,b.z_max] : automaticDomain(low,high);
  if (!domain.every(Number.isFinite) || domain[0]>=low[0] || domain[1]<=high[0] || domain[2]>=low[1] || domain[3]<=high[1] || domain[5]<=high[2])
    throw new Error("The wind tunnel must contain the whole car with space around it.");
  const [x0,x1,y0,y1,,z1]=domain;
  const counts=[Math.ceil((x1-x0)/h),Math.ceil((y1-y0)/h),Math.ceil(z1/h)];
  if (counts.reduce((a,b)=>a*b,1)>preset.maxCells/2) throw new Error("This tunnel exceeds the browser mesh budget. Reduce its size or connect the server.");
  const speed=s.speed_kmh/3.6, inlet:Vec3=[speed,speed*Math.tan(s.yaw_deg*Math.PI/180),0], freestream=Math.hypot(...inlet);
  const k=1.5*(freestream*.01)**2, omega=Math.sqrt(k)/(.09**.25*.07*length);
  const patches=parts.map((_,i)=>`part${i}`), files:CaseFiles={};
  const write=(path:string,body:string,cls="dictionary") => { files[path]=new TextEncoder().encode(header(path.split("/").at(-1)!,cls)+body); };
  const vertices=[[x0,y0,0],[x1,y0,0],[x1,y1,0],[x0,y1,0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  write("system/blockMeshDict",`scale 1; vertices (${vertices.map(vec).join(" ")});
blocks (hex (0 1 2 3 4 5 6 7) ${vec(counts)} simpleGrading (1 1 1)); edges ();
boundary (
inlet {type patch; faces ((0 4 7 3));} outlet {type patch; faces ((1 2 6 5));}
sides {type patch; faces ((0 1 5 4) (3 7 6 2));} top {type symmetryPlane; faces ((4 5 6 7));}
ground {type wall; faces ((0 3 2 1));}); mergePatchPairs ();`);
  const refinements=parts.map((p,i)=>{
    const lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
    p.positions.forEach((v,j)=>{lo[j%3]=Math.min(lo[j%3],v);hi[j%3]=Math.max(hi[j%3],v);});
    const thickness=Math.min(...hi.map((v,j)=>v-lo[j]));
    const level=Math.max(preset.surface,Math.ceil(Math.log2(2*h/Math.max(thickness,1e-6))));
    if (level>7) throw new Error(`${p.name} is too thin for browser meshing. Connect the OpenFOAM server for advanced refinement.`);
    files[`constant/triSurface/${patches[i]}.stl`]=new Uint8Array(writeSTL(p.positions));
    return `${patches[i]} {level (${level} ${level}); patchInfo {type wall;}}`;
  }).join("\n");
  const width=high[1]-low[1], firstLayer=length*.0007;
  write("system/snappyHexMeshDict",`castellatedMesh true; snap true; addLayers ${preset.layers>0};
geometry {
${patches.map(p=>`${p}.stl {type triSurfaceMesh; name ${p};}`).join("\n")}
wake {type searchableBox; min ${vec([low[0]-.3*length,low[1]-.35*width,.001*length])}; max ${vec([high[0]+2*length,high[1]+.35*width,high[2]+.4*length])};}}
castellatedMeshControls {maxLocalCells ${preset.maxCells}; maxGlobalCells ${preset.maxCells}; minRefinementCells 0;
maxLoadUnbalance .1; nCellsBetweenLevels 3; features (); refinementSurfaces {${refinements}}
resolveFeatureAngle 30; refinementRegions {wake {mode inside; levels ((1e15 ${preset.wake}));}}
locationInMesh ${vec([x0+.314*Math.min(h,low[0]-x0),y0+.271*Math.min(h,low[1]-y0),.419*h])}; allowFreeStandingZoneFaces true;}
snapControls {nSmoothPatch 3; tolerance 2; nSolveIter 30; nRelaxIter 5; nFeatureSnapIter 10;
implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false;}
addLayersControls {relativeSizes false; layers {"part.*" {nSurfaceLayers ${preset.layers};}}
expansionRatio 1.25; firstLayerThickness ${firstLayer}; minThickness ${firstLayer*.6}; nGrow 0;
featureAngle 60; slipFeatureAngle 30; nRelaxIter 5; nSmoothSurfaceNormals 3; nSmoothNormals 5; nSmoothThickness 10;
maxFaceThicknessRatio .5; maxThicknessToMedialRatio .3; minMedialAxisAngle 90; nBufferCellsNoExtrude 1; nLayerIter 30; nRelaxedIter 20;}
meshQualityControls {maxNonOrtho 65; maxBoundarySkewness 4; maxInternalSkewness 4; maxConcave 80;
minVol ${1e-13*length**3}; minTetQuality 1e-15; minArea -1; minTwist .02; minDeterminant .001; minFaceWeight .02;
minVolRatio .01; minTriangleTwist -1; nSmoothScale 4; errorReduction .75;}
writeFlags (scalarLevels layerSets layerFields); mergeTolerance 1e-6;`);
  write("system/controlDict",`application browserFoam; startFrom startTime; startTime 0; stopAt endTime; endTime ${preset.iterations}; deltaT 1;
writeControl timeStep; writeInterval ${preset.iterations}; purgeWrite 1; writeFormat binary; writePrecision 12; writeCompression off;
timeFormat general; timePrecision 6; runTimeModifiable false; functions {};`);
  write("system/decomposeParDict","numberOfSubdomains 1; method hierarchical; hierarchicalCoeffs {n (1 1 1); delta .001; order xyz;}");
  write("system/fvSchemes",`ddtSchemes {default steadyState;} gradSchemes {default Gauss linear; grad(U) cellLimited Gauss linear 1;}
divSchemes {default none; div(phi,U) bounded Gauss linearUpwindV grad(U); div(phi,k) bounded Gauss upwind;
div(phi,omega) bounded Gauss upwind; div((nuEff*dev2(T(grad(U))))) Gauss linear;}
laplacianSchemes {default Gauss linear limited 0.5;} interpolationSchemes {default linear;}
snGradSchemes {default limited 0.5;} wallDist {method meshWave;}`);
  write("system/fvSolution",`solvers {p {solver GAMG; tolerance 1e-7; relTol .05; smoother GaussSeidel;}
"(U|k|omega)" {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol .1;}}
SIMPLE {nNonOrthogonalCorrectors 1; consistent yes;}
relaxationFactors {fields {p .3;} equations {U .7; k .7; omega .7;}}`);
  write("constant/transportProperties","transportModel Newtonian; nu [0 2 -1 0 0 0 0] 1.5e-5;");
  write("constant/turbulenceProperties","simulationType RAS; RAS {RASModel kOmegaSST; turbulence on; printCoeffs on;}");
  write("system/meshQualityDict","maxNonOrtho 65; maxBoundarySkewness 4; maxInternalSkewness 4; maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1; minTwist .02; minDeterminant .001; minFaceWeight .02; minVolRatio .01; minTriangleTwist -1;");
  for (const [field,dim,initial] of [["U","0 1 -1 0 0 0 0",vec(inlet)],["p","0 2 -2 0 0 0 0","0"],["k","0 2 -2 0 0 0 0",String(k)],["omega","0 0 -1 0 0 0 0",String(omega)],["nut","0 2 -1 0 0 0 0","0"]]) {
    let boundaries=field==="U" ? `inlet {type fixedValue; value uniform ${initial};} outlet {type inletOutlet; inletValue uniform ${initial}; value uniform ${initial};} sides {type freestream; freestreamValue uniform ${initial};}`
      : field==="p" ? "inlet {type zeroGradient;} outlet {type fixedValue; value uniform 0;} sides {type freestreamPressure; freestreamValue uniform 0;}"
      : field==="nut" ? "inlet {type calculated; value uniform 0;} outlet {type calculated; value uniform 0;} sides {type calculated; value uniform 0;}"
      : `inlet {type fixedValue; value uniform ${initial};} outlet {type inletOutlet; inletValue uniform ${initial}; value uniform ${initial};} sides {type inletOutlet; inletValue uniform ${initial}; value uniform ${initial};}`;
    boundaries+="top {type symmetryPlane;}\n";
    for (let i=-1;i<parts.length;i++) {
      const p=parts[i];
      let condition:string;
      if (field==="U") {
        if (i<0) condition=`type fixedValue; value uniform ${vec([s.moving_ground?speed:0,0,0])};`;
        else if (p.role==="wheel" && s.wheels && p.wheel) condition=`type rotatingWallVelocity; origin ${vec(p.wheel.center)}; axis (0 1 0); omega ${-speed/p.wheel.radius}; value uniform (0 0 0);`;
        else condition="type noSlip;";
      } else if (field==="p") condition="type zeroGradient;";
      else condition=`type ${{k:"kqRWallFunction",omega:"omegaWallFunction",nut:"nutkWallFunction"}[field]}; value uniform ${initial};`;
      boundaries+=`${i<0?"ground":patches[i]} {${condition}}\n`;
    }
    write(`0/${field}`,`dimensions [${dim}]; internalField uniform ${initial}; boundaryField {${boundaries}}`,field==="U"?"volVectorField":"volScalarField");
  }
  const box=vizBoxFor(low,high,domain,length), viz=vizGrid(box.low,box.high,65_000);
  write("system/easycfdDict",`rho ${s.density}; speed ${freestream}; area ${s.reference_area}; origin ${vec(momentOrigin(s.axles))}; patches (${patches.join(" ")});
vizOrigin ${vec(viz.origin)}; vizSpacing ${vec(viz.spacing)}; vizDims ${vec(viz.dims)}; snapshotInterval 60;`);
  return {files,parts,patches,low,high,domain,inlet,freestream,length,viz,iterations:preset.iterations,maxCells:preset.maxCells,h,layers:preset.layers};
}
