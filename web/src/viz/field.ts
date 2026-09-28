// GPU and CPU access to a solver VizField. The GPU copy is two RGBA16F 3D textures with hardware
// trilinear filtering: A = (u, v, w, fluid), B = (p, k, 0, 1). Everything drawn comes from here.

import * as THREE from "three";
import type { VizField } from "../solver/extract";

export interface FieldGPU {
  velocity: THREE.Data3DTexture;
  scalars: THREE.Data3DTexture;
  origin: THREE.Vector3;
  /** spacing × (dims − 1): the box the samples span. */
  extent: THREE.Vector3;
  dims: THREE.Vector3;
}

function texture3D(data: Float32Array, d: [number, number, number]): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, d[0], d[1], d[2]);
  t.format = THREE.RGBAFormat;
  t.type = THREE.FloatType;
  // Half-float storage is always filterable in WebGL2; full float needs an extension.
  t.internalFormat = "RGBA16F";
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function createFieldGPU(f: VizField): FieldGPU {
  const n = f.dims[0] * f.dims[1] * f.dims[2];
  const a = new Float32Array(n * 4);
  const b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const fluid = f.solid[i] ? 0 : 1;
    a[4 * i] = f.u[i];
    a[4 * i + 1] = f.v[i];
    a[4 * i + 2] = f.w[i];
    a[4 * i + 3] = fluid;
    b[4 * i] = f.p[i];
    b[4 * i + 1] = f.k[i];
    b[4 * i + 3] = 1;
  }
  return {
    velocity: texture3D(a, f.dims),
    scalars: texture3D(b, f.dims),
    origin: new THREE.Vector3(...f.origin),
    extent: new THREE.Vector3(f.spacing[0] * (f.dims[0] - 1), f.spacing[1] * (f.dims[1] - 1), f.spacing[2] * (f.dims[2] - 1)),
    dims: new THREE.Vector3(...f.dims),
  };
}

export function disposeFieldGPU(g: FieldGPU | null) {
  g?.velocity.dispose();
  g?.scalars.dispose();
}

/** GLSL: world position → 3D texture coordinate (texel centres at the sample points). */
export const FIELD_GLSL = /* glsl */ `
uniform highp sampler3D uVelocity;
uniform highp sampler3D uScalars;
uniform vec3 uOrigin;
uniform vec3 uExtent;
uniform vec3 uDims;
vec3 fieldUVW(vec3 p) {
  vec3 t = (p - uOrigin) / uExtent;
  return (t * (uDims - 1.0) + 0.5) / uDims;
}
bool insideField(vec3 p) {
  vec3 t = (p - uOrigin) / uExtent;
  return all(greaterThanEqual(t, vec3(0.0))) && all(lessThanEqual(t, vec3(1.0)));
}
vec4 velocityAt(vec3 p) { return texture(uVelocity, fieldUVW(p)); }
vec4 scalarsAt(vec3 p) { return texture(uScalars, fieldUVW(p)); }
// Solid samples hold zero velocity; dividing by the filtered fluid fraction undoes that bias.
vec3 flowAt(vec3 p) { vec4 a = velocityAt(p); return a.xyz / max(a.w, 0.5); }
`;

export function fieldUniforms(g: FieldGPU | null) {
  return {
    uVelocity: { value: g?.velocity ?? null },
    uScalars: { value: g?.scalars ?? null },
    uOrigin: { value: g?.origin.clone() ?? new THREE.Vector3() },
    uExtent: { value: g?.extent.clone() ?? new THREE.Vector3(1, 1, 1) },
    uDims: { value: g?.dims.clone() ?? new THREE.Vector3(2, 2, 2) },
  };
}

export function updateFieldUniforms(u: ReturnType<typeof fieldUniforms>, g: FieldGPU | null) {
  u.uVelocity.value = g?.velocity ?? null;
  u.uScalars.value = g?.scalars ?? null;
  if (g) {
    u.uOrigin.value.copy(g.origin);
    u.uExtent.value.copy(g.extent);
    u.uDims.value.copy(g.dims);
  }
}

/** CPU trilinear sampler that ignores solid samples (weights renormalised). */
export class FieldSampler {
  constructor(readonly f: VizField) {}

  /** out = [u, v, w, p, k]; false inside the car or outside the field. */
  sample(x: number, y: number, z: number, out: Float32Array): boolean {
    const f = this.f;
    const [nx, ny, nz] = f.dims;
    const gx = (x - f.origin[0]) / f.spacing[0], gy = (y - f.origin[1]) / f.spacing[1], gz = (z - f.origin[2]) / f.spacing[2];
    if (gx < 0 || gy < 0 || gz < 0 || gx > nx - 1 || gy > ny - 1 || gz > nz - 1) return false;
    const i = Math.min(nx - 2, Math.floor(gx)), j = Math.min(ny - 2, Math.floor(gy)), k = Math.min(nz - 2, Math.floor(gz));
    const tx = gx - i, ty = gy - j, tz = gz - k;
    // Inside the car if the nearest sample is solid.
    const near = i + (tx > 0.5 ? 1 : 0) + nx * (j + (ty > 0.5 ? 1 : 0) + ny * (k + (tz > 0.5 ? 1 : 0)));
    if (f.solid[near]) return false;
    let wsum = 0;
    out.fill(0);
    for (let dk = 0; dk < 2; dk++)
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const idx = i + di + nx * (j + dj + ny * (k + dk));
          if (f.solid[idx]) continue;
          const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
          wsum += w;
          out[0] += w * f.u[idx];
          out[1] += w * f.v[idx];
          out[2] += w * f.w[idx];
          out[3] += w * f.p[idx];
          out[4] += w * f.k[idx];
        }
    if (wsum < 1e-6) return false;
    for (let m = 0; m < 5; m++) out[m] /= wsum;
    return true;
  }
}

export function fieldBox(f: VizField): { min: THREE.Vector3; max: THREE.Vector3 } {
  const min = new THREE.Vector3(...f.origin);
  const max = new THREE.Vector3(
    f.origin[0] + f.spacing[0] * (f.dims[0] - 1),
    f.origin[1] + f.spacing[1] * (f.dims[1] - 1),
    f.origin[2] + f.spacing[2] * (f.dims[2] - 1),
  );
  return { min, max };
}
