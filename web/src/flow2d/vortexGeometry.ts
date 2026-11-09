import polygonClipping from 'polygon-clipping';
import type { Point } from './geometry';
/** Merge overlapping editor shapes before constructing vvflow body boundaries. */
export function vortexOutlines(outlines: Point[][], referenceLength: number): number[] {
  if (!Number.isFinite(referenceLength) || referenceLength <= 0) throw new Error('Choose a positive reference length.');
  if (!outlines.length) return [];
  const polygons = outlines.map(points => [points.map(p => [p.x, p.y] as [number, number])]);
  const union = polygonClipping.union(polygons[0], ...polygons.slice(1));
  const data: number[] = [];
  for (const polygon of union) {
    if (polygon.length !== 1) throw new Error('Vortex particles cannot yet simulate enclosed holes. Use another animation for this scene.');
    const ring = polygon[0].slice(0, -1);
    data.push(ring.length);for (const [x, y] of ring) data.push(x / referenceLength, y / referenceLength);
  }
  return data;
}
