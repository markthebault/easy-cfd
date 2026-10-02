import { common, WG } from "./common";
import { farfieldPressure } from "./farfield";

// Independently implemented finite-volume equations. The OpenFOAM v2412 source audit is in
// docs/webgpu-openfoam-algorithm. This remains a staggered Cartesian discretization: it does
// not reproduce OpenFOAM's collocated polyhedral mesh, non-orthogonal corrections or SIMPLEC.
export const assembleMomentumWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> vel: array<f32>;
@group(0) @binding(5) var<storage, read> turb: array<f32>;
@group(0) @binding(6) var<storage, read> aper: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> wall: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> matrix: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> mobility: array<f32>;
@group(0) @binding(10) var<storage, read> state: array<f32>;
override RELAX: f32 = 0.7;

fn U(a: u32, q: i32) -> f32 { return vel[a*NC()+u32(q)]; }
fn nut(q: i32) -> f32 { return turb[2u*NC()+u32(q)]; }
fn blocked(a: u32, q: i32) -> bool {
  return aper[u32(q)][a] <= 0.0 || solid(q) || solid(q+strideOf(a));
}
fn slope(left: f32, centre: f32, right: f32, dl: f32, dr: f32) -> f32 {
  let gl = (centre-left)/dl; let gr = (right-centre)/dr;
  if (gl*gr <= 0.0) { return 0.0; }
  return sign(gl)*min(abs(gl),abs(gr));
}
fn faceValue(a: u32, t: u32, q: i32, nb: i32, side: i32, F: f32, e: vec3<i32>) -> f32 {
  let up = select(q,nb,F < 0.0); let down = select(nb,q,F < 0.0);
  let uc = U(a,up); let ud = U(a,down);
  if (P.opts.z == 2u) { return uc; }
  let s = strideOf(t); let eu = decode(u32(up));
  let nt = dimOf(t)-2;
  if (eu[t] < 1 || eu[t] > nt || blocked(a,up)) { return uc; }
  var left = uc; var right = uc;
  if (eu[t] > 1 && !blocked(a,up-s)) { left = U(a,up-s); }
  if (eu[t] < nt && !blocked(a,up+s)) { right = U(a,up+s); }
  var dl = abs(cc(t,eu[t])-cc(t,eu[t]-1));
  var dr = abs(cc(t,eu[t]+1)-cc(t,eu[t]));
  var offset = 0.5*cw(t,eu[t]);
  if (t == a) {
    dl = cw(a,eu[a]); dr = cw(a,eu[a]+1);
    offset = select(0.5*cw(a,e[a]),0.5*cw(a,e[a]+1),side > 0);
  }
  // Limited linear-upwind correction; unlike the old limiter, distances enter on stretched grids.
  let direction = select(f32(side),-f32(side),F < 0.0);
  let correction = direction*offset*slope(left,uc,right,dl,dr);
  let maxCorrection = 0.5*(ud-uc);
  if (P.opts.z == 0u) {
    let gl = (uc-left)/dl; let gr = (right-uc)/dr;
    if (gl*gr <= 0.0) { return uc; }
    return clamp(uc+direction*offset*2.0*gl*gr/(gl+gr),min(uc,ud),max(uc,ud));
  }
  if (correction*maxCorrection <= 0.0) { return uc; }
  return uc+sign(correction)*min(abs(correction),abs(maxCorrection));
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid,nwg); if (id >= NC()) { return; }
  let e = decode(id); let q = i32(id);
  for (var a = 0u; a < 3u; a++) {
    let field = a*NC()+id; let m = 2u*field;
    matrix[m] = vec4<f32>(0.0); matrix[m+1u] = vec4<f32>(0.0);
    mobility[field] = state[0]*turb[4u*NC()+id];
    if (!interior(e) || e[a] >= dimOf(a)-2 || blocked(a,q)) { continue; }
    let sa = strideOf(a); let ap0 = aper[id]; let ap1 = aper[u32(q+sa)];
    let da = cw(a,e[a]); let da1 = cw(a,e[a]+1);
    let delta = 0.5*(da+da1);
    var widths = vec3<f32>(cw(0u,e.x),cw(1u,e.y),cw(2u,e.z)); widths[a] = delta;
    let volume = widths.x*widths.y*widths.z;
    let theta = (ap0.w*da+ap1.w*da1)/(da+da1);
    let up = U(a,q); var diagonal = 0.0; var source = 0.0;
    var links: array<f32,6>;
    for (var t = 0u; t < 3u; t++) {
      let st = strideOf(t); let area = volume/widths[t];
      for (var sideIndex = 0u; sideIndex < 2u; sideIndex++) {
        let side = select(-1,1,sideIndex == 1u);
        let nb = q+side*st; let fq = select(q-st,q,side > 0);
        var F: f32; var diffusion: f32;
        if (t == a) {
          let openness = 0.5*(aper[u32(fq)][a]+aper[u32(fq+sa)][a]);
          F = f32(side)*openness*0.5*(up+U(a,nb))*area;
          let distance = select(da,da1,side > 0);
          let nq = select(q,q+sa,side > 0);
          diffusion = openness*(P.turb.z+nut(nq))*area/distance;
          if ((P.opts.w & 1u) != 0u) { diffusion *= 2.0; }
        } else {
          let a0 = aper[u32(fq)][t]; let a1 = aper[u32(fq+sa)][t];
          let openness = (a0*da+a1*da1)/(da+da1);
          F = f32(side)*0.5*(U(t,fq)*a0*da+U(t,fq+sa)*a1*da1)*area/delta;
          let viscosity = P.turb.z+0.25*(nut(q)+nut(q+sa)+nut(nb)+nut(nb+sa));
          diffusion = openness*viscosity*area/abs(cc(t,e[t]+side)-cc(t,e[t]));
          if ((P.opts.w & 1u) != 0u) {
            source += f32(side)*openness*viscosity*area*(U(t,fq+sa)-U(t,fq))/delta;
          }
        }
        if (t == 2u && side < 0 && e.z == 1 && a != 2u) {
          let y = 0.5*cw(2u,e.z);
          let d = nuWall(0.5*(turb[id]+turb[u32(q+sa)]),y)*area/y;
          diagonal += d; source += d*select(0.0,P.inlet.w,a == 0u); continue;
        }
        let inside = e[t]+side >= 1 && e[t]+side <= dimOf(t)-2;
        if (inside && blocked(a,nb)) {
          // Solid neighbours receive wall shear through the cut surface below.
          diagonal += max(-F,0.0); continue;
        }
        let link = max(-F,0.0)+diffusion;
        links[2u*t+sideIndex] = link; diagonal += link;
        source -= F*(faceValue(a,t,q,nb,side,F,e)-select(up,U(a,nb),F < 0.0));
      }
    }
    let w0 = wall[id]; let w1 = wall[u32(q+sa)];
    let area0 = length(w0.xyz); let area1 = length(w1.xyz);
    if (area0+area1 > 0.0) {
      let area = 0.5*(area0+area1);
      let y = (area0*w0.w+area1*w1.w)/(area0+area1);
      let normal = w0.xyz+w1.xyz;
      let nrm = normal/max(length(normal),1e-12);
      var uc = vec3<f32>(0.0); uc[a] = up;
      for (var b = 0u; b < 3u; b++) {
        if (b != a) { let sb = strideOf(b); uc[b] = 0.25*(U(b,q)+U(b,q-sb)+U(b,q+sa)+U(b,q+sa-sb)); }
      }
      var position = vec3<f32>(cc(0u,e.x),cc(1u,e.y),cc(2u,e.z)); position[a] += 0.5*da;
      let part = select(partOf(q+sa),partOf(q),area0 >= area1);
      let uw = wallVelocity(part,position); let slip = uc-uw;
      let d = nuWall(0.5*(turb[id]+turb[u32(q+sa)]),y)*area/y;
      // Diagonal tangential wall stress, with the cross-component contribution deferred.
      diagonal += d*(1.0-nrm[a]*nrm[a]);
      source += d*(uw[a]+nrm[a]*(dot(slip,nrm)-nrm[a]*up));
    }
    if ((P.opts.w & 128u) != 0u) {
      let dt = state[0]*min(turb[4u*NC()+id],turb[4u*NC()+u32(q+sa)]);
      let damping = volume*theta/dt;
      diagonal += damping; source += damping*up;
    }
    diagonal = max(diagonal,1e-20);
    source += (1.0/RELAX-1.0)*diagonal*up;
    let relaxed = diagonal/RELAX;
    matrix[m] = vec4<f32>(links[0],links[1],links[2],links[3]);
    matrix[m+1u] = vec4<f32>(links[4],links[5],relaxed,source);
    var pressureDiagonal = relaxed;
    if ((P.opts.w & 512u) != 0u) {
      pressureDiagonal -= links[0]+links[1]+links[2]+links[3]+links[4]+links[5];
    }
    mobility[field] = volume*theta/max(pressureDiagonal,1e-20);
  }
}
`;

export const solveMomentumWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> input: array<f32>;
@group(0) @binding(5) var<storage, read_write> output: array<f32>;
@group(0) @binding(6) var<storage, read> matrix: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> mobility: array<f32>;
@group(0) @binding(8) var<storage, read> pressure: array<f32>;
override EXTRACT: bool = false;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid,nwg); if (id >= NC()) { return; }
  let e = decode(id); let q = i32(id);
  for (var a = 0u; a < 3u; a++) {
    let field = a*NC()+id; let m = 2u*field; let c0 = matrix[m]; let c1 = matrix[m+1u];
    output[field] = input[field]; if (c1.z <= 0.0) { continue; }
    let sa = strideOf(a); let offset = a*NC();
    let gradient = (pressure[u32(q+sa)]-pressure[id])/(cc(a,e[a]+1)-cc(a,e[a]));
    if (EXTRACT) { output[field] = input[field]+mobility[field]*gradient; continue; }
    let sum = c0.x*input[offset+u32(q-1)]+c0.y*input[offset+u32(q+1)]
      +c0.z*input[offset+u32(q-NX())]+c0.w*input[offset+u32(q+NX())]
      +c1.x*input[offset+u32(q-NX()*NY())]+c1.y*input[offset+u32(q+NX()*NY())];
    var inverse = mobility[field];
    if ((P.opts.w & 512u) != 0u) { inverse *= (c1.z-c0.x-c0.y-c0.z-c0.w-c1.x-c1.y)/c1.z; }
    output[field] = (sum+c1.w)/c1.z-inverse*gradient;
  }
}
`;

export const momentumPressureWGSL = common + /* wgsl */ `
@group(0) @binding(4) var<storage, read> geometry: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> mobility: array<f32>;
@group(0) @binding(6) var<storage, read_write> coefficients: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> state: array<f32>;
@group(0) @binding(8) var<storage, read> turb: array<f32>;
@group(0) @binding(9) var<storage, read> velocity: array<f32>;
${farfieldPressure("velocity")}
fn inverse(a: u32, q: i32) -> f32 {
  if ((P.opts.w & 64u) != 0u) { return mobility[a*NC()+u32(q)]; }
  let e = decode(u32(q)); let sa = strideOf(a);
  if (e[a] == 0) { return state[0]*turb[4u*NC()+u32(q+sa)]; }
  if (e[a] == dimOf(a)-2) { return state[0]*turb[4u*NC()+u32(q)]; }
  return state[0]*min(turb[4u*NC()+u32(q)],turb[4u*NC()+u32(q+sa)]);
}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gidx(gid,nwg); if (id >= NC()) { return; }
  let e = decode(id); let q = i32(id); var c = vec4<f32>(0.0);
  for (var a = 0u; a < 3u; a++) { c[a] = geometry[id][a]*inverse(a,q)/state[0]; }
  if (interior(e) && !solid(q)) {
    if (e.x == NX()-2) { c.w += cw(1u,e.y)*cw(2u,e.z)/(0.5*cw(0u,e.x))*inverse(0u,q)/state[0]; }
    let mixed = (P.opts.w & 256u) != 0u;
    if (e.y == 1 && (P.modes.x != 1u || mixed)) {
      var fraction = 1.0; if (mixed) { fraction = sidePressureFraction(q-NX(),-1); }
      c.w += fraction*cw(0u,e.x)*cw(2u,e.z)/(0.5*cw(1u,e.y))*inverse(1u,q-NX())/state[0];
    }
    if (e.y == NY()-2 && (P.modes.x != 2u || mixed)) {
      var fraction = 1.0; if (mixed) { fraction = sidePressureFraction(q,1); }
      c.w += fraction*cw(0u,e.x)*cw(2u,e.z)/(0.5*cw(1u,e.y))*inverse(1u,q)/state[0];
    }
  }
  coefficients[id] = c;
}
`;

export const coarsenMomentumPressureWGSL = /* wgsl */ `
struct Level { dims: vec4<u32>, cdims: vec4<u32>, opts: vec4<f32> };
@group(0) @binding(0) var<uniform> L: Level;
@group(0) @binding(1) var<storage, read> fine: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> coarse: array<vec4<f32>>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gid.x+gid.y*nwg.x*${WG}u; if (id >= L.cdims.w) { return; }
  coarse[id] = vec4<f32>(0.0);
  let E = vec3<u32>(id%L.cdims.x,(id/L.cdims.x)%L.cdims.y,id/(L.cdims.x*L.cdims.y));
  if (any(E < vec3<u32>(1u)) || any(E > L.cdims.xyz-vec3<u32>(2u))) { return; }
  var sum = vec4<f32>(0.0);
  for (var z = 0u; z < 2u; z++) { for (var y = 0u; y < 2u; y++) { for (var x = 0u; x < 2u; x++) {
    let e = 2u*E-vec3<u32>(1u)+vec3<u32>(x,y,z);
    if (any(e > L.dims.xyz-vec3<u32>(2u))) { continue; }
    let q = e.x+L.dims.x*(e.y+L.dims.y*e.z); let c = fine[q];
    if (x == 1u && E.x < L.cdims.x-2u) { sum.x += c.x; }
    if (y == 1u && E.y < L.cdims.y-2u) { sum.y += c.y; }
    if (z == 1u && E.z < L.cdims.z-2u) { sum.z += c.z; }
    sum.w += c.w;
  }}}
  coarse[id] = sum;
}
`;
