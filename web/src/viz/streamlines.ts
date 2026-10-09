// Streamlines from a seed rake: RK4 through the resampled solver field (CPU), drawn as lit tubes
// coloured by speed. The optional "flow" effect moves bright pulses along each tube at the local
// air speed, using each point's time of flight from the seed.

import * as THREE from "three";
import type { VizField } from "../solver/extract";
import { FieldSampler } from "./field";
import { mapTexture } from "./colormap";

export interface Rake {
  center: THREE.Vector3;
  length: number;
  count: number;
  orientation: "vertical" | "horizontal";
}

interface Line {
  pts: number[];
  speed: number[];
  tof: number[];
  closed?: boolean;
}

export interface StreamSeed {
  position: [number, number, number];
  both?: boolean;
  maxLength?: number;
  xRange?: [number, number];
}

function rakeSeeds(rake: Rake): StreamSeed[] {
  return Array.from({ length: rake.count }, (_, n) => {
    const t = rake.count === 1 ? 0 : n / (rake.count - 1) - 0.5;
    const p = rake.center.clone();
    if (rake.orientation === "vertical") p.z += t * rake.length;
    else p.y += t * rake.length;
    return { position: p.toArray() as [number, number, number] };
  });
}

/** Three upstream rakes plus local seeds that can reach separated wake regions. */
export function overviewSeeds(f: VizField, rake: Rake, bounds: { low: number[]; high: number[] }, wake = true): StreamSeed[] {
  const { low, high } = bounds;
  const L = high[0] - low[0], W = high[1] - low[1], H = high[2] - low[2];
  const seeds: StreamSeed[] = [];
  for (const offset of [-0.45, 0, 0.45]) {
    const center = rake.center.clone();
    center.y += offset * W;
    const count = offset === 0 ? rake.count : Math.max(4, Math.round(rake.count / 4));
    seeds.push(...rakeSeeds({ ...rake, center, count }).map(s => ({ ...s, maxLength: 3 * L })));
  }
  if (wake) {
    for (const x of [0.05, 0.25, 0.55]) for (const y of [-0.45, 0, 0.45]) for (const z of [0.15, 0.45, 0.85]) {
      seeds.push({ position: [high[0] + x * L, rake.center.y + y * W, low[2] + z * H], both: true, maxLength: L * 0.8 });
    }
  }
  // Do not clamp out-of-domain seeds onto the boundary: that duplicates paths.
  return seeds.filter(s => s.position.every((v, a) => v >= f.origin[a] && v <= f.origin[a] + f.spacing[a] * (f.dims[a] - 1)))
    .map(s => ({ ...s, xRange: [Math.min(rake.center.x, low[0] - L * 0.22), high[0] + L * 0.75] }));
}

export function traceOverview(f: VizField, rake: Rake, bounds: { low: number[]; high: number[] }, wake = true): Line[] {
  return traceSeeds(f, overviewSeeds(f, rake, bounds, wake));
}

export function traceStreamlines(f: VizField, rake: Rake): Line[] {
  return traceSeeds(f, rakeSeeds(rake));
}

export function traceSeeds(f: VizField, seeds: StreamSeed[]): Line[] {
  const sampler = new FieldSampler(f);
  const h = Math.min(...f.spacing) * 0.6;
  const U = f.freestream;
  const s = new Float32Array(5);
  const vel = (x: number, y: number, z: number): [number, number, number] | null =>
    sampler.sample(x, y, z, s) && s.subarray(0, 3).every(Number.isFinite) ? [s[0], s[1], s[2]] : null;
  const trace = (seed: StreamSeed, direction: number): Line => {
    const maxSteps = Math.ceil((seed.maxLength ?? 4 * f.length) / h);
    let [x, y, z] = seed.position;
    let tof = 0;
    const line: Line = { pts: [], speed: [], tof: [] };
    for (let i = 0; i < maxSteps; i++) {
      if (seed.xRange && (x < seed.xRange[0] || x > seed.xRange[1])) break;
      const k1 = vel(x, y, z);
      if (!k1) break;
      const sp = Math.hypot(...k1);
      line.pts.push(x, y, z);
      line.speed.push(sp);
      line.tof.push(tof);
      if (sp < 0.01 * U) break;
      // Integrate in arc length (unit direction) so the spacing stays even in slow regions.
      const dir = (v: [number, number, number]) => {
        const l = Math.hypot(...v) || 1;
        return [direction * v[0] / l, direction * v[1] / l, direction * v[2] / l];
      };
      const d1 = dir(k1);
      const k2 = vel(x + 0.5 * h * d1[0], y + 0.5 * h * d1[1], z + 0.5 * h * d1[2]);
      if (!k2) break;
      const d2 = dir(k2);
      const k3 = vel(x + 0.5 * h * d2[0], y + 0.5 * h * d2[1], z + 0.5 * h * d2[2]);
      if (!k3) break;
      const d3 = dir(k3);
      const k4 = vel(x + h * d3[0], y + h * d3[1], z + h * d3[2]);
      if (!k4) break;
      const d4 = dir(k4);
      x += (h / 6) * (d1[0] + 2 * d2[0] + 2 * d3[0] + d4[0]);
      y += (h / 6) * (d1[1] + 2 * d2[1] + 2 * d3[1] + d4[1]);
      z += (h / 6) * (d1[2] + 2 * d2[2] + 2 * d3[2] + d4[2]);
      tof += direction * h / Math.max(sp, 1e-3);
      // Stop after one closed orbit instead of painting the same vortex repeatedly.
      if (i > 20 && Math.hypot(x - seed.position[0], y - seed.position[1], z - seed.position[2]) < h * 0.75) {
        line.pts.push(...seed.position);
        line.speed.push(line.speed[0]);
        line.tof.push(tof);
        line.closed = true;
        break;
      }
    }
    return line;
  };
  const lines: Line[] = [];
  for (const seed of seeds) {
    const line = trace(seed, 1);
    if (seed.both && !line.closed) {
      const back = trace(seed, -1);
      const pts: number[] = [];
      for (let i = back.speed.length - 1; i > 0; i--) pts.push(...back.pts.slice(i * 3, i * 3 + 3));
      line.pts = pts.concat(line.pts);
      line.speed = back.speed.slice(1).reverse().concat(line.speed);
      line.tof = back.tof.slice(1).reverse().concat(line.tof);
    }
    if (line.pts.length >= 6) lines.push(line);
  }
  return lines;
}

/** One merged tube mesh; parallel-transport frames avoid twisting. */
export function tubeGeometry(lines: Line[], radius: number, sides = 7): THREE.BufferGeometry {
  let verts = 0, tris = 0;
  for (const l of lines) {
    const n = l.pts.length / 3;
    verts += n * sides;
    tris += (n - 1) * sides * 2;
  }
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  const speed = new Float32Array(verts), tof = new Float32Array(verts);
  const index = verts > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  let v = 0, t = 0;
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), prevT = new THREE.Vector3();
  const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
  for (const l of lines) {
    const n = l.pts.length / 3;
    const start = v;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      T.set(l.pts[3 * b] - l.pts[3 * a], l.pts[3 * b + 1] - l.pts[3 * a + 1], l.pts[3 * b + 2] - l.pts[3 * a + 2]).normalize();
      if (i === 0) {
        N.set(0, 0, 1);
        if (Math.abs(T.dot(N)) > 0.9) N.set(0, 1, 0);
        N.sub(tmp.copy(T).multiplyScalar(T.dot(N))).normalize();
      } else {
        q.setFromUnitVectors(prevT, T);
        N.applyQuaternion(q).normalize();
      }
      prevT.copy(T);
      B.crossVectors(T, N);
      // Tubes thin out toward the end so they don't stop abruptly.
      const r = radius * Math.min(1, (n - 1 - i) / 12 + 0.25);
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        const cx = Math.cos(ang), sx = Math.sin(ang);
        const nx = N.x * cx + B.x * sx, ny = N.y * cx + B.y * sx, nz = N.z * cx + B.z * sx;
        pos.set([l.pts[3 * i] + r * nx, l.pts[3 * i + 1] + r * ny, l.pts[3 * i + 2] + r * nz], v * 3);
        nrm.set([nx, ny, nz], v * 3);
        speed[v] = l.speed[i];
        tof[v] = l.tof[i];
        v++;
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let k = 0; k < sides; k++) {
        const a = start + i * sides + k, b = start + i * sides + ((k + 1) % sides);
        const c = a + sides, d = b + sides;
        index.set([a, c, b, b, c, d], t);
        t += 6;
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  g.setAttribute("aTof", new THREE.BufferAttribute(tof, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

export function streamlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: mapTexture("speed") },
      uSpeedMax: { value: 1 },
      uTime: { value: 0 },
      uPulse: { value: 0.1 },
      uAnimate: { value: 1 },
      uShading: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSpeed;
      attribute float aTof;
      varying float vSpeed;
      varying float vTof;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vSpeed = aSpeed;
        vTof = aTof;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uSpeedMax;
      uniform float uTime;
      uniform float uPulse;
      uniform float uAnimate;
      uniform float uShading;
      varying float vSpeed;
      varying float vTof;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vec3 base = texture2D(uMap, vec2(clamp(vSpeed / uSpeedMax, 0.0, 1.0), 0.5)).rgb;
        vec3 n = normalize(vN), v = normalize(vView);
        vec3 l = normalize(vec3(0.3, 0.5, 0.8));
        float diff = 0.45 + 0.55 * max(dot(n, l), 0.0);
        float spec = pow(max(dot(reflect(-l, n), v), 0.0), 24.0) * 0.35;
        float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.25;
        float phase = fract(vTof / uPulse - uTime);
        float pulse = mix(1.0, 0.55 + 1.1 * smoothstep(0.75, 0.97, phase) * (1.0 - smoothstep(0.97, 1.0, phase)), uAnimate);
        gl_FragColor = vec4(mix(base * pulse, base * diff * pulse + spec + rim, uShading), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
