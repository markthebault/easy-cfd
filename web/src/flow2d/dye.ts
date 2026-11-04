import { LEGACY_GRID, type Grid } from "./grid";

export function bilinear(values: Float32Array, x: number, y: number, offset = 0, NX = 672, NY = 192) {
  x = Math.max(0, Math.min(NX - 1.001, x)); y = Math.max(0, Math.min(NY - 1.001, y));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, i = offset + iy * NX + ix;
  return (values[i] * (1 - fx) + values[i + 1] * fx) * (1 - fy) + (values[i + NX] * (1 - fx) + values[i + NX + 1] * fx) * fy;
}

/** Passive dye only: midpoint backtracing and bounded MacCormack correction.
 * The velocity comes exclusively from the solver; dye never alters the flow.
 */
export class FlowDye {
  values: Float32Array;
  private forward: Float32Array;
  private next: Float32Array;
  private departureX: Float32Array;
  private departureY: Float32Array;
  time = 0;
  constructor(private grid: Grid = LEGACY_GRID) { const n = grid.nx * grid.ny; this.values = new Float32Array(n); this.forward = new Float32Array(n); this.next = new Float32Array(n); this.departureX = new Float32Array(n); this.departureY = new Float32Array(n); }
  reset() { const { nx: NX, ny: NY } = this.grid; this.values.fill(0); this.forward.fill(0); this.next.fill(0); this.time = 0; for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) { const d = y - (3 + Math.round((y - 3) / 7) * 7); this.values[y * NX + x] = Math.exp(-d * d / 1.3) * (.6 + .3 * Math.sin(x * .1) ** 2); } }
  step(field: Float32Array, solid: Float32Array, seconds: number) {
    if (seconds <= 0) return;
    const {nx: NX, ny: NY} = this.grid, DOMAIN = this.grid;
    const sample = (values: Float32Array, x: number, y: number, offset = 0) => bilinear(values, x, y, offset, NX, NY);
    this.time += seconds;
    const n = NX * NY, sx = seconds * .6 * (NX - 1) / DOMAIN.width, sy = seconds * .6 * (NY - 1) / DOMAIN.height;
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = y * NX + x;
      if (solid[i]) { this.forward[i] = 0; continue; }
      const mx = x - field[i] * sx / 2, my = y - field[n + i] * sy / 2;
      const dx = x - sample(field, mx, my) * sx, dy = y - sample(field, mx, my, n) * sy;
      this.departureX[i] = dx; this.departureY[i] = dy;
      this.forward[i] = dx < 0 || dy < 0 || dy > NY - 1 || sample(solid, dx, dy) > .1 ? 0 : sample(this.values, dx, dy);
    }
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = y * NX + x;
      if (solid[i]) { this.next[i] = 0; continue; }
      const dx = this.departureX[i], dy = this.departureY[i];
      const px = Math.max(0, Math.min(NX - 2, Math.floor(dx))), py = Math.max(0, Math.min(NY - 2, Math.floor(dy))), j = py * NX + px;
      const a = this.values[j], b = this.values[j + 1], c = this.values[j + NX], d = this.values[j + NX + 1];
      const reverse = sample(this.forward, x + field[i] * sx, y + field[n + i] * sy);
      const corrected = this.forward[i] + .5 * (this.values[i] - reverse);
      let density = Math.max(Math.min(a, b, c, d), Math.min(Math.max(a, b, c, d), corrected));
      if (x < 4) {
        // A rake of thin, pulsing inlet streaks makes travel and deformation visible.
        const lane = Math.round((y - 3) / 7), distance = y - (3 + lane * 7);
        density = Math.exp(-distance * distance / 1.3) * (.65 + .35 * Math.sin(this.time * 5 - lane * .7) ** 2);
      }
      this.next[i] = density * Math.exp(-seconds * .035);
    }
    [this.values, this.next] = [this.next, this.values];
  }
}
