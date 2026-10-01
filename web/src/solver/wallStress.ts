import { locate } from "./grid";
import type { FlowFields } from "./gpu";
import type { CaseSetup } from "./setup";
import type { SurfaceSample } from "./extract";

/** Status: 0 unsupported, 1 valid (including zero), 2 no matching wall, 3 invalid. */
export function sampleWallStress(
  c: CaseSetup,
  f: FlowFields,
  positions: Float32Array,
  partId: string,
  density: number,
): Pick<SurfaceSample, "wallStress" | "stressValid" | "snapshot"> {
  const n = positions.length / 3,
    values = new Float32Array(n * 3),
    valid = new Uint8Array(n);
  if (!f.wallForces) return { wallStress: values, stressValid: valid };
  valid.fill(2);
  values.fill(NaN);
  const part = c.partIds.indexOf(partId),
    map = new Map<number, number>();
  for (let q = 0; q < c.faceCount; q++)
    if ((c.faces[2 * q + 1] & 255) === part) map.set(c.faces[2 * q], q);
  const { x, y, z } = c.grid;
  for (let t = 0; t < n; t += 3) {
    const o = t * 3;
    const a = [0, 1, 2].map((i) => positions[o + 3 + i] - positions[o + i]),
      b = [0, 1, 2].map((i) => positions[o + 6 + i] - positions[o + i]);
    const normal = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const norm = Math.hypot(...normal);
    if (!(norm > 0)) {
      valid.fill(3, t, t + 3);
      continue;
    }
    for (let i = 0; i < 3; i++) normal[i] /= norm;
    for (let v = t; v < t + 3; v++) {
      const point = [
        positions[3 * v],
        positions[3 * v + 1],
        positions[3 * v + 2],
      ];
      const i = locate(x, point[0]) + 1,
        j = locate(y, point[1]) + 1,
        k = locate(z, point[2]) + 1;
      let best = Infinity,
        chosen = -1,
        area = 0;
      for (let dk = -2; dk <= 2; dk++)
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++) {
            const ci = i + di,
              cj = j + dj,
              ck = k + dk;
            if (
              ci < 1 ||
              cj < 1 ||
              ck < 1 ||
              ci >= c.NX - 1 ||
              cj >= c.NY - 1 ||
              ck >= c.NZ - 1
            )
              continue;
            const cell = ci + c.NX * (cj + c.NY * ck),
              q = map.get(cell);
            if (q === undefined || c.faces[2 * q + 1] & (1 << 17)) continue;
            const w = c.wall.subarray(cell * 4, cell * 4 + 4),
              ar = Math.hypot(w[0], w[1], w[2]);
            // A fluid-to-solid wall normal must oppose this triangle's outward normal.
            if (
              ar <= 0 ||
              (w[0] * normal[0] + w[1] * normal[1] + w[2] * normal[2]) / ar >
                -0.25
            )
              continue;
            const wp = [
              x.centers[ci - 1] + (w[0] / ar) * w[3],
              y.centers[cj - 1] + (w[1] / ar) * w[3],
              z.centers[ck - 1] + (w[2] / ar) * w[3],
            ];
            const d = Math.hypot(...wp.map((p, a) => p - point[a]));
            const h = Math.max(
              x.widths[ci - 1],
              y.widths[cj - 1],
              z.widths[ck - 1],
            );
            if (d < best && d < 2 * h) {
              best = d;
              chosen = q;
              area = ar;
            }
          }
      if (chosen >= 0) {
        const stress = [0, 1, 2].map(
          (a) => (density * f.wallForces![chosen * 12 + 3 + a]) / area,
        );
        valid[v] = stress.every(Number.isFinite) ? 1 : 3;
        values.set(stress, v * 3);
      }
    }
  }
  return {
    wallStress: values,
    stressValid: valid,
    snapshot: {
      iteration: f.step ?? 0,
      grid: `${c.grid.x.n}x${c.grid.y.n}x${c.grid.z.n}`,
      unit: "Pa",
      dynamicPressure: 0.5 * density * c.freestream ** 2,
    },
  };
}

/** Independent CPU integration of native wall traction and application positions. */
export function integrateWalls(
  c: CaseSetup,
  face: Float32Array,
  density: number,
) {
  const force = [0, 0, 0],
    moment = [0, 0, 0],
    friction = [0, 0, 0];
  let validFaces = 0,
    forceMagnitude = 0,
    momentMagnitude = 0,
    frictionMagnitude = 0;
  for (let q = 0; q < c.faceCount; q++) {
    const cell = c.faces[q * 2],
      contact = !!(c.faces[q * 2 + 1] & (1 << 17));
    const i = cell % c.NX,
      j = Math.floor(cell / c.NX) % c.NY,
      k = Math.floor(cell / (c.NX * c.NY));
    const w = c.wall.subarray(cell * 4, cell * 4 + 4),
      area = Math.hypot(w[0], w[1], w[2]);
    if (
      !(area > 0) ||
      face.subarray(q * 12, q * 12 + 6).some((v) => !Number.isFinite(v))
    )
      continue;
    validFaces++;
    const pos = [
      c.grid.x.centers[i - 1],
      c.grid.y.centers[j - 1],
      contact ? 0 : c.grid.z.centers[k - 1],
    ];
    if (!contact) for (let a = 0; a < 3; a++) pos[a] += (w[a] / area) * w[3];
    const f = [0, 1, 2].map(
      (a) => density * (face[q * 12 + a] + face[q * 12 + 3 + a]),
    );
    const arm = pos.map((v, a) => v - c.momentOrigin[a]);
    const m = [
      arm[1] * f[2] - arm[2] * f[1],
      arm[2] * f[0] - arm[0] * f[2],
      arm[0] * f[1] - arm[1] * f[0],
    ];
    forceMagnitude += Math.hypot(...f);
    momentMagnitude += Math.hypot(...m);
    frictionMagnitude +=
      density * Math.hypot(...face.subarray(q * 12 + 3, q * 12 + 6));
    for (let a = 0; a < 3; a++) {
      force[a] += f[a];
      moment[a] += m[a];
      const tau = (density * face[q * 12 + 3 + a]) / area;
      friction[a] += tau * area;
    }
  }
  return {
    force,
    moment,
    friction,
    forceMagnitude,
    momentMagnitude,
    frictionMagnitude,
    validFaces,
    faces: c.faceCount,
    coverage: validFaces / Math.max(c.faceCount, 1),
  };
}
