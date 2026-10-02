import { common, WG } from "./common";
import { THETA_EFF } from "../setup";

// k-omega SST (Menter 2003) with OpenFOAM's kOmegaSST coefficients and wall treatment:
// kqRWallFunction (zero gradient), omegaWallFunction (binomial blending of viscous and log
// values, production from the log law), nutkWallFunction for wall shear.
export const turbulenceWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read> turb: array<f32>;        // k | omega | nut | wall distance (static)
@group(0) @binding(6) var<storage, read_write> turbOut: array<f32>;
@group(0) @binding(7) var<storage, read> state: array<f32>;
@group(0) @binding(8) var<storage, read> aper: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> wall: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> transportMatrix: array<vec4<f32>>;
override IMPLICIT: bool = false;
const TRANSPORT_RELAX: f32 = 0.7;

const THETA_EFF: f32 = ${THETA_EFF};

const ALPHA_K1: f32 = 0.85;
const ALPHA_K2: f32 = 1.0;
const ALPHA_W1: f32 = 0.5;
const ALPHA_W2: f32 = 0.856;
const GAMMA1: f32 = 0.5555556;
const GAMMA2: f32 = 0.44;
const BETA1: f32 = 0.075;
const BETA2: f32 = 0.0828;
const BETA_STAR: f32 = 0.09;
const A1: f32 = 0.31;
const B1: f32 = 1.0;
const C1: f32 = 10.0;

// tanh overflows to NaN for large arguments on some backends (e^2x / e^2x).
fn safeTanh(x: f32) -> f32 { return tanh(min(x, 15.0)); }

fn Uf(a: u32, idx: i32) -> f32 { return vel[a * NC() + u32(idx)]; }

// Cell-centre velocity (mean of the two faces along each axis).
fn Uc(idx: i32) -> vec3<f32> {
  return vec3<f32>(
    0.5 * (Uf(0u, idx) + Uf(0u, idx - 1)),
    0.5 * (Uf(1u, idx) + Uf(1u, idx - NX())),
    0.5 * (Uf(2u, idx) + Uf(2u, idx - NX() * NY())));
}

fn scalarGradient(q: i32, plane: u32) -> vec3<f32> {
  let e = decode(u32(q)); let value = turb[plane*NC()+u32(q)];
  var gradient = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    let s = strideOf(a); let width = cw(a,e[a]);
    for (var side = 0; side < 2; side++) {
      let sign = select(-1,1,side == 1); let nb = q+sign*s;
      let face = select(q-s,q,side == 1);
      if (aper[u32(face)][a] <= 0.0 || solid(nb)) { continue; }
      let distance = abs(cc(a,e[a]+sign)-cc(a,e[a]));
      gradient[a] += f32(sign)*aper[u32(face)][a]*(turb[plane*NC()+u32(nb)]-value)*0.5/distance;
    }
    gradient[a] /= max(aper[u32(q)].w,0.05);
  }
  return gradient;
}

fn blendF1(q: i32) -> f32 {
  if (!interior(decode(u32(q))) || solid(q)) { return 0.0; }
  let k = max(turb[u32(q)],1e-10); let w = max(turb[NC()+u32(q)],1e-6);
  let y = max(turb[3u*NC()+u32(q)],1e-6);
  let CD = max(2.0*ALPHA_W2*dot(scalarGradient(q,0u),scalarGradient(q,1u))/w,1e-10);
  let argument = min(min(max(sqrt(k)/(BETA_STAR*w*y),500.0*P.turb.z/(y*y*w)),4.0*ALPHA_W2*k/(CD*y*y)),10.0);
  return safeTanh(pow(argument,4.0));
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  let n = NC();
  if (id >= n) { return; }
  let e = decode(id);
  let idx = i32(id);
  if (!interior(e) || solid(idx)) {
    if (IMPLICIT) {
      transportMatrix[2u*id] = vec4<f32>(0.0); transportMatrix[2u*id+1u] = vec4<f32>(0.0);
      transportMatrix[2u*(n+id)] = vec4<f32>(0.0); transportMatrix[2u*(n+id)+1u] = vec4<f32>(0.0);
      transportMatrix[4u*n+id] = vec4<f32>(0.0);
    }
    turbOut[3u * n + id] = turb[3u * n + id];
    turbOut[id] = turb[id];
    turbOut[n + id] = turb[n + id];
    turbOut[2u * n + id] = select(turb[2u * n + id], 0.0, interior(e));
    return;
  }
  let nu = P.turb.z;
  let dt = state[0] * turb[4u * n + id];   // local time-step factor
  let k = turb[id];
  let w = turb[n + id];
  let nutOld = turb[2u * n + id];
  let wd = turb[3u * n + id];
  let uP = Uc(idx);
  let width = vec3<f32>(cw(0u, e.x), cw(1u, e.y), cw(2u, e.z));
  let apC = aper[id];
  let theta = apC.w;
  let thetaE = max(theta, THETA_EFF);
  let vol = width.x * width.y * width.z * thetaE;
  let srcScale = theta / thetaE;

  var grad: mat3x3<f32>;             // grad[a] = d(U)/dx_a
  var fluxDivergence = 0.0;
  var linksK: array<f32,6>; var linksW: array<f32,6>;
  var diagonalK = 0.0; var diagonalW = 0.0;
  var boundaryK = 0.0; var boundaryW = 0.0;
  var convK = 0.0; var convW = 0.0;
  var lapK = 0.0; var lapW = 0.0;
  var diffK = 0.0; var diffW = 0.0;
  var gk = vec3<f32>(0.0); var gw = vec3<f32>(0.0);
  let pos = vec3<f32>(cc(0u, e.x), cc(1u, e.y), cc(2u, e.z));
  var uwCell = wallVelocity(partOf(idx), pos);
  if ((P.opts.w & 4096u) != 0u) {
    let area = length(wall[id].xyz);
    if (area > 0.0) { let normal = wall[id].xyz/area; uwCell -= dot(uwCell,normal)*normal; }
  }
  let sourceAligned = (P.opts.w & 32u) != 0u;
  var blendHere = 0.0;
  if (sourceAligned) { blendHere = blendF1(idx); }

  for (var a = 0u; a < 3u; a++) {
    let s = strideOf(a);
    let ea = e[a];
    let na = dimOf(a) - 2;
    let ar = width.x * width.y * width.z / width[a];
    var faceU: array<vec3<f32>, 2>;
    for (var side = 0; side < 2; side++) {
      let sgn = select(-1, 1, side == 1);
      let nIdx = idx + sgn * s;
      let fIdx = select(idx - s, idx, side == 1);
      let alpha = aper[fIdx][a];
      let un = Uf(a, fIdx);              // face-normal velocity
      let F = f32(sgn) * un * ar * alpha; // outward volumetric flux through the open part
      let ground = (a == 2u && side == 0 && ea == 1);
      let inside = (ea + sgn >= 1) && (ea + sgn <= na);
      var fv: vec3<f32>;
      if (ground) {
        fv = vec3<f32>(P.inlet.w, 0.0, 0.0);
      } else if (alpha <= 0.0) {
        fv = uwCell;
      } else {
        let kN = turb[u32(nIdx)];
        let wN = turb[n + u32(nIdx)];
        let nutN = turb[2u * n + u32(nIdx)];
        let d = abs(cc(a, ea + sgn) - cc(a, ea));
        var uN = Uc(nIdx);
        if (!inside) {
          // boundary ghost: inlet fixed value, otherwise zero gradient
          uN = select(uP, P.inlet.xyz, a == 0u && side == 0);
          if (a == 1u && ((side == 0 && P.modes.x == 1u) || (side == 1 && P.modes.x == 2u))) { uN = P.inlet.xyz; }
          if (a == 1u && (P.opts.w & 256u) != 0u) { uN = select(uP,P.inlet.xyz,F < 0.0); }
        }
        let wP = 0.5 * width[a];
        let wN2 = 0.5 * cw(a, ea + sgn);
        fv = (uP * wN2 + uN * wP) / (wP + wN2);
        let upK = select(k, kN, F < 0.0);
        let upW = select(w, wN, F < 0.0);
        convK += F * (upK - k);
        convW += F * (upW - w);
        let nutF = 0.5 * (nutOld + nutN);
        lapK += alpha * ar * (kN - k) / d;
        lapW += alpha * ar * (wN - w) / d;
        if (sourceAligned) {
          let blendNeighbour = blendF1(nIdx);
          let akP = mix(ALPHA_K2,ALPHA_K1,blendHere); let akN = mix(ALPHA_K2,ALPHA_K1,blendNeighbour);
          let awP = mix(ALPHA_W2,ALPHA_W1,blendHere); let awN = mix(ALPHA_W2,ALPHA_W1,blendNeighbour);
          let effectiveK = nu+(wN2*akP*nutOld+wP*akN*nutN)/(wP+wN2);
          let effectiveW = nu+(wN2*awP*nutOld+wP*awN*nutN)/(wP+wN2);
          diffK += alpha*effectiveK*ar*(kN-k)/d;
          diffW += alpha*effectiveW*ar*(wN-w)/d;
        } else {
          diffK += alpha * nutF * ar * (kN - k) / d;
          diffW += alpha * nutF * ar * (wN - w) / d;
        }
        if (IMPLICIT) {
          let akP = mix(ALPHA_K2,ALPHA_K1,blendHere); let awP = mix(ALPHA_W2,ALPHA_W1,blendHere);
          let blendNeighbour = blendF1(nIdx);
          let akN = mix(ALPHA_K2,ALPHA_K1,blendNeighbour); let awN = mix(ALPHA_W2,ALPHA_W1,blendNeighbour);
          var effectiveK = nu+(wN2*akP*nutOld+wP*akN*nutN)/(wP+wN2);
          var effectiveW = nu+(wN2*awP*nutOld+wP*awN*nutN)/(wP+wN2);
          var distance = d;
          var fixed = false;
          if (!inside) {
            fixed = (a == 0u && side == 0) || F < 0.0;
            effectiveK = nu+akP*nutOld; effectiveW = nu+awP*nutOld;
            distance = 0.5*width[a];
          }
          let coefficientK = max(-F,0.0)+alpha*effectiveK*ar/distance;
          let coefficientW = max(-F,0.0)+alpha*effectiveW*ar/distance;
          if (inside) {
            linksK[2u*a+u32(side)] = coefficientK; linksW[2u*a+u32(side)] = coefficientW;
            diagonalK += coefficientK; diagonalW += coefficientW;
          } else if (fixed) {
            diagonalK += coefficientK; diagonalW += coefficientW;
            boundaryK += coefficientK*P.turb.x; boundaryW += coefficientW*P.turb.y;
          }
        }
        gk[a] += 0.5 * f32(sgn) * (kN - k) / d;
        gw[a] += 0.5 * f32(sgn) * (wN - w) / d;
      }
      fv[a] = un;
      faceU[side] = fv;
    }
    grad[a] = (faceU[1] - faceU[0]) / width[a];
    fluxDivergence += (apC[a]*faceU[1][a]-aper[idx-s][a]*faceU[0][a])/(width[a]*max(theta,0.05));
    if ((P.opts.w & 4u) != 0u) {
      let lowOpen = aper[idx - s][a];
      grad[a] = (apC[a] * faceU[1] - lowOpen * faceU[0] + (lowOpen - apC[a]) * uwCell) / (width[a] * max(theta, 0.05));
    }
  }

  if ((P.opts.w & 1024u) != 0u) {
    var lower = uP; var upper = uP;
    for (var a = 0u; a < 3u; a++) {
      let s = strideOf(a);
      for (var side = 0; side < 2; side++) {
        let sign = select(-1,1,side == 1); let nb = idx+sign*s;
        var neighbour = Uc(nb);
        if (solid(nb)) { neighbour = uwCell; }
        if (a == 2u && e.z == 1 && side == 0) { neighbour = vec3<f32>(P.inlet.w,0.0,0.0); }
        lower = min(lower,neighbour); upper = max(upper,neighbour);
      }
    }
    let areaVector = wall[id].xyz; let wallArea = length(areaVector);
    if (wallArea > 0.0) { lower = min(lower,uwCell); upper = max(upper,uwCell); }
    for (var b = 0u; b < 3u; b++) {
      var limiter = 1.0;
      for (var a = 0u; a < 3u; a++) {
        let extrapolation = 0.5*width[a]*grad[a][b];
        if (extrapolation > 1e-12) { limiter = min(limiter,min(upper[b]-uP[b],uP[b]-lower[b])/extrapolation); }
        if (extrapolation < -1e-12) { limiter = min(limiter,min(upper[b]-uP[b],uP[b]-lower[b])/(-extrapolation)); }
      }
      if (wallArea > 0.0) {
        let offset = areaVector/wallArea*wall[id].w;
        let extrapolation = grad[0][b]*offset.x+grad[1][b]*offset.y+grad[2][b]*offset.z;
        if (extrapolation > 1e-12) { limiter = min(limiter,(upper[b]-uP[b])/extrapolation); }
        if (extrapolation < -1e-12) { limiter = min(limiter,(lower[b]-uP[b])/extrapolation); }
      }
      limiter = clamp(limiter,0.0,1.0);
      for (var a = 0u; a < 3u; a++) { grad[a][b] *= limiter; }
    }
  }

  // Wall contact: cut or stepped car surface, and the road. wallDU is the tangential slip speed.
  var wallY = 1e30;
  var wallDU = 0.0;
  let wv = wall[id];
  let wa = length(wv.xyz);
  if (wa > 0.0) {
    let nrm = wv.xyz / wa;
    var slip = uP - uwCell;
    slip = slip - dot(slip, nrm) * nrm;
    wallY = wv.w;
    wallDU = length(slip);
  }
  if (e.z == 1) {
    let yg = roadDistance(idx);
    if (yg < wallY) {
      wallY = yg;
      wallDU = length(vec2<f32>(uP.x - P.inlet.w, uP.y));
    }
  }

  // Strain rate magnitude S2 = 2 S:S.
  var S2 = 0.0;
  for (var a = 0u; a < 3u; a++) {
    for (var b = 0u; b < 3u; b++) {
      let sab = 0.5 * (grad[a][b] + grad[b][a]);
      S2 += 2.0 * sab * sab;
    }
  }

  let y = max(wd, 1e-6);
  if (sourceAligned) { gk = scalarGradient(idx,0u); gw = scalarGradient(idx,1u); }
  let CDkw = 2.0 * ALPHA_W2 * dot(gk, gw) / w;
  let CDp = max(CDkw, 1e-10);
  let sk = sqrt(max(k, 0.0));
  let arg1 = min(min(max(sk / (BETA_STAR * w * y), 500.0 * nu / (y * y * w)), 4.0 * ALPHA_W2 * k / (CDp * y * y)), 10.0);
  let F1 = select(safeTanh(pow(arg1, 4.0)),blendHere,sourceAligned);
  let arg2 = min(max(2.0 * sk / (BETA_STAR * w * y), 500.0 * nu / (y * y * w)), 100.0);
  let F2 = safeTanh(arg2 * arg2);
  let alphaK = F1 * ALPHA_K1 + (1.0 - F1) * ALPHA_K2;
  let alphaW = F1 * ALPHA_W1 + (1.0 - F1) * ALPHA_W2;
  let gamma = F1 * GAMMA1 + (1.0 - F1) * GAMMA2;
  let beta = F1 * BETA1 + (1.0 - F1) * BETA2;
  let sS = sqrt(S2);

  let trace = grad[0][0]+grad[1][1]+grad[2][2];
  let divergence = select(trace,fluxDivergence,sourceAligned);
  let production = select(S2,max(S2-(2.0/3.0)*trace*trace,0.0),sourceAligned);
  let laminarPart = select(nu,0.0,sourceAligned);
  let kDiffScale = select(alphaK,1.0,sourceAligned);
  let wDiffScale = select(alphaW,1.0,sourceAligned);
  var G = nutOld * production;
  var wNew: f32;
  if (wallY < 1e29 && P.opts.x == 0u) {
    // omegaWallFunction (binomial blending) with log-law production; k transported (kqRWallFunction).
    let nuw = nuWall(k, wallY);
    G = nuw * (wallDU / wallY) * CMU25 * sk / (KAPPA * wallY);
    let wVis = 6.0 * nu / (BETA1 * wallY * wallY);
    let wLog = sk / (CMU25 * KAPPA * wallY);
    wNew = sqrt(wVis * wVis + wLog * wLog);
    if ((P.opts.w & 8u) != 0u) {
      let yp = CMU25 * sk * wallY / nu;
      wNew = select(wVis, wLog, yp > YPLUS_LAM);
      if (yp <= YPLUS_LAM) { G = 0.0; }
    }
  } else if (wallY < 1e29) {
    // Equilibrium wall model: k, omega and nut take their log-layer values for the friction
    // velocity implied by the local slip (νt = κ uτ y), with the viscous omega blended in.
    let ut = uTau(wallDU, wallY);
    let kw = max(ut * ut / 0.3, 1e-10);
    let wVis = 6.0 * nu / (BETA1 * wallY * wallY);
    let wLog = ut / (0.3 * KAPPA * wallY);
    let ww = sqrt(wVis * wVis + wLog * wLog);
    turbOut[id] = kw;
    turbOut[n + id] = ww;
    turbOut[2u * n + id] = kw / ww;
    return;
  } else {
    let GbyNu = min(production, (C1 / A1) * BETA_STAR * w * max(A1 * w, B1 * F2 * sS));
    let cd = (1.0 - F1) * CDkw;
    let expansion = select(0.0,(2.0/3.0)*gamma*divergence,sourceAligned);
    let src = w + dt * ((laminarPart * lapW + wDiffScale * diffW - convW) / vol + srcScale * (gamma * GbyNu + max(cd, 0.0) + max(-expansion,0.0)*w));
    wNew = src / (1.0 + dt * srcScale * (beta * w + max(-cd, 0.0) / w + max(expansion,0.0)));
  }
  let Pk = min(G, C1 * BETA_STAR * k * w);
  let expansionK = select(0.0,(2.0/3.0)*divergence,sourceAligned);
  if (IMPLICIT) {
    let volume = width.x*width.y*width.z*theta;
    let damping = vol/dt;
    let omegaUsed = select(w,wNew,wallY < 1e29);
    let productionK = min(G,C1*BETA_STAR*k*omegaUsed);
    let dk = diagonalK+damping+volume*(BETA_STAR*omegaUsed+max(expansionK,0.0));
    let sk = boundaryK+damping*k+volume*(productionK+max(-expansionK,0.0)*k)+(1.0/TRANSPORT_RELAX-1.0)*dk*k;
    transportMatrix[2u*id] = vec4<f32>(linksK[0],linksK[1],linksK[2],linksK[3]);
    transportMatrix[2u*id+1u] = vec4<f32>(linksK[4],linksK[5],dk/TRANSPORT_RELAX,sk);
    if (wallY < 1e29) {
      transportMatrix[2u*(n+id)] = vec4<f32>(0.0);
      transportMatrix[2u*(n+id)+1u] = vec4<f32>(0.0,0.0,1.0,wNew);
    } else {
      let cross = (1.0-F1)*CDkw;
      let expansionW = (2.0/3.0)*gamma*divergence;
      let byNu = min(production,(C1/A1)*BETA_STAR*w*max(A1*w,B1*F2*sS));
      let dw = diagonalW+damping+volume*(beta*w+max(-cross,0.0)/w+max(expansionW,0.0));
      let sw = boundaryW+damping*w+volume*(gamma*byNu+max(cross,0.0)+max(-expansionW,0.0)*w)+(1.0/TRANSPORT_RELAX-1.0)*dw*w;
      transportMatrix[2u*(n+id)] = vec4<f32>(linksW[0],linksW[1],linksW[2],linksW[3]);
      transportMatrix[2u*(n+id)+1u] = vec4<f32>(linksW[4],linksW[5],dw/TRANSPORT_RELAX,sw);
    }
    transportMatrix[4u*n+id] = vec4<f32>(omegaUsed,volume*BETA_STAR/TRANSPORT_RELAX,S2,k);
    turbOut[id] = k; turbOut[n+id] = omegaUsed; turbOut[2u*n+id] = nutOld;
    return;
  }
  let kNew = (k + dt * ((laminarPart * lapK + kDiffScale * diffK - convK) / vol + srcScale * (Pk+max(-expansionK,0.0)*k))) / (1.0 + dt * srcScale * (BETA_STAR * wNew+max(expansionK,0.0)));
  let kB = max(kNew, 1e-10);
  let wB = max(wNew, 1e-6);
  let sk2 = sqrt(kB);
  let arg2n = min(max(2.0 * sk2 / (BETA_STAR * wB * y), 500.0 * nu / (y * y * wB)), 100.0);
  let F2n = safeTanh(arg2n * arg2n);
  turbOut[id] = kB;
  turbOut[n + id] = wB;
  turbOut[2u * n + id] = A1 * kB / max(A1 * wB, B1 * F2n * sS);
}
`;

// omega is solved first. The k diagonal/source are updated with the newly solved omega before
// the k sweeps, reproducing the destruction term's ordering in kOmegaSSTBase::correct().
export const solveSstWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> input: array<f32>;
@group(0) @binding(5) var<storage, read_write> output: array<f32>;
@group(0) @binding(6) var<storage, read> coefficients: array<vec4<f32>>;
override COMPONENT: u32 = 1u;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid,nwg); let n = NC(); if (id >= n) { return; }
  for (var plane = 0u; plane < 5u; plane++) { output[plane*n+id] = input[plane*n+id]; }
  let m = 2u*(COMPONENT*n+id); let c0 = coefficients[m]; let c1 = coefficients[m+1u];
  if (c1.z <= 0.0) { return; }
  let q = i32(id); let offset = COMPONENT*n;
  let sum = c0.x*input[offset+u32(q-1)]+c0.y*input[offset+u32(q+1)]
    +c0.z*input[offset+u32(q-NX())]+c0.w*input[offset+u32(q+NX())]
    +c1.x*input[offset+u32(q-NX()*NY())]+c1.y*input[offset+u32(q+NX()*NY())];
  var diagonal = c1.z; var rhs = c1.w;
  if (COMPONENT == 0u) {
    let aux = coefficients[4u*n+id];
    let change = aux.y*(input[n+id]-aux.x);
    diagonal += change; rhs += 0.3*change*aux.w;
  }
  output[offset+id] = max((sum+rhs)/max(diagonal,1e-20),select(1e-10,1e-6,COMPONENT == 1u));
}
`;

export const finishSstWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> fields: array<f32>;
@group(0) @binding(5) var<storage, read> aux: array<vec4<f32>>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid,nwg); let n = NC(); if (id >= n || !interior(decode(id)) || solid(i32(id))) { return; }
  let k = max(fields[id],1e-10); let w = max(fields[n+id],1e-6); let y = max(fields[3u*n+id],1e-6);
  let argument = min(max(2.0*sqrt(k)/(0.09*w*y),500.0*P.turb.z/(y*y*w)),100.0);
  let f2 = tanh(min(argument*argument,15.0));
  fields[2u*n+id] = 0.31*k/max(0.31*w,f2*sqrt(max(aux[4u*n+id].z,0.0)));
}
`;

// Ghost values for k, omega, nut. Inlet (and inflow side): fixed free-stream turbulence;
// elsewhere zero gradient (outlet inletOutlet, symmetry top, kqR/omega wall functions at the road
// are handled in the cell update).
export const bcTurbWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> turb: array<f32>;
@group(0) @binding(5) var<storage, read> vel: array<f32>;
override PHASE: u32;

fn put(i: i32, j: i32, k: i32, si: i32, sj: i32, sk: i32, fixed: bool) {
  let n = NC();
  let dst = u32(i + NX() * (j + NY() * k));
  let src = u32(si + NX() * (sj + NY() * sk));
  if (fixed) {
    turb[dst] = P.turb.x;
    turb[n + dst] = P.turb.y;
    turb[2u * n + dst] = P.turb.x / P.turb.y;
  } else {
    turb[dst] = turb[src];
    turb[n + dst] = turb[n + src];
    turb[2u * n + dst] = turb[2u * n + src];
  }
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = i32(gidx(gid, nwg));
  let nx = NX() - 2; let ny = NY() - 2; let nz = NZ() - 2;
  if (PHASE == 0u) {
    if (id >= NY() * NZ()) { return; }
    let j = id % NY(); let k = id / NY();
    put(0, j, k, 1, j, k, true);
    put(nx + 1, j, k, nx, j, k, false);
  } else if (PHASE == 1u) {
    if (id >= NX() * NZ()) { return; }
    let i = id % NX(); let k = id / NX();
    var lowIn = P.modes.x == 1u; var highIn = P.modes.x == 2u;
    if ((P.opts.w & 256u) != 0u) {
      lowIn = vel[NC()+u32(i+NX()*NY()*k)] > 0.0;
      highIn = vel[NC()+u32(i+NX()*(ny+NY()*k))] < 0.0;
    }
    put(i, 0, k, i, 1, k, lowIn);
    put(i, ny + 1, k, i, ny, k, highIn);
  } else {
    if (id >= NX() * NY()) { return; }
    let i = id % NX(); let j = id / NX();
    put(i, j, 0, i, j, 1, false);
    put(i, j, nz + 1, i, j, nz, false);
  }
}
`;
