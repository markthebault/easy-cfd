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

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  let n = NC();
  if (id >= n) { return; }
  let e = decode(id);
  let idx = i32(id);
  if (!interior(e) || solid(idx)) {
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
  var convK = 0.0; var convW = 0.0;
  var lapK = 0.0; var lapW = 0.0;
  var diffK = 0.0; var diffW = 0.0;
  var gk = vec3<f32>(0.0); var gw = vec3<f32>(0.0);
  let pos = vec3<f32>(cc(0u, e.x), cc(1u, e.y), cc(2u, e.z));
  let uwCell = wallVelocity(partOf(idx), pos);

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
        diffK += alpha * nutF * ar * (kN - k) / d;
        diffW += alpha * nutF * ar * (wN - w) / d;
        gk[a] += 0.5 * f32(sgn) * (kN - k) / d;
        gw[a] += 0.5 * f32(sgn) * (wN - w) / d;
      }
      fv[a] = un;
      faceU[side] = fv;
    }
    grad[a] = (faceU[1] - faceU[0]) / width[a];
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
    let yg = 0.5 * width.z;
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
  let CDkw = 2.0 * ALPHA_W2 * dot(gk, gw) / w;
  let CDp = max(CDkw, 1e-10);
  let sk = sqrt(max(k, 0.0));
  let arg1 = min(min(max(sk / (BETA_STAR * w * y), 500.0 * nu / (y * y * w)), 4.0 * ALPHA_W2 * k / (CDp * y * y)), 10.0);
  let F1 = safeTanh(pow(arg1, 4.0));
  let arg2 = min(max(2.0 * sk / (BETA_STAR * w * y), 500.0 * nu / (y * y * w)), 100.0);
  let F2 = safeTanh(arg2 * arg2);
  let alphaK = F1 * ALPHA_K1 + (1.0 - F1) * ALPHA_K2;
  let alphaW = F1 * ALPHA_W1 + (1.0 - F1) * ALPHA_W2;
  let gamma = F1 * GAMMA1 + (1.0 - F1) * GAMMA2;
  let beta = F1 * BETA1 + (1.0 - F1) * BETA2;
  let sS = sqrt(S2);

  var G = nutOld * S2;
  var wNew: f32;
  if (wallY < 1e29 && P.opts.x == 0u) {
    // omegaWallFunction (binomial blending) with log-law production; k transported (kqRWallFunction).
    let nuw = nuWall(k, wallY);
    G = nuw * (wallDU / wallY) * CMU25 * sk / (KAPPA * wallY);
    let wVis = 6.0 * nu / (BETA1 * wallY * wallY);
    let wLog = sk / (CMU25 * KAPPA * wallY);
    wNew = sqrt(wVis * wVis + wLog * wLog);
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
    let GbyNu = min(S2, (C1 / A1) * BETA_STAR * w * max(A1 * w, B1 * F2 * sS));
    let cd = (1.0 - F1) * CDkw;
    let src = w + dt * ((nu * lapW + alphaW * diffW - convW) / vol + srcScale * (gamma * GbyNu + max(cd, 0.0)));
    wNew = src / (1.0 + dt * srcScale * (beta * w + max(-cd, 0.0) / w));
  }
  let Pk = min(G, C1 * BETA_STAR * k * w);
  let kNew = (k + dt * ((nu * lapK + alphaK * diffK - convK) / vol + srcScale * Pk)) / (1.0 + dt * srcScale * BETA_STAR * wNew);
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

// Ghost values for k, omega, nut. Inlet (and inflow side): fixed free-stream turbulence;
// elsewhere zero gradient (outlet inletOutlet, symmetry top, kqR/omega wall functions at the road
// are handled in the cell update).
export const bcTurbWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> turb: array<f32>;
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
    put(i, 0, k, i, 1, k, P.modes.x == 1u);
    put(i, ny + 1, k, i, ny, k, P.modes.x == 2u);
  } else {
    if (id >= NX() * NY()) { return; }
    let i = id % NX(); let j = id / NX();
    put(i, j, 0, i, j, 1, false);
    put(i, j, nz + 1, i, j, nz, false);
  }
}
`;
