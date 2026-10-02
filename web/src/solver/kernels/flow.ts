import { common, WG } from "./common";
import { SCALE_PRESSURE, THETA_EFF } from "../setup";

// ---------------------------------------------------------------------------------------------
// Momentum predictor: u* = u + dt/θeff (−convection + diffusion + wall shear); the pressure
// projection follows. Finite volume on the staggered control volume of each face velocity, with
// cut-cell apertures (FAVOR): fluxes are weighted by open face fractions and the wall shear acts on
// the wall area inside the control volume. θeff = max(θ, THETA_EFF) keeps slivers stable; the
// projection scales ∇p by θ/θeff so the steady solution is unchanged.
// Convection: bounded second-order upwind (van Leer). Walls and road: k-based wall function.
// ---------------------------------------------------------------------------------------------
export const momentumWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read_write> velOut: array<f32>;
@group(0) @binding(6) var<storage, read> turb: array<f32>;   // k | omega | nut
@group(0) @binding(7) var<storage, read> aper: array<vec4<f32>>;  // open fraction +x,+y,+z faces, θ
@group(0) @binding(8) var<storage, read> state: array<f32>;  // dt, time
@group(0) @binding(9) var<storage, read> wall: array<vec4<f32>>;  // wall area vector, wall distance

const THETA_EFF: f32 = ${THETA_EFF};
override COMP: u32 = 3u;   // 3: all components in one thread; 0–2: one component per dispatch

fn U(a: u32, idx: i32) -> f32 { return vel[a * NC() + u32(idx)]; }
fn nut(idx: i32) -> f32 { return turb[2u * NC() + u32(idx)]; }
fn kk(idx: i32) -> f32 { return turb[u32(idx)]; }
fn fac(idx: i32) -> f32 { return turb[4u * NC() + u32(idx)]; }   // local time-step factor
fn AP(idx: i32) -> vec4<f32> { return aper[u32(idx)]; }

// Bounded upwind-biased face value. P.opts.z: 0 van Leer, 1 minmod, 2 first-order upwind.
fn vanLeer(uu: f32, c: f32, d: f32) -> f32 {
  let dcd = d - c;
  let dcu = c - uu;
  if (P.opts.z == 2u || dcu * dcd <= 0.0) { return c; }
  if (P.opts.z == 1u) { return c + 0.5 * sign(dcd) * min(abs(dcu), abs(dcd)); }
  return c + dcu * dcd / (dcu + dcd);
}

fn comp(v: vec3<f32>, a: u32) -> f32 {
  if (a == 0u) { return v.x; }
  if (a == 1u) { return v.y; }
  return v.z;
}

fn blocked(a: u32, idx: i32) -> bool {
  return AP(idx)[a] <= 0.0 || solid(idx) || solid(idx + strideOf(a));
}

// Tangential direction t of the control volume of component a at cell idx.
// Returns (convective, diffusive) contributions summed over the ± t-faces.
// wall = (normal into the solid, uτ); wy = wall distance of the control volume (0: no wall).
fn tangential(a: u32, t: u32, idx: i32, e: vec3<i32>, uP: f32, dA: f32, dA1: f32, wo: f32, wall4: vec4<f32>, wy: f32) -> vec2<f32> {
  let sa = strideOf(a);
  let st = strideOf(t);
  let et = e[t];
  let nt = dimOf(t) - 2;
  let nuL = P.turb.z;
  var conv = 0.0;
  var diff = 0.0;
  let delta = 0.5 * (dA + dA1);
  let area = delta * wo;
  for (var side = 0; side < 2; side++) {
    let sgn = select(-1, 1, side == 1);
    let nIdx = idx + sgn * st;
    let fIdx = select(idx - st, idx, side == 1);
    let a0 = AP(fIdx)[t];
    let a1 = AP(fIdx + sa)[t];
    // advecting flux through this t-face (outward), conservative with the cell mass fluxes
    let F = f32(sgn) * 0.5 * (vel[t * NC() + u32(fIdx)] * a0 * dA + vel[t * NC() + u32(fIdx + sa)] * a1 * dA1) * wo;
    let acv = (a0 * dA + a1 * dA1) / (dA + dA1);
    if (t == 2u && side == 0 && et == 1) {
      // road: log-law wall shear against the moving road (a is x or y here)
      let y = 0.5 * cw(t, et);
      let o = 1u - a;
      let so = strideOf(o);
      let uo = 0.25 * (U(o, idx) + U(o, idx - so) + U(o, idx + sa) + U(o, idx + sa - so));
      var slip = vec3<f32>(0.0);
      slip[a] = uP - select(0.0, P.inlet.w, a == 0u);
      slip[o] = uo - select(0.0, P.inlet.w, o == 0u);
      diff += -wallShear(slip, y, 0.5 * (kk(idx) + kk(idx + sa)))[a] * area;
      continue;
    }
    let inRange = (et + sgn >= 1) && (et + sgn <= nt);
    if (inRange && blocked(a, nIdx)) {
      // neighbour velocity lies in the solid; friction comes from the wall-shear term
      conv += F * (0.0 - uP);
      continue;
    }
    let uN = U(a, nIdx);
    let dist = abs(cc(t, et + sgn) - cc(t, et));
    var nuF = nuL + 0.25 * (nut(idx) + nut(idx + sa) + nut(nIdx) + nut(nIdx + sa));
    // Face leading away from a wall: carry the log-layer eddy viscosity κ uτ y that a resolved
    // boundary layer would have there (the SST strain limiter underestimates it on coarse cells).
    if ((P.opts.w & 2u) == 0u && wy > 0.0 && f32(sgn) * wall4[t] < -0.3) {
      nuF = max(nuF, nuL + KAPPA * wall4.w * (wy + 0.5 * cw(t, et)));
    }
    diff += acv * nuF * area * (uN - uP) / dist;
    if ((P.opts.w & 1u) != 0u) {
      // Symmetric Newtonian/Reynolds stress: nu_eff * d(U_t)/dx_a.
      diff += f32(sgn) * acv * nuF * area * (U(t, fIdx + sa) - U(t, fIdx)) / delta;
    }
    var uf: f32;
    if (F * f32(sgn) >= 0.0) {
      if (side == 1) {
        let far = select(uP, U(a, idx - st), et - 1 >= 0);
        uf = vanLeer(far, uP, uN);
      } else {
        let far = select(uN, U(a, nIdx - st), et - 2 >= 0);
        uf = vanLeer(far, uN, uP);
      }
    } else {
      if (side == 1) {
        let far = select(uN, U(a, nIdx + st), et + 2 <= nt + 1);
        uf = vanLeer(far, uN, uP);
      } else {
        let far = select(uP, U(a, idx + st), et + 1 <= nt + 1);
        uf = vanLeer(far, uP, uN);
      }
    }
    conv += F * (uf - uP);
  }
  return vec2<f32>(conv, diff);
}

fn predict(a: u32, idx: i32, e: vec3<i32>) {
  let out = a * NC() + u32(idx);
  let na = dimOf(a) - 2;
  let ea = e[a];
  if (ea < 1 || ea > na - 1) { return; }  // boundary faces are set by the boundary kernel
  let sa = strideOf(a);
  let alpha = AP(idx)[a];
  if (alpha <= 0.0 || solid(idx) || solid(idx + sa)) { velOut[out] = 0.0; return; }
  let b = (a + 1u) % 3u;
  let c = (a + 2u) % 3u;
  let dA = cw(a, ea);
  let dA1 = cw(a, ea + 1);
  let delta = cc(a, ea + 1) - cc(a, ea);
  let wb = cw(b, e[b]);
  let wc = cw(c, e[c]);
  let areaA = wb * wc;
  let vol = delta * areaA;
  let apP = AP(idx);
  let apE = AP(idx + sa);
  let thetaU = (apP.w * dA + apE.w * dA1) / (dA + dA1);
  let thetaE = max(thetaU, THETA_EFF);
  let uP = U(a, idx);
  let uE = U(a, idx + sa);
  let uW = U(a, idx - sa);
  let uEE = select(uE, U(a, idx + 2 * sa), ea + 2 <= na);
  let uWW = select(uW, U(a, idx - 2 * sa), ea - 2 >= 0);
  let nuL = P.turb.z;
  // control-volume faces along a sit at cell centres: mean of the two face apertures of that cell
  let aE = 0.5 * (alpha + apE[a]);
  let aW = 0.5 * (AP(idx - sa)[a] + alpha);
  let Fe = aE * 0.5 * (uP + uE) * areaA;
  let Fw = aW * 0.5 * (uW + uP) * areaA;
  let fe = select(vanLeer(uEE, uE, uP), vanLeer(uW, uP, uE), Fe >= 0.0);
  let fw = select(vanLeer(uE, uP, uW), vanLeer(uWW, uW, uP), Fw >= 0.0);
  var conv = Fe * (fe - uP) - Fw * (fw - uP);
  var diff = aE * (nuL + nut(idx + sa)) * areaA * (uE - uP) / dA1 - aW * (nuL + nut(idx)) * areaA * (uP - uW) / dA;
  if ((P.opts.w & 1u) != 0u) { diff *= 2.0; }
  // Wall shear on the wall area inside this control volume (half of each adjacent cell's).
  let w0 = wall[u32(idx)];
  let w1 = wall[u32(idx + sa)];
  let m0 = length(w0.xyz);
  let m1 = length(w1.xyz);
  var wall4 = vec4<f32>(0.0);
  var wy = 0.0;
  var shearA = 0.0;
  if (m0 + m1 > 0.0) {
    let area = 0.5 * (m0 + m1);
    let nsum = w0.xyz + w1.xyz;
    let nl = length(nsum);
    let y = (m0 * w0.w + m1 * w1.w) / (m0 + m1);
    var Uv = vec3<f32>(0.0);
    Uv[a] = uP;
    let sb = strideOf(b);
    let sc = strideOf(c);
    Uv[b] = 0.25 * (U(b, idx) + U(b, idx - sb) + U(b, idx + sa) + U(b, idx + sa - sb));
    Uv[c] = 0.25 * (U(c, idx) + U(c, idx - sc) + U(c, idx + sa) + U(c, idx + sa - sc));
    var pos = vec3<f32>(cc(0u, e.x), cc(1u, e.y), cc(2u, e.z));
    pos[a] = cc(a, ea) + 0.5 * dA;
    let part = select(partOf(idx + sa), partOf(idx), m0 >= m1);
    var slip = Uv - wallVelocity(part, pos);
    if (nl > 1e-12) {
      let n = nsum / nl;
      slip = slip - dot(slip, n) * n;
      wall4 = vec4<f32>(n, uTau(length(slip), y));
      wy = y;
    }
    shearA = -wallShear(slip, y, 0.5 * (kk(idx) + kk(idx + sa)))[a] * area;
  }
  let tb = tangential(a, b, idx, e, uP, dA, dA1, wc, wall4, wy);
  let tc = tangential(a, c, idx, e, uP, dA, dA1, wb, wall4, wy);
  conv += tb.x + tc.x;
  diff += tb.y + tc.y + shearA;
  let dt = state[0] * min(fac(idx), fac(idx + sa));
  velOut[out] = uP + dt * (diff - conv) / (vol * thetaE);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= NC()) { return; }
  let e = decode(id);
  if (!interior(e)) { return; }
  let idx = i32(id);
  if (COMP == 3u) {
    predict(0u, idx, e);
    predict(1u, idx, e);
    predict(2u, idx, e);
  } else {
    predict(COMP, idx, e);
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Velocity boundary conditions (three phases so that plane corners are written in a fixed order).
// Inlet: fixed velocity. Outlet: zero gradient (projection then enforces p = 0).
// Sides: freestream — fixed velocity on an inflow side, zero gradient otherwise.
// Road: no-penetration wall moving with road speed. Top: symmetry plane.
// ---------------------------------------------------------------------------------------------
export const bcVelocityWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> vel: array<f32>;
override PHASE: u32;

fn at(a: u32, i: i32, j: i32, k: i32) -> u32 { return a * NC() + u32(i + NX() * (j + NY() * k)); }

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = i32(gidx(gid, nwg));
  let nx = NX() - 2; let ny = NY() - 2; let nz = NZ() - 2;
  let Uin = P.inlet.xyz;
  if (PHASE == 0u) {
    if (id >= NY() * NZ()) { return; }
    let j = id % NY(); let k = id / NY();
    vel[at(0u, 0, j, k)] = Uin.x;
    vel[at(0u, nx, j, k)] = max(vel[at(0u, nx - 1, j, k)], 0.0);
    vel[at(1u, 0, j, k)] = 2.0 * Uin.y - vel[at(1u, 1, j, k)];
    vel[at(2u, 0, j, k)] = -vel[at(2u, 1, j, k)];
    vel[at(1u, nx + 1, j, k)] = vel[at(1u, nx, j, k)];
    vel[at(2u, nx + 1, j, k)] = vel[at(2u, nx, j, k)];
    vel[at(0u, nx + 1, j, k)] = vel[at(0u, nx, j, k)];
  } else if (PHASE == 1u) {
    if (id >= NX() * NZ()) { return; }
    let i = id % NX(); let k = id / NX();
    // y- side
    if (P.modes.x == 1u) {
      vel[at(1u, i, 0, k)] = Uin.y;
      vel[at(0u, i, 0, k)] = 2.0 * Uin.x - vel[at(0u, i, 1, k)];
      vel[at(2u, i, 0, k)] = -vel[at(2u, i, 1, k)];
    } else {
      vel[at(1u, i, 0, k)] = vel[at(1u, i, 1, k)];
      vel[at(0u, i, 0, k)] = vel[at(0u, i, 1, k)];
      vel[at(2u, i, 0, k)] = vel[at(2u, i, 1, k)];
    }
    // y+ side
    if (P.modes.x == 2u) {
      vel[at(1u, i, ny, k)] = Uin.y;
      vel[at(0u, i, ny + 1, k)] = 2.0 * Uin.x - vel[at(0u, i, ny, k)];
      vel[at(2u, i, ny + 1, k)] = -vel[at(2u, i, ny, k)];
    } else {
      vel[at(1u, i, ny, k)] = vel[at(1u, i, ny - 1, k)];
      vel[at(0u, i, ny + 1, k)] = vel[at(0u, i, ny, k)];
      vel[at(2u, i, ny + 1, k)] = vel[at(2u, i, ny, k)];
    }
    vel[at(1u, i, ny + 1, k)] = vel[at(1u, i, ny, k)];
  } else {
    if (id >= NX() * NY()) { return; }
    let i = id % NX(); let j = id / NX();
    // road
    vel[at(0u, i, j, 0)] = 2.0 * P.inlet.w - vel[at(0u, i, j, 1)];
    vel[at(1u, i, j, 0)] = -vel[at(1u, i, j, 1)];
    vel[at(2u, i, j, 0)] = 0.0;
    // symmetry top
    vel[at(0u, i, j, nz + 1)] = vel[at(0u, i, j, nz)];
    vel[at(1u, i, j, nz + 1)] = vel[at(1u, i, j, nz)];
    vel[at(2u, i, j, nz)] = 0.0;
    vel[at(2u, i, j, nz + 1)] = 0.0;
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Divergence of the predicted velocity → right-hand side of the pressure equation.
// ---------------------------------------------------------------------------------------------
export const divergenceWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read_write> rhs: array<f32>;
@group(0) @binding(6) var<storage, read> state: array<f32>;
@group(0) @binding(7) var<storage, read> aper: array<vec4<f32>>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= NC()) { return; }
  let e = decode(id);
  let idx = i32(id);
  if (!interior(e) || solid(idx)) { rhs[id] = 0.0; return; }
  let dx = cw(0u, e.x); let dy = cw(1u, e.y); let dz = cw(2u, e.z);
  let n = NC();
  let a = aper[id];
  let div = (a.x * vel[id] - aper[idx - 1].x * vel[u32(idx - 1)]) * dy * dz
          + (a.y * vel[n + id] - aper[idx - NX()].y * vel[n + u32(idx - NX())]) * dx * dz
          + (a.z * vel[2u * n + id] - aper[idx - NX() * NY()].z * vel[2u * n + u32(idx - NX() * NY())]) * dx * dy;
  rhs[id] = div / state[0];
}
`;

// ---------------------------------------------------------------------------------------------
// Projection: u = u* − dt ∇p on open faces and on fixed-pressure boundary faces. φ is the full
// kinematic pressure (non-incremental), warm-started from the previous step.
// ---------------------------------------------------------------------------------------------
export const correctWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> velStar: array<f32>;
@group(0) @binding(5) var<storage, read_write> vel: array<f32>;
@group(0) @binding(6) var<storage, read> phi: array<f32>;       // full kinematic pressure
@group(0) @binding(7) var<storage, read> turb: array<f32>;      // plane 4: local time-step factor
@group(0) @binding(8) var<storage, read> state: array<f32>;
@group(0) @binding(9) var<storage, read> aper: array<vec4<f32>>;

fn fac(idx: i32) -> f32 { return turb[4u * NC() + u32(idx)]; }

const THETA_EFF: f32 = ${THETA_EFF};

fn dirichlet(a: u32, side: i32) -> bool {
  // side: 0 low face, 1 high face of the domain along a
  if (a == 0u) { return side == 1; }
  if (a == 1u) {
    if (side == 0) { return P.modes.x != 1u; }
    return P.modes.x != 2u;
  }
  return false;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid, nwg);
  if (id >= NC()) { return; }
  let e = decode(id);
  let idx = i32(id);
  let dt0 = state[0];
  let n = NC();
  for (var a = 0u; a < 3u; a++) {
    let o = a * n + id;
    var v = velStar[o];
    let ea = e[a];
    let na = dimOf(a) - 2;
    let b = (a + 1u) % 3u;
    let c = (a + 2u) % 3u;
    let inBC = e[b] >= 1 && e[b] <= dimOf(b) - 2 && e[c] >= 1 && e[c] <= dimOf(c) - 2;
    if (inBC) {
      let sa = strideOf(a);
      if (ea >= 1 && ea <= na - 1) {
        let ap = aper[id];
        if (!solid(idx) && !solid(idx + sa) && ap[a] > 0.0) {
          let dA = cw(a, ea);
          let dA1 = cw(a, ea + 1);
          let tf = (ap.w * dA + aper[idx + sa].w * dA1) / (dA + dA1);
          var beta = select(1.0, tf / max(tf, THETA_EFF), ${SCALE_PRESSURE} || (P.opts.w & 16u) != 0u);
          // merged sliver: the link face carries a boosted correction (same factor as in the Poisson matrix)
          let lP = (flags[id] >> 16u) & 7u;
          let lE = (flags[u32(idx + sa)] >> 16u) & 7u;
          if (lP == 2u * a + 2u || lE == 2u * a + 1u) { beta = beta * bitcast<f32>(P.opts.y); }
          v -= beta * dt0 * min(fac(idx), fac(idx + sa)) * (phi[u32(idx + sa)] - phi[id]) / (cc(a, ea + 1) - cc(a, ea));
        }
      } else if (ea == na && dirichlet(a, 1) && !solid(idx)) {
        v -= dt0 * fac(idx) * (0.0 - phi[id]) / (0.5 * cw(a, ea));
      } else if (ea == 0 && dirichlet(a, 0) && !solid(idx + sa)) {
        v -= dt0 * fac(idx + sa) * (phi[u32(idx + sa)] - 0.0) / (0.5 * cw(a, 1));
      }
    }
    // Safety net for pathological cut cells: no face velocity beyond four times the free stream.
    let vmax = 4.0 * max(length(P.inlet.xyz), 1.0);
    vel[o] = clamp(v, -vmax, vmax);
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Stable time step: dt = CFL / max(|u|/dx + |v|/dy + |w|/dz + 2 νeff Σ 1/dx²).
// ---------------------------------------------------------------------------------------------
export const dtReduceWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read> turb: array<f32>;
@group(0) @binding(6) var<storage, read_write> lmax: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> aper: array<vec4<f32>>;

const THETA_EFF: f32 = ${THETA_EFF};

var<workgroup> best: array<f32, ${WG}>;

// Stability limit from volumetric fluxes through the open face parts relative to the (clamped)
// fluid volume, plus explicit diffusion.
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = gidx(gid, nwg);
  var l = 0.0;
  if (id < NC()) {
    let e = decode(id);
    let idx = i32(id);
    if (interior(e) && !solid(idx)) {
      let n = NC();
      let dx = cw(0u, e.x); let dy = cw(1u, e.y); let dz = cw(2u, e.z);
      let a = aper[id];
      let th = max(a.w, THETA_EFF);
      let u = max(abs(a.x * vel[id]), abs(aper[idx - 1].x * vel[u32(idx - 1)]));
      let v = max(abs(a.y * vel[n + id]), abs(aper[idx - NX()].y * vel[n + u32(idx - NX())]));
      let w = max(abs(a.z * vel[2u * n + id]), abs(aper[idx - NX() * NY()].z * vel[2u * n + u32(idx - NX() * NY())]));
      let nuE = P.turb.z + turb[2u * n + id];
      l = (u / dx + v / dy + w / dz) / th + 2.0 * nuE * (1.0 / (dx * dx) + 1.0 / (dy * dy) + 1.0 / (dz * dz));
    }
  }
  best[li] = l;
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) { best[li] = max(best[li], best[li + s]); }
    workgroupBarrier();
  }
  if (li == 0u) { atomicMax(&lmax[0], bitcast<u32>(best[0])); }
}
`;

export const dtFinalizeWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> lmax: array<u32>;
@group(0) @binding(5) var<storage, read_write> state: array<f32>;

@compute @workgroup_size(1)
fn main() {
  let l = max(bitcast<f32>(lmax[0]), 1e-6);
  let old = state[0];
  var dt = P.misc.x / l;
  if (old > 0.0) { dt = min(dt, old * P.misc.z); }
  state[0] = min(dt, P.misc.y);
  lmax[0] = 0u;
}
`;
