// WGSL shared by the flow kernels. Layout: every field is stored on an (nx+2)(ny+2)(nz+2)
// array with one ghost layer. Velocity components live on the +x, +y and +z faces of their
// cell (MAC staggering): u[i] is the face between cells i and i+1.

export const WG = 128;

export const common = /* wgsl */ `
struct Params {
  dims: vec4<u32>,     // NX, NY, NZ, NC (with ghosts)
  inlet: vec4<f32>,    // inlet velocity xyz, ground velocity
  turb: vec4<f32>,     // k inlet, omega inlet, nu, rho
  misc: vec4<f32>,     // cfl, max dt, dt growth cap, face count
  modes: vec4<u32>,    // side mode (0 outflow both, 1 y- inflow, 2 y+ inflow), wheels on, parts, history slots
  goff: vec4<u32>,     // grid buffer offsets: centres x, y, z; widths base
  origin: vec4<f32>,   // saved moment reference in metres
  opts: vec4<u32>,     // wall model (0 k-based as OpenFOAM nutkWallFunction, 1 equilibrium log law)
};

struct Parts { a: array<vec4<f32>, 64> };  // centre xyz, angular velocity about +Y (0: fixed wall)

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<uniform> PARTS: Parts;
@group(0) @binding(2) var<storage, read> grid: array<f32>;
@group(0) @binding(3) var<storage, read> flags: array<u32>;

const KAPPA: f32 = 0.41;
const E_WALL: f32 = 9.8;
const CMU25: f32 = 0.5477226;
const YPLUS_LAM: f32 = 11.53;

fn NX() -> i32 { return i32(P.dims.x); }
fn NY() -> i32 { return i32(P.dims.y); }
fn NZ() -> i32 { return i32(P.dims.z); }
fn NC() -> u32 { return P.dims.w; }

fn strideOf(a: u32) -> i32 {
  if (a == 0u) { return 1; }
  if (a == 1u) { return NX(); }
  return NX() * NY();
}
fn dimOf(a: u32) -> i32 {
  if (a == 0u) { return NX(); }
  if (a == 1u) { return NY(); }
  return NZ();
}
fn cc(a: u32, n: i32) -> f32 { return grid[P.goff[a] + u32(n)]; }
fn cw(a: u32, n: i32) -> f32 { return grid[P.goff.w + P.goff[a] + u32(n)]; }

fn decode(idx: u32) -> vec3<i32> {
  let nx = u32(NX());
  let nxy = nx * u32(NY());
  return vec3<i32>(i32(idx % nx), i32((idx / nx) % u32(NY())), i32(idx / nxy));
}

fn roadDistance(idx: i32) -> f32 {
  if ((P.opts.w & 8192u) != 0u) { return max(grid[u32(2*(NX()+NY()+NZ())+idx)],1e-6); }
  return 0.5*cw(2u,decode(u32(idx)).z);
}

fn solid(idx: i32) -> bool { return (flags[u32(idx)] & 1u) != 0u; }
fn partOf(idx: i32) -> u32 { return (flags[u32(idx)] >> 8u) & 255u; }

fn interior(e: vec3<i32>) -> bool {
  return e.x >= 1 && e.y >= 1 && e.z >= 1 && e.x <= NX() - 2 && e.y <= NY() - 2 && e.z <= NZ() - 2;
}

// Surface velocity of a solid cell's part at a point (rotating wheels about +Y).
fn wallVelocity(part: u32, pos: vec3<f32>) -> vec3<f32> {
  if (P.modes.y == 0u) { return vec3<f32>(0.0); }
  let pa = PARTS.a[part];
  if (pa.w == 0.0) { return vec3<f32>(0.0); }
  let r = pos - pa.xyz;
  return vec3<f32>(pa.w * r.z, 0.0, -pa.w * r.x);
}

// Effective wall viscosity from the k-based log law (OpenFOAM nutkWallFunction).
fn nuWall(k: f32, y: f32) -> f32 {
  let nu = P.turb.z;
  let yp = CMU25 * sqrt(max(k, 0.0)) * y / nu;
  if (yp > YPLUS_LAM) { return nu * yp * KAPPA / log(E_WALL * yp); }
  return nu;
}

// Friction velocity from the log law U/uτ = ln(E y uτ/ν)/κ (linear sublayer below y+ = 11.53).
// Equilibrium wall model for wall cells that are much thicker than the viscous sublayer.
fn uTau(U: f32, y: f32) -> f32 {
  let nu = P.turb.z;
  let lam = sqrt(nu * U / y);
  if (lam * y / nu < YPLUS_LAM) { return lam; }
  var ut = max(lam, 1e-4);
  for (var i = 0; i < 8; i++) { ut = KAPPA * U / log(max(E_WALL * y * ut / nu, 1.0001)); }
  return ut;
}

// Wall shear stress (kinematic) along a tangential slip vector.
fn wallShear(slip: vec3<f32>, y: f32, k: f32) -> vec3<f32> {
  let s = length(slip);
  if (s < 1e-9) { return vec3<f32>(0.0); }
  if (P.opts.x == 0u) { return nuWall(k, y) * slip / y; }
  let ut = uTau(s, y);
  return ut * ut * slip / s;
}

fn gidx(gid: vec3<u32>, n: vec3<u32>) -> u32 { return gid.x + gid.y * n.x * ${WG}u; }
`;

export const header = (bindings: string) => common + bindings;
