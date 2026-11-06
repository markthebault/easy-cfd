import type { Vec3 } from '../solver/types';
import type { VizField } from '../solver/extract';
import type { AeroMap, MapManifest } from './aeroMap';
import type { LoadedRun } from '../store/types';

export interface CfdPart {
  id: string;
  name: string;
  role: 'body' | 'wheel';
  wheel: { center: Vec3; radius: number } | null;
  vertices: number;
  positions: string;
  cp: string;
}
export interface CfdManifest {
  version: 1;
  engine: 'openfoam';
  runId: string;
  sourceName: string;
  settings: { speed_kmh: number; yaw_deg: number; density: number; reference_area: number; moving_ground: boolean; wheels: boolean };
  bounds: { low: Vec3; high: Vec3 };
  field: { file: string; origin: Vec3; spacing: Vec3; dims: [number, number, number]; freestream: number; inlet: Vec3; length: number };
  parts: CfdPart[];
  cpRange: [number, number];
  speedMax: number;
  result: { cd: number; cl: number; cells: number; forceSettled: boolean; residualConverged: boolean; warnings: string[] };
  hashes: Record<string, string>;
}
export interface CfdData {
  manifest: CfdManifest;
  map?: AeroMap;
  field: VizField;
  parts: { info: CfdPart; positions: Float32Array; cp: Float32Array }[];
}

/** Reuse the immutable geometry, field and wall samples already loaded by the wind tunnel. */
export function cfdFromRun(run: LoadedRun): CfdData {
  if (!run.field || !run.parts.length) throw new Error('This wind-tunnel run has no saved geometry/airflow. Run it again before testing on track.');
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of run.parts) for (let i = 0; i < p.positions.length; i++) {
    const axis = i % 3; low[axis] = Math.min(low[axis], p.positions[i]); high[axis] = Math.max(high[axis], p.positions[i]);
  }
  const parts = run.parts.map((p, i) => ({
    info: { id: p.id, name: p.name, role: p.role, wheel: p.wheel, vertices: p.positions.length / 3, positions: '', cp: '' },
    positions: p.positions, cp: run.surface?.[i]?.cp ?? new Float32Array(p.positions.length / 3).fill(NaN),
  }));
  const { doc, field } = run;
  return { parts, field, manifest: {
    version: 1, engine: 'openfoam', runId: doc.id, sourceName: doc.designName,
    settings: doc.settings, bounds: { low, high },
    field: { file: '', origin: field.origin, spacing: field.spacing, dims: field.dims, freestream: field.freestream, inlet: field.inlet, length: field.length },
    parts: parts.map(p => p.info), cpRange: run.ranges.cp, speedMax: run.ranges.speed[1], hashes: {},
    result: { cd: doc.result.cd, cl: doc.result.cl, cells: doc.result.cells, forceSettled: doc.result.settled, residualConverged: doc.result.openfoam?.residualConverged ?? false, warnings: doc.result.warnings },
  } };
}
async function binary(file: string, signal: AbortSignal) {
  const response = await fetch(`/track-cfd/${file}`, { signal });
  if (!response.ok || !response.body) throw new Error(`Could not load OpenFOAM data (${file}).`);
  // Vite serves Content-Encoding:gzip; other static hosts may send the compressed file directly.
  // fetch has already decoded HTTP gzip. Inspect the bytes to avoid decompressing twice.
  const buffer = await response.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 3));
  return head[0] === 0x1f && head[1] === 0x8b && head[2] === 8
    ? new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : buffer;
}
export async function loadCfd(signal: AbortSignal, onProgress?: (message: string) => void): Promise<CfdData> {
  const response = await fetch('/track-cfd/manifest.json', { signal });
  if (!response.ok) throw new Error('The MX-5 OpenFOAM result is unavailable.');
  const manifest: CfdManifest = await response.json();
  if (manifest.version !== 1 || manifest.engine !== 'openfoam') throw new Error('Unsupported CFD dataset.');
  const mapResponse = await fetch('/track-cfd/map.json', { signal });
  const mapManifest: MapManifest | null = mapResponse.ok ? await mapResponse.json() : null;
  if (mapManifest) {
    if (mapManifest.version !== 1 || mapManifest.engine !== 'openfoam' || mapManifest.speeds.length < 2 || mapManifest.yaws.length < 2 || mapManifest.samples.length !== mapManifest.speeds.length * mapManifest.yaws.length) throw new Error('Incomplete CFD map.');
    for (const p of manifest.parts) if (mapManifest.geometryHashes[p.id] !== manifest.hashes[p.positions.slice(0, -3)]) throw new Error('CFD map geometry does not match this car.');
    if (JSON.stringify(mapManifest.grid.dims) !== JSON.stringify(manifest.field.dims) || JSON.stringify(mapManifest.grid.origin) !== JSON.stringify(manifest.field.origin) || JSON.stringify(mapManifest.grid.spacing) !== JSON.stringify(manifest.field.spacing)) throw new Error('CFD map grid does not match the display grid.');
  }
  const positions = await Promise.all(manifest.parts.map(p => binary(p.positions, signal).then(b => {
    if (b.byteLength !== p.vertices * 12) throw new Error('Invalid CFD geometry size.'); return new Float32Array(b);
  })));
  function decode(buffer: ArrayBuffer, grid: CfdManifest['field']): VizField {
    const n = grid.dims.reduce((a, b) => a * b, 1);
    if (buffer.byteLength !== n * 21) throw new Error('Invalid CFD field size.');
    const f = (i: number) => new Float32Array(buffer, n * 4 * i, n);
    return { ...grid, u: f(0), v: f(1), w: f(2), p: f(3), k: f(4), solid: new Uint8Array(buffer, n * 20, n).map(v => v ? 0 : 1) };
  }
  if (mapManifest) {
    const samples: AeroMap['samples'] = [];
    for (const info of mapManifest.samples) {
      if (info.meshHash !== mapManifest.meshHash) throw new Error('CFD samples use different physical meshes.');
      onProgress?.(`Loading OpenFOAM cases ${samples.length + 1}/${mapManifest.samples.length}…`);
      const [buffer, cp] = await Promise.all([binary(info.field, signal), Promise.all(manifest.parts.map(p => binary(info.cp[p.id], signal).then(b => {
        if (b.byteLength !== p.vertices * 4) throw new Error('Invalid map wall-pressure size.'); return new Float32Array(b);
      })))]);
      samples.push({ info, field: decode(buffer, { ...manifest.field, freestream: info.freestream, inlet: info.inlet }), cp });
    }
    return { manifest, map: { manifest: mapManifest, samples }, field: samples[0].field, parts: manifest.parts.map((info, i) => ({ info, positions: positions[i], cp: samples[0].cp[i] })) };
  }
  const [buffer, cp] = await Promise.all([binary(manifest.field.file, signal), Promise.all(manifest.parts.map(p => binary(p.cp, signal).then(b => new Float32Array(b))))]);
  return { manifest, field: decode(buffer, manifest.field), parts: manifest.parts.map((info, i) => ({ info, positions: positions[i], cp: cp[i] })) };
}
