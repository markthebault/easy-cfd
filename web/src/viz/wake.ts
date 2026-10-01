// Wake volume: iso-surface of the total-pressure coefficient Cp0 = (p + ½|u|²) / (½U∞²) extracted
// with naive surface nets on the resampled field. Cp0 = 1 is undisturbed air; the surface wraps
// the air that has lost total pressure (boundary layers, separated flow, vortices).

import * as THREE from "three";
import type { VizField } from "../solver/extract";
import { FieldSampler } from "./field";
import { sample, toLinear } from "./colormap";
import { divergingT } from "./car";

export type WakeColor = "speed" | "cp";

export function totalPressureCoefficient(f: VizField): Float32Array {
  const q = 0.5 * f.freestream * f.freestream;
  const n = f.u.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    // Solid samples count as undisturbed so the surface does not wrap the car itself.
    out[i] = f.solid[i] ? 1 : (f.p[i] + 0.5 * (f.u[i] ** 2 + f.v[i] ** 2 + f.w[i] ** 2)) / q;
  return out;
}

const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
];

export function surfaceNets(f: VizField, values: Float32Array, level: number): { positions: Float32Array; index: Uint32Array } {
  const [nx, ny, nz] = f.dims;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corner = new Float32Array(8);
  const at = (i: number, j: number, k: number) => values[i + nx * (j + ny * k)];
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        let valid = true;
        for (let c = 0; c < 8; c++) {
          const v = at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)) - level;
          if (!Number.isFinite(v)) valid = false;
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (!valid || mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          cnt++;
        }
        cellVert[i + cx * (j + cy * k)] = pos.length / 3;
        pos.push(
          f.origin[0] + (i + sx / cnt) * f.spacing[0],
          f.origin[1] + (j + sy / cnt) * f.spacing[1],
          f.origin[2] + (k + sz / cnt) * f.spacing[2],
        );
      }
  const idx: number[] = [];
  const cell = (i: number, j: number, k: number) => cellVert[i + cx * (j + cy * k)];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, d, c, a, c, b);
    else idx.push(a, b, c, a, c, d);
  };
  // Each grid edge with a sign change produces one quad from the four cells around it.
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = at(i, j, k) < level;
        if (i < cx && j > 0 && j < cy && k > 0 && k < cz && v0 !== at(i + 1, j, k) < level)
          quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !v0);
        if (j < cy && i > 0 && i < cx && k > 0 && k < cz && v0 !== at(i, j + 1, k) < level)
          quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !v0);
        if (k < cz && i > 0 && i < cx && j > 0 && j < cy && v0 !== at(i, j, k + 1) < level)
          quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !v0);
      }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}

/** Halve the resolution (2×2×2 block means) of a scalar field and its grid. */
function downsample(f: VizField, values: Float32Array): { f: VizField; values: Float32Array } {
  const [nx, ny, nz] = f.dims;
  const mx = Math.floor(nx / 2), my = Math.floor(ny / 2), mz = Math.floor(nz / 2);
  const out = new Float32Array(mx * my * mz);
  for (let k = 0; k < mz; k++)
    for (let j = 0; j < my; j++)
      for (let i = 0; i < mx; i++) {
        let s = 0;
        for (let d = 0; d < 8; d++) s += values[2 * i + (d & 1) + nx * (2 * j + ((d >> 1) & 1) + ny * (2 * k + (d >> 2)))];
        out[i + mx * (j + my * k)] = s / 8;
      }
  const g: VizField = {
    ...f,
    dims: [mx, my, mz],
    spacing: [f.spacing[0] * 2, f.spacing[1] * 2, f.spacing[2] * 2],
    origin: [f.origin[0] + 0.5 * f.spacing[0], f.origin[1] + 0.5 * f.spacing[1], f.origin[2] + 0.5 * f.spacing[2]],
  };
  return { f: g, values: out };
}

export function wakeGeometry(
  f: VizField,
  values: Float32Array,
  level: number,
  color: WakeColor,
  speedMax: number,
  cpRange: [number, number],
): THREE.BufferGeometry {
  // A wake surface needs less detail than the field: coarsen big fields (fewer, larger triangles).
  const net = f.dims[0] * f.dims[1] * f.dims[2] > 350_000 ? downsample(f, values) : { f, values };
  const { positions, index } = surfaceNets(net.f, net.values, level);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  const sampler = new FieldSampler(f);
  const s = new Float32Array(5);
  const rgb: [number, number, number] = [0, 0, 0];
  const colors = new Float32Array(positions.length);
  const q = 0.5 * f.freestream * f.freestream;
  for (let v = 0; v < positions.length / 3; v++) {
    const ok = sampler.sample(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2], s);
    if (!ok) {
      colors.set([0.4, 0.4, 0.4], 3 * v);
      continue;
    }
    if (color === "speed") sample("speed", Math.hypot(s[0], s[1], s[2]) / speedMax, rgb);
    else sample("diverging", divergingT(s[3] / q, cpRange[0], cpRange[1]), rgb);
    colors.set([toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])], 3 * v);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** Light unlit-style shader (the PBR material was too costly for large translucent folds). */
export function wakeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.5 } },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vColor = color;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vN), v = normalize(vView);
        float facing = abs(dot(n, v));
        float light = 0.55 + 0.45 * abs(dot(n, normalize(vec3(0.3, 0.4, 0.85))));
        // Fresnel: silhouettes of the volume more opaque than faces seen head-on.
        float fres = pow(1.0 - facing, 2.0);
        gl_FragColor = vec4(vColor * light + 0.12 * fres, clamp(uOpacity * (0.4 + 1.1 * fres), 0.0, 0.92));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
