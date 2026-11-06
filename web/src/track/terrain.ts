import * as T from 'three';
import type { TrackPath } from './trackPath';

export interface TerrainInput {
  origin: number[];
  baseline: number;
  grid: { bounds: number[]; columns: number; rows: number; heights: (number | null)[] };
}
export function terrainInput(data: any): TerrainInput | undefined {
  const grid = data.metadata?.model3d?.terrain;
  const coords = data.features.find((f: any) => f.properties.role === 'trace')?.geometry.coordinates;
  if (!grid || !coords?.length || grid.heights.length !== grid.rows * grid.columns) return undefined;
  return { origin: coords[0], baseline: data.metadata.model3d.elevation?.[0]?.[1] ?? 0, grid };
}

/** Raster terrain conformed to the road corridor; avoids floating ribbons over a flat floor. */
export class TrackTerrain {
  readonly geometry = new T.BufferGeometry();
  readonly base: number;
  private bins = new Map<string, number[]>();
  private minX = Infinity; private maxX = -Infinity;
  private minZ = Infinity; private maxZ = -Infinity;
  constructor(private path: TrackPath, private input?: TerrainInput) {
    const p = path.points;
    p.forEach((a, i) => {
      this.minX = Math.min(this.minX, a.x); this.maxX = Math.max(this.maxX, a.x);
      this.minZ = Math.min(this.minZ, a.z); this.maxZ = Math.max(this.maxZ, a.z);
      const b = p[(i + 1) % p.length];
      for (let x = Math.floor(Math.min(a.x, b.x) / 50); x <= Math.floor(Math.max(a.x, b.x) / 50); x++)
        for (let z = Math.floor(Math.min(a.z, b.z) / 50); z <= Math.floor(Math.max(a.z, b.z) / 50); z++) {
          const key = `${x}:${z}`; const bin = this.bins.get(key) ?? []; bin.push(i); this.bins.set(key, bin);
        }
    });
    this.base = Math.min(...p.map(p => p.y), ...(input?.grid.heights.filter(h => h !== null).map(h => h! - input.baseline) ?? [0])) - 20;
    const x0 = this.minX - 150, x1 = this.maxX + 150, z0 = this.minZ - 150, z1 = this.maxZ + 150;
    const nx = Math.ceil((x1 - x0) / 7), nz = Math.ceil((z1 - z0) / 7);
    const pos: number[] = [], index: number[] = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = T.MathUtils.lerp(x0, x1, i / nx), z = T.MathUtils.lerp(z0, z1, j / nz);
      pos.push(x, this.heightAt(x, z), z);
      if (i < nx && j < nz) { const k = i + j * (nx + 1); index.push(k, k + nx + 1, k + 1, k + 1, k + nx + 1, k + nx + 2); }
    }
    // A connected skirt, not a disconnected vertical cliff at the terrain tile edge.
    const edge: number[] = [];
    for (let i = 0; i <= nx; i++) edge.push(i);
    for (let j = 1; j <= nz; j++) edge.push(nx + j * (nx + 1));
    for (let i = nx - 1; i >= 0; i--) edge.push(i + nz * (nx + 1));
    for (let j = nz - 1; j > 0; j--) edge.push(j * (nx + 1));
    const start = pos.length / 3, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    edge.forEach(k => pos.push(cx + (pos[k * 3] - cx) * 6, this.base, cz + (pos[k * 3 + 2] - cz) * 6));
    edge.forEach((k, i) => { const j = (i + 1) % edge.length; index.push(k, start + i, edge[j], edge[j], start + i, start + j); });
    this.geometry.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); this.geometry.setIndex(index); this.geometry.computeVertexNormals();
  }
  private rasterAt(x: number, z: number) {
    if (!this.input) return 0;
    const { grid: g, origin, baseline } = this.input;
    const lon = origin[0] + x / (111320 * Math.cos(origin[1] * Math.PI / 180));
    const lat = origin[1] - z / 111320;
    const gx = T.MathUtils.clamp((lon - g.bounds[0]) / (g.bounds[2] - g.bounds[0]) * (g.columns - 1), 0, g.columns - 1);
    const gz = T.MathUtils.clamp((g.bounds[3] - lat) / (g.bounds[3] - g.bounds[1]) * (g.rows - 1), 0, g.rows - 1);
    const ix = Math.min(g.columns - 2, Math.floor(gx)), iz = Math.min(g.rows - 2, Math.floor(gz));
    const h = (i: number, j: number) => (g.heights[i + j * g.columns] ?? baseline) - baseline;
    return T.MathUtils.lerp(T.MathUtils.lerp(h(ix, iz), h(ix + 1, iz), gx - ix), T.MathUtils.lerp(h(ix, iz + 1), h(ix + 1, iz + 1), gx - ix), gz - iz);
  }
  heightAt(x: number, z: number) {
    let nearest = 80 * 80, road = 0;
    const bx = Math.floor(x / 50), bz = Math.floor(z / 50), p = this.path.points;
    for (let i = bx - 2; i <= bx + 2; i++) for (let j = bz - 2; j <= bz + 2; j++) for (const k of this.bins.get(`${i}:${j}`) ?? []) {
      const a = p[k], b = p[(k + 1) % p.length], dx = b.x - a.x, dz = b.z - a.z;
      const t = T.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      const d2 = (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2;
      if (d2 < nearest) { nearest = d2; road = T.MathUtils.lerp(a.y, b.y, t); }
    }
    const raster = this.rasterAt(x, z);
    if (nearest >= 80 * 80) return raster;
    const blend = T.MathUtils.smoothstep(Math.sqrt(nearest), 12, 80);
    return T.MathUtils.lerp(road - .18, raster, blend);
  }
}
