/** Stationary halfway bounce-back momentum exchange. Force on the solid is
 * -2 f_opposite c_i for each incoming fluid link whose source is solid.
 * https://doi.org/10.3390/e17127876
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */
import { CX, CY, OPPOSITE } from "./lattice";
export function forceLinks(nx: number, ny: number, mask: Float32Array) {
  const indices: number[] = [], x: number[] = [], y: number[] = [], n = nx * ny;
  for (let iy = 1; iy < ny - 1; iy++) for (let ix = 1; ix < nx; ix++) {
    const cell = iy * nx + ix; if (mask[cell]) continue;
    for (let i = 1; i < 9; i++) {
      const sx = Math.max(0, Math.min(nx - 2, ix - CX[i])), sy = Math.max(0, Math.min(ny - 1, iy - CY[i]));
      if (mask[sy * nx + sx]) { indices.push(OPPOSITE[i] * n + cell); x.push(-2 * CX[i]); y.push(-2 * CY[i]); }
    }
  }
  // A neutral dummy avoids zero-sized reductions on portable backends.
  if (!indices.length) { indices.push(0); x.push(0); y.push(0); }
  return { indices: new Int32Array(indices), x: new Float32Array(x), y: new Float32Array(y) };
}
