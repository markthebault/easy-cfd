import { LEGACY_GRID, type Grid } from "./grid";

/** Imaginary part of the 2D velocity-gradient eigenvalues. Unlike vorticity,
 * swirling strength is zero in pure shear and identifies rotating cores.
 */
export function swirlingStrength(duDx: number, duDy: number, dvDx: number, dvDy: number) {
  const trace = duDx + dvDy, det = duDx * dvDy - duDy * dvDx;
  return .5 * Math.sqrt(Math.max(0, 4 * det - trace * trace));
}
export function vortexCores(field: Float32Array, solid: Float32Array, grid: Grid = LEGACY_GRID) {
  const {nx: NX, ny: NY} = grid, DOMAIN = grid;
  const n = NX * NY, result = new Float32Array(n), dx = 2 * DOMAIN.width / (NX - 1), dy = 2 * DOMAIN.height / (NY - 1);
  for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) {
    const i = y * NX + x;
    if (solid[i] || solid[i-1] || solid[i+1] || solid[i-NX] || solid[i+NX]) continue;
    result[i] = swirlingStrength((field[i+1]-field[i-1])/dx, (field[i+NX]-field[i-NX])/dy, (field[n+i+1]-field[n+i-1])/dx, (field[n+i+NX]-field[n+i-NX])/dy);
  }
  return result;
}
/** Marching-squares line segments; a saddle is kept as two separate segments. */
export function coreContours(values: Float32Array, threshold = 5, grid: Grid = LEGACY_GRID) {
  const {nx: NX, ny: NY} = grid, DOMAIN = grid;
  const segments: number[][] = [];
  const edge = (x: number, y: number, a: number, b: number, horizontal: boolean) => {
    const t = (threshold - a) / (b - a);
    return [(x + (horizontal ? t : 0)) / (NX - 1) * DOMAIN.width, (y + (horizontal ? 0 : t)) / (NY - 1) * DOMAIN.height];
  };
  for (let y = 1; y < NY - 2; y++) for (let x = 1; x < NX - 2; x++) {
    const i = y * NX + x, a = values[i], b = values[i+1], c = values[i+NX+1], d = values[i+NX], hits: number[][] = [];
    if ((a >= threshold) !== (b >= threshold)) hits.push(edge(x,y,a,b,true));
    if ((b >= threshold) !== (c >= threshold)) hits.push(edge(x+1,y,b,c,false));
    if ((d >= threshold) !== (c >= threshold)) hits.push(edge(x,y+1,d,c,true));
    if ((a >= threshold) !== (d >= threshold)) hits.push(edge(x,y,a,d,false));
    for (let j = 0; j + 1 < hits.length; j += 2) segments.push([...hits[j], ...hits[j+1]]);
  }
  return segments;
}
