// Surface "oil flow": short streaks laid on the car along the near-wall air direction sampled by
// the solver (SurfaceSample.shear). Streaks are spread by triangle area and animated with a moving
// highlight so the direction reads. Surface points without solver data get no streak.

import * as THREE from "three";

export interface OilPart {
  positions: Float32Array;
  shear: Float32Array;
}

/** Deterministic pseudo-random numbers so the pattern is stable between rebuilds. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function oilFlowGeometry(parts: OilPart[], length: number, freestream: number, target = 16000): THREE.InstancedBufferGeometry | null {
  // Area of every usable triangle (all three corners have data and some tangential flow).
  const areas: number[] = [];
  const refs: [number, number][] = [];
  let total = 0;
  parts.forEach((p, pi) => {
    const a = p.positions, s = p.shear;
    for (let t = 0; t < a.length / 9; t++) {
      let ok = true;
      for (let v = 0; v < 3 && ok; v++) {
        const o = (t * 3 + v) * 3;
        if (!Number.isFinite(s[o]) || Math.hypot(s[o], s[o + 1], s[o + 2]) < 0.02 * freestream) ok = false;
      }
      if (!ok) continue;
      const o = t * 9;
      const ux = a[o + 3] - a[o], uy = a[o + 4] - a[o + 1], uz = a[o + 5] - a[o + 2];
      const vx = a[o + 6] - a[o], vy = a[o + 7] - a[o + 1], vz = a[o + 8] - a[o + 2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area <= 0) continue;
      total += area;
      areas.push(total);
      refs.push([pi, t]);
    }
  });
  if (!refs.length) return null;
  const n = target;
  const pos = new Float32Array(n * 3), dir = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const len = new Float32Array(n), phase = new Float32Array(n);
  const rand = rng(7);
  let count = 0;
  for (let k = 0; k < n; k++) {
    // Pick a triangle with probability ∝ area (binary search in the cumulative areas).
    const x = rand() * total;
    let lo = 0, hi = areas.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (areas[m] < x) lo = m + 1;
      else hi = m;
    }
    const [pi, t] = refs[lo];
    const a = parts[pi].positions, s = parts[pi].shear;
    let r1 = rand(), r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const w = [1 - r1 - r2, r1, r2];
    const o = t * 9;
    const ux = a[o + 3] - a[o], uy = a[o + 4] - a[o + 1], uz = a[o + 5] - a[o + 2];
    const vx = a[o + 6] - a[o], vy = a[o + 7] - a[o + 1], vz = a[o + 8] - a[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let px = 0, py = 0, pz = 0, dx = 0, dy = 0, dz = 0;
    for (let v = 0; v < 3; v++) {
      px += w[v] * a[o + 3 * v];
      py += w[v] * a[o + 3 * v + 1];
      pz += w[v] * a[o + 3 * v + 2];
      const so = (t * 3 + v) * 3;
      dx += w[v] * s[so];
      dy += w[v] * s[so + 1];
      dz += w[v] * s[so + 2];
    }
    // Keep the direction in the triangle plane.
    const dn = dx * nx + dy * ny + dz * nz;
    dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
    const m = Math.hypot(dx, dy, dz);
    if (m < 1e-6) continue;
    pos.set([px, py, pz], count * 3);
    dir.set([dx / m, dy / m, dz / m], count * 3);
    nrm.set([nx, ny, nz], count * 3);
    len[count] = length * (0.016 + 0.03 * Math.min(1, m / freestream));
    phase[count] = rand();
    count++;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.setAttribute("iPos", new THREE.InstancedBufferAttribute(pos.subarray(0, count * 3), 3));
  g.setAttribute("iDir", new THREE.InstancedBufferAttribute(dir.subarray(0, count * 3), 3));
  g.setAttribute("iNrm", new THREE.InstancedBufferAttribute(nrm.subarray(0, count * 3), 3));
  g.setAttribute("iLen", new THREE.InstancedBufferAttribute(len.subarray(0, count), 1));
  g.setAttribute("iPhase", new THREE.InstancedBufferAttribute(phase.subarray(0, count), 1));
  g.instanceCount = count;
  return g;
}

export function oilFlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWidth: { value: 0.004 },
      uLift: { value: 0.004 },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: 0.75 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec3 iDir;
      attribute vec3 iNrm;
      attribute float iLen;
      attribute float iPhase;
      uniform float uWidth;
      uniform float uLift;
      varying float vAlong;
      varying float vPhase;
      varying float vSide;
      void main() {
        vec3 side = normalize(cross(iNrm, iDir));
        vec3 p = iPos + iNrm * uLift + iDir * (position.x - 0.5) * iLen + side * position.y * uWidth;
        vAlong = position.x;
        vSide = position.y;
        vPhase = iPhase;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlong;
      varying float vPhase;
      varying float vSide;
      void main() {
        // Comet shape: thin tail, bright head in the flow direction; the head brightness cycles.
        float body = smoothstep(0.0, 0.85, vAlong) * (1.0 - smoothstep(0.9, 1.0, vAlong));
        float edge = 1.0 - vSide * vSide;
        float cycle = 0.55 + 0.45 * sin(6.2832 * (vPhase + uTime));
        gl_FragColor = vec4(uColor, uOpacity * body * edge * cycle);
        if (gl_FragColor.a < 0.01) discard;
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
