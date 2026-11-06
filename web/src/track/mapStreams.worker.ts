import * as T from 'three';
import type { VizField } from '../solver/extract';
import { traceOverview, tubeGeometry } from '../viz/streamlines';

let fields: VizField[] = [], bounds: { low: number[]; high: number[] };
self.onmessage = ({ data }) => {
  if (data.type === 'init') { fields = data.fields; bounds = data.bounds; return; }
  const { indices, weights, key } = data;
  const base = fields[indices[0]], n = base.u.length;
  const f: VizField = { ...base, u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n), solid: new Uint8Array(n) };
  let U = 0;
  for (let j = 0; j < 4; j++) {
    const w = weights[j], s = fields[indices[j]];
    if (w < 1e-8) continue;
    U += w * s.freestream;
    for (let i = 0; i < n; i++) { f.u[i] += w * s.u[i]; f.v[i] += w * s.v[i]; f.w[i] += w * s.w[i]; if (s.solid[i]) f.solid[i] = 1; }
  }
  f.freestream = U;
  const { low, high } = bounds, L = f.length;
  const lines = traceOverview(f, { center: new T.Vector3(low[0] - L * .22, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2), length: (high[2] - low[2]) * 1.35, count: 48, orientation: 'vertical' }, bounds);
  const geometry = tubeGeometry(lines, L * .0015);
  const arrays: Record<string, { array: Float32Array; size: number }> = {};
  for (const name of ['position', 'normal', 'aSpeed', 'aTof']) { const a = geometry.getAttribute(name); arrays[name] = { array: a.array as Float32Array, size: a.itemSize }; }
  const index = geometry.index!.array;
  self.postMessage({ key, arrays, index }, { transfer: [...Object.values(arrays).map(a => a.array.buffer), index.buffer] });
};
