import type { Vec3 } from "../solver/types";

/** Uniform-density volume centroid. Open or inconsistently wound meshes retain their axle center. */
export function wheelCenterOfMass(positions: Float32Array, fallback: Vec3): Vec3 {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let j = 0; j < 3; j++) {
    low[j] = Math.min(low[j], positions[i + j]);
    high[j] = Math.max(high[j], positions[i + j]);
  }
  const span = Math.max(...high.map((v, i) => v - low[i]));
  if (!Number.isFinite(span) || span <= 0) return [...fallback];
  // Local coordinates keep the integrals stable when the wheel is far from the model origin.
  const origin = low.map((v, i) => (v + high[i]) / 2);
  const tolerance = span * 1e-6;
  const vertices = new Map<string, number>();
  const edges = new Map<string, { count: number; direction: number }>();
  const vertexId = (o: number) => {
    const key = [0, 1, 2].map(j => Math.round((positions[o + j] - origin[j]) / tolerance)).join(",");
    let id = vertices.get(key);
    if (id === undefined) vertices.set(key, id = vertices.size);
    return id;
  };
  let volume = 0;
  const moment = [0, 0, 0];
  for (let o = 0; o + 8 < positions.length; o += 9) {
    const a = [0, 1, 2].map(j => positions[o + j] - origin[j]);
    const b = [0, 1, 2].map(j => positions[o + 3 + j] - origin[j]);
    const c = [0, 1, 2].map(j => positions[o + 6 + j] - origin[j]);
    const ids = [vertexId(o), vertexId(o + 3), vertexId(o + 6)];
    if (new Set(ids).size < 3) continue;
    for (let j = 0; j < 3; j++) {
      const u = ids[j], v = ids[(j + 1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const edge = edges.get(key) ?? { count: 0, direction: 0 };
      edge.count++;
      edge.direction += u < v ? 1 : -1;
      edges.set(key, edge);
    }
    const sixVolume = a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    volume += sixVolume;
    for (let j = 0; j < 3; j++) moment[j] += sixVolume * (a[j] + b[j] + c[j]) / 4;
  }
  if (!edges.size || [...edges.values()].some(e => e.count !== 2 || e.direction !== 0)
    || Math.abs(volume) < span ** 3 * 1e-9) return [...fallback];
  const center = moment.map((v, j) => origin[j] + v / volume) as Vec3;
  return center.every((v, j) => Number.isFinite(v) && v >= low[j] && v <= high[j]) ? center : [...fallback];
}
