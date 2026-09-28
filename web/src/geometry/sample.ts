// Built-in demonstration car, identical in dimensions to the OpenFOAM app's sample:
// a convex body of revolution-free profile extruded across the width, four cylindrical wheels
// with a 1 cm road gap, and an optional free-standing rear wing. Nose toward −X, metres.

import type { Vec3 } from "../solver/types";

type P2 = [number, number];

function hull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise in (x, z)
}

/** Extrude a convex (x, z) profile over y ∈ [y0, y1]; outward-facing triangles. */
export function extrude(profile: P2[], y0: number, y1: number): Float32Array {
  const h = hull(profile);
  const tris: number[] = [];
  const n = h.length;
  const v = (p: P2, y: number) => [p[0], y, p[1]];
  // Profile is CCW in (x, z); since x × z = −y, CCW order faces −y.
  for (let i = 1; i < n - 1; i++) {
    tris.push(...v(h[0], y1), ...v(h[i], y1), ...v(h[i + 1], y1));
    tris.push(...v(h[0], y0), ...v(h[i + 1], y0), ...v(h[i], y0));
  }
  for (let i = 0; i < n; i++) {
    const a = h[i], b = h[(i + 1) % n];
    tris.push(...v(a, y0), ...v(b, y0), ...v(b, y1));
    tris.push(...v(a, y0), ...v(b, y1), ...v(a, y1));
  }
  return fixWinding(new Float32Array(tris));
}

/** Cylinder with its axis along Y. */
export function cylinderY(center: Vec3, radius: number, width: number, sections = 32): Float32Array {
  const [cx, cy, cz] = center;
  const y0 = cy - width / 2, y1 = cy + width / 2;
  const tris: number[] = [];
  for (let i = 0; i < sections; i++) {
    const a0 = (2 * Math.PI * i) / sections, a1 = (2 * Math.PI * (i + 1)) / sections;
    const x0 = cx + radius * Math.cos(a0), z0 = cz + radius * Math.sin(a0);
    const x1 = cx + radius * Math.cos(a1), z1 = cz + radius * Math.sin(a1);
    tris.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
    tris.push(cx, y0, cz, x1, y0, z1, x0, y0, z0);
    tris.push(cx, y1, cz, x0, y1, z0, x1, y1, z1);
  }
  return fixWinding(new Float32Array(tris));
}

/** Flip every triangle if the signed volume is negative (closed meshes only). */
function fixWinding(t: Float32Array): Float32Array {
  let vol = 0;
  for (let o = 0; o < t.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(o, o + 9);
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0)
    for (let o = 0; o < t.length; o += 9)
      for (let c = 0; c < 3; c++) {
        const tmp = t[o + 3 + c];
        t[o + 3 + c] = t[o + 6 + c];
        t[o + 6 + c] = tmp;
      }
  return t;
}

export interface SamplePart {
  name: string;
  role: "body" | "wheel";
  positions: Float32Array;
  wheel?: { center: Vec3; radius: number };
}

export function sampleCar(wing = false): SamplePart[] {
  const body: P2[] = [
    [-2.1, 0.32], [-2.1, 0.6], [-1.65, 0.83], [-0.7, 0.91], [-0.28, 1.32],
    [0.85, 1.32], [1.65, 0.86], [2.1, 0.72], [2.1, 0.32],
  ];
  const parts: SamplePart[] = [{ name: "Body", role: "body", positions: extrude(body, -0.81, 0.81) }];
  const wheels: [string, number, number][] = [
    ["Front left wheel", -1.35, 1.05],
    ["Front right wheel", -1.35, -1.05],
    ["Rear left wheel", 1.3, 1.05],
    ["Rear right wheel", 1.3, -1.05],
  ];
  for (const [name, x, y] of wheels) {
    const center: Vec3 = [x, y, 0.33];
    parts.push({ name, role: "wheel", positions: cylinderY(center, 0.32, 0.24), wheel: { center, radius: 0.32 } });
  }
  if (wing) {
    const profile: P2[] = [[1.48, 1.48], [1.49, 1.52], [1.88, 1.59], [1.9, 1.57]];
    parts.push({ name: "Rear wing", role: "body", positions: extrude(profile, -0.975, 0.975) });
  }
  return parts;
}
