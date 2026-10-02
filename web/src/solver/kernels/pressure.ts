import { common, WG } from "./common";

// Geometric multigrid for Σ g_f (φ_N − φ_P) − g_D φ_P = b. Each level stores per cell the
// conductances of its +x, +y, +z faces and the fixed-pressure boundary term (vec4). Solid faces
// have zero conductance. Red-black Gauss-Seidel smoothing, summed-residual restriction,
// piecewise-constant prolongation.

const levelHeader = /* wgsl */ `
struct Level { dims: vec4<u32>, cdims: vec4<u32>, opts: vec4<f32> };  // opts.x: coarse correction factor
@group(0) @binding(0) var<uniform> L: Level;
@group(0) @binding(1) var<storage, read> coef: array<vec4<f32>>;

fn lx() -> i32 { return i32(L.dims.x); }
fn lxy() -> i32 { return i32(L.dims.x * L.dims.y); }
fn ldecode(idx: u32) -> vec3<i32> {
  return vec3<i32>(i32(idx % L.dims.x), i32((idx / L.dims.x) % L.dims.y), i32(idx / (L.dims.x * L.dims.y)));
}
fn linterior(e: vec3<i32>) -> bool {
  return e.x >= 1 && e.y >= 1 && e.z >= 1 && e.x <= i32(L.dims.x) - 2 && e.y <= i32(L.dims.y) - 2 && e.z <= i32(L.dims.z) - 2;
}
fn gidx(gid: vec3<u32>, n: vec3<u32>) -> u32 { return gid.x + gid.y * n.x * ${WG}u; }
fn diagAt(idx: i32) -> f32 {
  let c = coef[idx];
  return c.x + c.y + c.z + c.w + coef[idx - 1].x + coef[idx - lx()].y + coef[idx - lxy()].z;
}
`;

export const smoothWGSL = levelHeader + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> phi: array<f32>;
@group(0) @binding(3) var<storage, read> rhs: array<f32>;
override COLOR: u32;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= L.dims.w) { return; }
  let e = ldecode(id);
  if (!linterior(e)) { return; }
  if ((u32(e.x + e.y + e.z) & 1u) != COLOR) { return; }
  let idx = i32(id);
  let c = coef[idx];
  let gW = coef[idx - 1].x;
  let gS = coef[idx - lx()].y;
  let gB = coef[idx - lxy()].z;
  let diag = c.x + c.y + c.z + c.w + gW + gS + gB;
  if (diag <= 0.0) { return; }
  let s = c.x * phi[idx + 1] + gW * phi[idx - 1] + c.y * phi[idx + lx()] + gS * phi[idx - lx()]
        + c.z * phi[idx + lxy()] + gB * phi[idx - lxy()];
  phi[idx] = (s - rhs[idx]) / diag;
}
`;

export const restrictWGSL = levelHeader + /* wgsl */ `
@group(0) @binding(2) var<storage, read> phi: array<f32>;
@group(0) @binding(3) var<storage, read> rhs: array<f32>;
@group(0) @binding(4) var<storage, read_write> coarseRhs: array<f32>;
@group(0) @binding(5) var<storage, read_write> coarsePhi: array<f32>;

fn residual(idx: i32) -> f32 {
  let c = coef[idx];
  let gW = coef[idx - 1].x;
  let gS = coef[idx - lx()].y;
  let gB = coef[idx - lxy()].z;
  let diag = c.x + c.y + c.z + c.w + gW + gS + gB;
  if (diag <= 0.0) { return 0.0; }
  let s = c.x * phi[idx + 1] + gW * phi[idx - 1] + c.y * phi[idx + lx()] + gS * phi[idx - lx()]
        + c.z * phi[idx + lxy()] + gB * phi[idx - lxy()];
  return rhs[idx] - (s - diag * phi[idx]);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= L.cdims.w) { return; }
  coarsePhi[id] = 0.0;
  let cx = L.cdims.x; let cy = L.cdims.y;
  let E = vec3<i32>(i32(id % cx), i32((id / cx) % cy), i32(id / (cx * cy)));
  if (E.x < 1 || E.y < 1 || E.z < 1 || E.x > i32(cx) - 2 || E.y > i32(cy) - 2 || E.z > i32(L.cdims.z) - 2) {
    coarseRhs[id] = 0.0;
    return;
  }
  let f0 = vec3<i32>(2 * E.x - 1, 2 * E.y - 1, 2 * E.z - 1);
  var sum = 0.0;
  for (var dz = 0; dz < 2; dz++) {
    for (var dy = 0; dy < 2; dy++) {
      for (var dx = 0; dx < 2; dx++) {
        let child = f0 + vec3<i32>(dx, dy, dz);
        if (linterior(child)) { sum += residual(child.x + lx() * child.y + lxy() * child.z); }
      }
    }
  }
  coarseRhs[id] = sum;
}
`;

export const prolongWGSL = levelHeader + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> phi: array<f32>;
@group(0) @binding(3) var<storage, read> coarsePhi: array<f32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= L.dims.w) { return; }
  let e = ldecode(id);
  if (!linterior(e)) { return; }
  let idx = i32(id);
  if (diagAt(idx) <= 0.0) { return; }
  let E = vec3<i32>((e.x + 1) / 2, (e.y + 1) / 2, (e.z + 1) / 2);
  let cidx = E.x + i32(L.cdims.x) * (E.y + i32(L.cdims.y) * E.z);
  phi[idx] += L.opts.x * coarsePhi[cidx];
}
`;

// ---------------------------------------------------------------------------------------------
// Forces on the car: pressure and wall-function shear on every fluid/solid face, reduced per
// workgroup, then summed into a history slot together with the simulated time.
// ---------------------------------------------------------------------------------------------
export const forcesWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read> turb: array<f32>;
@group(0) @binding(6) var<storage, read> pres: array<f32>;   // level-0 φ: full kinematic pressure
@group(0) @binding(7) var<storage, read> cellsList: array<vec2<u32>>;
@group(0) @binding(8) var<storage, read_write> partials: array<f32>;
@group(0) @binding(9) var<storage, read> wall: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> faceForce: array<f32>; // per wall cell: pressure (3), shear (3)

var<workgroup> acc: array<f32, ${WG * 24}>;

// Force on the car from one wall cell: pressure on the wall area vector plus wall-function shear.
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
        @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3<u32>) {
  let fid = gidx(gid, nwg);
  for (var m = 0u; m < 24u; m++) { acc[li * 24u + m] = 0.0; }
  if (fid < u32(P.misc.w)) {
    let f = cellsList[fid];
    let idx = i32(f.x);
    let part = f.y & 255u;
    let wheel = (f.y >> 16u) & 1u;
    let e = decode(f.x);
    let wv = wall[f.x];
    let o = li * 24u + wheel * 6u;
    if (((f.y >> 17u) & 1u) == 1u) {
      // road contact under a solid cell: pressure of the fluid neighbours at road level, upward
      var ps = 0.0;
      var cnt = 0.0;
      for (var q = 0; q < 4; q++) {
        let nb = idx + select(select(-NX(), NX(), q == 3), select(-1, 1, q == 1), q < 2);
        if (!solid(nb)) { ps += pres[u32(nb)]; cnt += 1.0; }
      }
      acc[o + 2u] = P.turb.w * select(0.0, ps / cnt, cnt > 0.0) * wv.z;
      let fp = vec3<f32>(0.0, 0.0, acc[o + 2u]);
      let mp = cross(vec3<f32>(cc(0u,e.x), cc(1u,e.y), 0.0) - P.origin.xyz, fp);
      let mo = li * 24u + 12u + wheel * 6u;
      acc[mo] = mp.x; acc[mo+1u] = mp.y; acc[mo+2u] = mp.z;
      for (var m = 0u; m < 6u; m++) {
        faceForce[fid * 12u + m] = select(0.0, acc[o + 2u], m == 2u);
        faceForce[fid * 12u + 6u + m] = acc[mo + m];
      }
    }
  }
  if (fid < u32(P.misc.w) && ((cellsList[fid].y >> 17u) & 1u) == 0u) {
    let f = cellsList[fid];
    let idx = i32(f.x);
    let part = f.y & 255u;
    let wheel = (f.y >> 16u) & 1u;
    let e = decode(f.x);
    let wv = wall[f.x];
    let area = length(wv.xyz);
    let nrm = wv.xyz / max(area, 1e-30);
    let rho = P.turb.w;
    let n = NC();
    // Sliver cells report the pressure of the cell they are merged with (up to two links).
    var pc = idx;
    for (var hop = 0; hop < 2; hop++) {
      if (bitcast<f32>(P.opts.y) <= 1.0) { break; }
      let l = (flags[u32(pc)] >> 16u) & 7u;
      if (l == 0u) { break; }
      let ax = (l - 1u) / 2u;
      pc = pc + select(-1, 1, (l & 1u) == 0u) * strideOf(ax);
    }
    let fp = rho * pres[u32(pc)] * wv.xyz;
    let uc = vec3<f32>(
      0.5 * (vel[f.x] + vel[u32(idx - 1)]),
      0.5 * (vel[n + f.x] + vel[n + u32(idx - NX())]),
      0.5 * (vel[2u * n + f.x] + vel[2u * n + u32(idx - NX() * NY())]));
    let pos = vec3<f32>(cc(0u, e.x), cc(1u, e.y), cc(2u, e.z));
    var slip = uc - wallVelocity(part, pos);
    slip = slip - dot(slip, nrm) * nrm;
    let fv = rho * wallShear(slip, wv.w, turb[f.x]) * area;
    let o = li * 24u + wheel * 6u;
    acc[o] = fp.x; acc[o + 1u] = fp.y; acc[o + 2u] = fp.z;
    acc[o + 3u] = fv.x; acc[o + 4u] = fv.y; acc[o + 5u] = fv.z;
    // Use the wall application point, rather than an illustrative resultant location.
    let arm = pos + nrm * wv.w - P.origin.xyz;
    let mp = cross(arm, fp); let mv = cross(arm, fv);
    let mo = li * 24u + 12u + wheel * 6u;
    acc[mo] = mp.x; acc[mo+1u] = mp.y; acc[mo+2u] = mp.z;
    acc[mo+3u] = mv.x; acc[mo+4u] = mv.y; acc[mo+5u] = mv.z;
    for (var m = 0u; m < 6u; m++) {
      faceForce[fid * 12u + m] = acc[o + m];
      faceForce[fid * 12u + 6u + m] = acc[mo + m];
    }
  }
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) {
      for (var m = 0u; m < 24u; m++) { acc[li * 24u + m] += acc[(li + s) * 24u + m]; }
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let g = wid.x + wid.y * nwg.x;
    for (var m = 0u; m < 24u; m++) { partials[g * 24u + m] = acc[m]; }
  }
}
`;

export const forcesSumWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> partials: array<f32>;
@group(0) @binding(5) var<storage, read_write> state: array<f32>;
@group(0) @binding(6) var<storage, read_write> history: array<f32>;
override GROUPS: u32;

var<workgroup> acc: array<f32, ${WG * 24}>;

@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_index) li: u32) {
  var local: array<f32, 24>;
  for (var g = li; g < GROUPS; g += ${WG}u) {
    for (var m = 0u; m < 24u; m++) { local[m] += partials[g * 24u + m]; }
  }
  for (var m = 0u; m < 24u; m++) { acc[li * 24u + m] = local[m]; }
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) {
      for (var m = 0u; m < 24u; m++) { acc[li * 24u + m] += acc[(li + s) * 24u + m]; }
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let dt = state[0];
    state[1] = state[1] + dt;
    state[2] = state[2] + 1.0;
    let slot = u32(state[2]) % P.modes.w;
    let o = slot * 32u;
    history[o] = state[1];
    history[o + 1u] = dt;
    history[o + 2u] = state[2];
    history[o + 3u] = 0.0;
    for (var m = 0u; m < 24u; m++) { history[o + 4u + m] = acc[m]; }
  }
}
`;

// Per-part forces: one workgroup per part sums its (contiguous) wall cells and adds the force,
// weighted by the pseudo-time step (dt × pace factor in state[3]), to a running integral.
export const partForcesWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> faceForce: array<f32>;
@group(0) @binding(5) var<storage, read> ranges: array<u32>;
@group(0) @binding(6) var<storage, read> state: array<f32>;
@group(0) @binding(7) var<storage, read_write> partAcc: array<f32>;
override NPARTS: u32;

var<workgroup> acc: array<f32, ${WG * 12}>;

@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let p = wid.x + wid.y * nwg.x;
  var local: array<f32, 12>;
  if (p < NPARTS) {
    let a = ranges[2u * p];
    let b = ranges[2u * p + 1u];
    for (var f = a + li; f < b; f += ${WG}u) {
      for (var m = 0u; m < 12u; m++) { local[m] += faceForce[f * 12u + m]; }
    }
  }
  for (var m = 0u; m < 12u; m++) { acc[li * 12u + m] = local[m]; }
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) {
      for (var m = 0u; m < 12u; m++) { acc[li * 12u + m] += acc[(li + s) * 12u + m]; }
    }
    workgroupBarrier();
  }
  if (li == 0u && p < NPARTS) {
    let w = state[0] * state[3];
    for (var m = 0u; m < 12u; m++) { partAcc[p * 12u + m] += w * acc[m]; }
  }
}
`;
