import type { Point } from "./geometry";

export type CurveNode = Point & { incoming?: Point; outgoing?: Point };
export type DrawTool = "line" | "bezier" | "rectangle" | "ellipse" | "freehand";
export const curved = (nodes: CurveNode[]) => nodes.some(p => p.incoming || p.outgoing);
export function mapNode(node: CurveNode, transform: (p: Point) => Point): CurveNode {
  return { ...transform(node), ...(node.incoming ? { incoming: transform(node.incoming) } : {}), ...(node.outgoing ? { outgoing: transform(node.outgoing) } : {}) };
}
export function tangent(node: CurveNode, side: "incoming" | "outgoing", point: Point, mirror = true): CurveNode {
  const other = side === "incoming" ? "outgoing" : "incoming";
  return { ...node, [side]: point, ...(mirror ? { [other]: { x: 2 * node.x - point.x, y: 2 * node.y - point.y } } : {}) };
}
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distanceToLine = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
/** Flatten to sub-cell accuracy for the solid mask; retain the original handles. */
export function sampleCurve(nodes: CurveNode[], closed = true, tolerance = .001): Point[] {
  if (!nodes.length) return [];
  const points: Point[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const segment = (a: Point, b: Point, c: Point, d: Point, depth: number, t0: number, t1: number, out: { p: Point; t: number }[]) => {
    if (depth >= 8 || Math.max(distanceToLine(b, a, d), distanceToLine(c, a, d)) <= tolerance) { out.push({ p: { x: d.x, y: d.y }, t: t1 }); return; }
    const ab = middle(a, b), bc = middle(b, c), cd = middle(c, d), abc = middle(ab, bc), bcd = middle(bc, cd), mid = middle(abc, bcd);
    segment(a, ab, abc, mid, depth + 1, t0, (t0 + t1) / 2, out); segment(mid, bcd, cd, d, depth + 1, (t0 + t1) / 2, t1, out);
  };
  for (let i = 0; i < nodes.length - (closed ? 0 : 1); i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    const c = a.outgoing ?? a, d = b.incoming ?? b, samples: { p: Point; t: number }[] = [];
    segment(a, c, d, b, 0, 0, 1, samples);
    // Include exact extrema so width/height resizing stays accurate even when
    // adaptive subdivision changes after an affine transform.
    for (const axis of ["x", "y"] as const) {
      const qa = -a[axis] + 3 * c[axis] - 3 * d[axis] + b[axis], qb = 2 * (a[axis] - 2 * c[axis] + d[axis]), qc = c[axis] - a[axis];
      const discriminant = qb * qb - 4 * qa * qc;
      const roots = Math.abs(qa) < 1e-12 ? Math.abs(qb) < 1e-12 ? [] : [-qc / qb] : discriminant >= 0 ? [(-qb + Math.sqrt(discriminant)) / (2 * qa), (-qb - Math.sqrt(discriminant)) / (2 * qa)] : [];
      for (const t of roots) if (t > 1e-8 && t < 1 - 1e-8) {
        const s = 1 - t, evaluate = (key: "x" | "y") => s ** 3 * a[key] + 3 * s * s * t * c[key] + 3 * s * t * t * d[key] + t ** 3 * b[key];
        samples.push({ t, p: { x: evaluate("x"), y: evaluate("y") } });
      }
    }
    samples.sort((a, b) => a.t - b.t);
    samples.forEach((entry, j) => { if (!j || entry.t - samples[j - 1].t > 1e-8) points.push(entry.p); });
  }
  if (closed) points.pop();
  return points;
}
export function curvePath(nodes: CurveNode[], project: (p: Point) => Point = p => p, closed = true) {
  if (!nodes.length) return "";
  const xy = (p: Point) => { const q = project(p); return `${q.x},${q.y}`; };
  let d = `M${xy(nodes[0])}`;
  for (let i = 0; i < nodes.length - (closed ? 0 : 1); i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    d += a.outgoing || b.incoming ? ` C${xy(a.outgoing ?? a)} ${xy(b.incoming ?? b)} ${xy(b)}` : ` L${xy(b)}`;
  }
  return d + (closed ? " Z" : "");
}
export function ellipse(a: Point, b: Point): CurveNode[] {
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2, rx = Math.abs(a.x - b.x) / 2, ry = Math.abs(a.y - b.y) / 2, k = .5522847498307936;
  return [
    { x: x + rx, y, incoming: { x: x + rx, y: y - k * ry }, outgoing: { x: x + rx, y: y + k * ry } },
    { x, y: y + ry, incoming: { x: x + k * rx, y: y + ry }, outgoing: { x: x - k * rx, y: y + ry } },
    { x: x - rx, y, incoming: { x: x - rx, y: y + k * ry }, outgoing: { x: x - rx, y: y - k * ry } },
    { x, y: y - ry, incoming: { x: x - k * rx, y: y - ry }, outgoing: { x: x + k * rx, y: y - ry } },
  ];
}
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  let furthest = 0, distance = tolerance;
  for (let i = 1; i < points.length - 1; i++) { const d = distanceToLine(points[i], points[0], points.at(-1)!); if (d > distance) { distance = d; furthest = i; } }
  return furthest ? [...simplify(points.slice(0, furthest + 1), tolerance).slice(0, -1), ...simplify(points.slice(furthest), tolerance)] : [points[0], points.at(-1)!];
}
export function validCurve(value: unknown): value is CurveNode[] {
  const point = (p: unknown): p is Point => !!p && typeof p === "object" && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y);
  return Array.isArray(value) && value.length >= 3 && value.length <= 64 && value.every(p => { if (!point(p)) return false; const node = p as CurveNode; return (!node.incoming || point(node.incoming)) && (!node.outgoing || point(node.outgoing)); });
}
