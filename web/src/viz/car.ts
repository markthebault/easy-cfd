// Car meshes: welded smooth normals from a triangle soup (creased at sharp edges), a clay/paint
// look before results, and per-vertex surface pressure afterwards.

import * as THREE from "three";
import { sample, toLinear } from "./colormap";

interface Weld {
  /** Group id per soup vertex (coincident vertices share a group). */
  group: Int32Array;
  groups: number;
}

/** Spatial hash on quantised coordinates; exact comparison resolves hash collisions. */
function weld(pos: Float32Array): Weld {
  const nv = pos.length / 3;
  let span = 0;
  for (let i = 0; i < pos.length; i++) span = Math.max(span, Math.abs(pos[i]));
  const q = 1 / (Math.max(span, 1e-6) * 2e-6);
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Int32Array(nv * 3);
  const group = new Int32Array(nv);
  const first: number[] = [];
  for (let v = 0; v < nv; v++) {
    const x = Math.round(pos[3 * v] * q), y = Math.round(pos[3 * v + 1] * q), z = Math.round(pos[3 * v + 2] * q);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const g = table[h];
      if (g < 0) {
        table[h] = first.length;
        group[v] = first.length;
        keys.set([x, y, z], first.length * 3);
        first.push(v);
        break;
      }
      if (keys[3 * g] === x && keys[3 * g + 1] === y && keys[3 * g + 2] === z) {
        group[v] = g;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }
  return { group, groups: first.length };
}

const cache = new WeakMap<Float32Array, { geometry: THREE.BufferGeometry; weld: Weld }>();

/** Non-indexed geometry with smooth normals where faces meet at less than ~40°. */
export function carGeometry(pos: Float32Array): THREE.BufferGeometry {
  const hit = cache.get(pos);
  if (hit) return hit.geometry;
  const w = weld(pos);
  const nt = pos.length / 9;
  const faceN = new Float32Array(nt * 3);
  const acc = new Float32Array(w.groups * 3);
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    // Area-weighted (unnormalised cross product) accumulation.
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    faceN.set([nx / l, ny / l, nz / l], t * 3);
    for (let v = 0; v < 3; v++) {
      const g = w.group[t * 3 + v] * 3;
      acc[g] += nx;
      acc[g + 1] += ny;
      acc[g + 2] += nz;
    }
  }
  for (let g = 0; g < w.groups; g++) {
    const l = Math.hypot(acc[3 * g], acc[3 * g + 1], acc[3 * g + 2]) || 1;
    acc[3 * g] /= l;
    acc[3 * g + 1] /= l;
    acc[3 * g + 2] /= l;
  }
  const normals = new Float32Array(pos.length);
  const crease = Math.cos((40 * Math.PI) / 180);
  for (let t = 0; t < nt; t++)
    for (let v = 0; v < 3; v++) {
      const vi = t * 3 + v, g = w.group[vi] * 3;
      const fx = faceN[t * 3], fy = faceN[t * 3 + 1], fz = faceN[t * 3 + 2];
      const smooth = acc[g] * fx + acc[g + 1] * fy + acc[g + 2] * fz > crease;
      normals.set(smooth ? [acc[g], acc[g + 1], acc[g + 2]] : [fx, fy, fz], vi * 3);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  cache.set(pos, { geometry, weld: w });
  return geometry;
}

/** Map a diverging value so zero always lands on the neutral midpoint. */
export function divergingT(v: number, lo: number, hi: number): number {
  if (v < 0) return 0.5 - 0.5 * Math.min(1, v / Math.min(lo, -1e-9));
  return 0.5 + 0.5 * Math.min(1, v / Math.max(hi, 1e-9));
}

/**
 * Vertex colours for Cp. Coincident vertices are averaged (the solver samples each triangle
 * corner separately) so the colour is continuous; vertices without data stay neutral grey.
 */
export function applyPressureColors(pos: Float32Array, cp: Float32Array | null, range: [number, number]): THREE.BufferAttribute | null {
  const entry = cache.get(pos);
  if (!entry || !cp || cp.length !== pos.length / 3) return null;
  const { group, groups } = entry.weld;
  const sum = new Float32Array(groups), cnt = new Uint16Array(groups);
  for (let v = 0; v < cp.length; v++) {
    const c = cp[v];
    if (Number.isFinite(c)) {
      sum[group[v]] += c;
      cnt[group[v]]++;
    }
  }
  const colors = new Float32Array(cp.length * 3);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < cp.length; v++) {
    const g = group[v];
    if (!cnt[g]) {
      colors.set([0.42, 0.42, 0.42], v * 3);
      continue;
    }
    sample("diverging", divergingT(sum[g] / cnt[g], range[0], range[1]), rgb);
    colors.set([toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])], v * 3);
  }
  return new THREE.BufferAttribute(colors, 3);
}

export function clayMaterial(role: "body" | "wheel"): THREE.MeshPhysicalMaterial {
  return role === "wheel"
    ? new THREE.MeshPhysicalMaterial({ color: 0x24262b, roughness: 0.72, metalness: 0.0, clearcoat: 0.05 })
    : new THREE.MeshPhysicalMaterial({ color: 0xd9d6cf, roughness: 0.38, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.18 });
}

export function pressureMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0 });
}

/** Keep triangle sides separate: welding would average opposite sides of a thin wing. */
export function applyStressColors(stress: Float32Array, valid: Uint8Array | undefined, max: number, q: number): THREE.BufferAttribute {
  const colors = new Float32Array(stress.length), rgb: [number,number,number]=[0,0,0];
  for(let i=0;i<stress.length/3;i++) {
    const value=Math.hypot(stress[i*3],stress[i*3+1],stress[i*3+2])/q;
    if(valid?.[i]!==1 || !Number.isFinite(value)) colors.set([.3,.3,.3],i*3);
    else { sample("speed",Math.min(1,value/Math.max(max,1e-12)),rgb); colors.set(rgb.map(toLinear),i*3); }
  }
  return new THREE.BufferAttribute(colors,3);
}
