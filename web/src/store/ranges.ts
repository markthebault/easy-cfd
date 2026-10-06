// Colour ranges from a result's own data (robust percentiles), fixed for that result and merged
// when two results are compared so equal colours mean equal values.

import type { SurfaceSample, VizField } from "../solver/extract";
import type { Ranges } from "./types";

function percentile(values: Float32Array, count: number, q: number): number {
  if (count === 0) return 0;
  const s = values.slice(0, count).sort();
  return s[Math.min(count - 1, Math.max(0, Math.round(q * (count - 1))))];
}

/** Subsample fluid values (every n-th) to keep sorting cheap on large fields. */
function collect(n: number, pick: (i: number) => number | null, max = 200_000): { buf: Float32Array; count: number } {
  const stride = Math.max(1, Math.floor(n / max));
  const buf = new Float32Array(Math.ceil(n / stride));
  let count = 0;
  for (let i = 0; i < n; i += stride) {
    const v = pick(i);
    if (v !== null && Number.isFinite(v)) buf[count++] = v;
  }
  return { buf, count };
}

export function computeRanges(field: VizField | null, surface: (SurfaceSample | null)[] | null, freestream: number, density: number): Ranges {
  const q = 0.5 * density * freestream * freestream;
  const r: Ranges = {
    speed: [0, 1.4 * freestream],
    pressure: [-1.5 * q, 1 * q],
    cp: [-1.5, 1],
    k: [0, 0.05 * freestream * freestream],
    cp0: [-0.2, 1],
    friction: [0, Math.max(.001, .01*q)], cf: [0,.01],
    q,
    density,
  };
  if (field) {
    const n = field.u.length;
    const fluid = (i: number) => !field.solid[i];
    const sp = collect(n, (i) => (fluid(i) ? Math.hypot(field.u[i], field.v[i], field.w[i]) : null));
    // Free stream sits at about 70 % of the scale so both slowing and speeding air stay visible.
    r.speed = [0, Math.max(1.4 * freestream, percentile(sp.buf, sp.count, 0.998))];
    const pr = collect(n, (i) => (fluid(i) ? field.p[i] * density : null));
    r.pressure = [percentile(pr.buf, pr.count, 0.003), percentile(pr.buf, pr.count, 0.997)];
    if (!(r.pressure[1] > r.pressure[0])) r.pressure = [-q, q];
    const kk = collect(n, (i) => (fluid(i) ? field.k[i] : null));
    r.k = [0, Math.max(1e-6, percentile(kk.buf, kk.count, 0.995))];
  }
  if (surface) {
    const all: number[] = [];
    for (const s of surface) if (s) for (let i = 0; i < s.cp.length; i += Math.max(1, Math.floor(s.cp.length / 20000))) if (Number.isFinite(s.cp[i])) all.push(s.cp[i]);
    if (all.length > 10) {
      const a = Float32Array.from(all);
      const lo = percentile(a, a.length, 0.01), hi = percentile(a, a.length, 0.995);
      // Keep zero centred on the neutral grey: symmetric-ish limits, stagnation capped at 1.
      r.cp = [Math.max(-3, Math.min(-0.3, lo)), Math.min(1, Math.max(0.3, hi))];
    }
  }
  const stress: number[] = [], cf: number[] = [];
  for (const s of surface ?? []) if (s?.wallStress && s.stressValid) for(let i=0;i<s.stressValid.length;i+=Math.max(1,Math.floor(s.stressValid.length/20000))) if(s.stressValid[i]===1) {
    const tau=Math.hypot(...s.wallStress.subarray(3*i,3*i+3));
    if(Number.isFinite(tau)) { stress.push(tau); cf.push(tau/(s.snapshot?.dynamicPressure ?? q)); }
  }
  if(stress.length) { r.friction=[0,Math.max(.001,percentile(Float32Array.from(stress),stress.length,.99))]; r.cf=[0,Math.max(.00001,percentile(Float32Array.from(cf),cf.length,.99))]; }
  return r;
}

export function mergeRanges(a: Ranges, b: Ranges): Ranges {
  const m = (x: [number, number], y: [number, number]): [number, number] => [Math.min(x[0], y[0]), Math.max(x[1], y[1])];
  return { friction: m(a.friction ?? [0,1],b.friction ?? [0,1]), cf: m(a.cf ?? [0,.01],b.cf ?? [0,.01]), speed: m(a.speed, b.speed), pressure: m(a.pressure, b.pressure), cp: m(a.cp, b.cp), k: m(a.k, b.k), cp0: m(a.cp0, b.cp0), q: Math.max(a.q, b.q), density: a.density };
}

/** One fixed colour scale over the whole sequence; frame-to-frame autoscaling hides changes. */
export function animationRanges(a: import("../solver/animation").FlowAnimation, density: number): Ranges {
  return a.frames.map(f => computeRanges(f.field, null, f.field.freestream, density)).reduce(mergeRanges);
}
