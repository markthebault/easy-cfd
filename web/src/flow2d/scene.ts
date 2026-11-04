import { DOMAIN, NX, NY, PRESETS, inside, maskFor, validProfile, type Point, type Profile } from "./geometry";
import { mapNode, sampleCurve, validCurve, type CurveNode } from "./curves";
import { LEGACY_GRID, TUNNELS, isTunnel, type Grid, type TunnelId } from "./grid";

export type Shape = Profile & { id: string; rotation: number; curve?: CurveNode[]; enabled?: boolean; preset?: string };
export type Scene = { shapes: Shape[]; selectedId: string | null; selectedIds?: string[]; tunnel?: TunnelId; referenceLength?: number };
export const isEnabled = (shape: Shape) => shape.enabled !== false;
export const enabledShapes = (scene: Scene) => scene.shapes.filter(isEnabled);
export const isCarShape = (shape: Shape) => shape.preset === "car" || shape.name === "Car silhouette";
export const referenceLengthFor = (scene: Scene) => Number.isFinite(scene.referenceLength) && scene.referenceLength! > 0 ? scene.referenceLength! : scene.shapes.length ? Math.max(.1, bounds(scene.shapes.flatMap(s => s.points)).width) : 1;
export const simulationKey = (scene: Scene) => JSON.stringify([sceneGrid(scene).id, referenceLengthFor(scene), enabledShapes(scene).map(s => s.points)]);
export const sceneGrid = (scene: Scene): Grid => scene.tunnel ? TUNNELS[scene.tunnel] : LEGACY_GRID;
export const SCENE_KEY = "easycfd.flow2d.v2";
export const shapeFrom = (profile: Profile & { curve?: CurveNode[] }): Shape => ({ ...structuredClone(profile), id: crypto.randomUUID(), rotation: 0, enabled: true, ...(profile.name === PRESETS.car.name ? { preset: "car" } : {}) });
export const sceneFrom = (profile: Profile, tunnel: TunnelId = profile.vehicle || profile.name === PRESETS.car.name ? "large" : "small"): Scene => { let shape = shapeFrom(profile); if (profile.vehicle || profile === PRESETS.car) shape = moveShape(shape, TUNNELS[tunnel].width * .15 - bounds(shape.points).minX, 0); return { shapes: [shape], selectedId: shape.id, tunnel, referenceLength: bounds(shape.points).width }; };
export const selectedShape = (scene: Scene) => scene.shapes.find(s => s.id === scene.selectedId);
export const selectedShapes = (scene: Scene) => scene.shapes.filter(s => (scene.selectedIds ?? (scene.selectedId ? [scene.selectedId] : [])).includes(s.id));
export const transformSelection = (scene: Scene, transform: (shape: Shape) => Shape): Scene => { const ids = new Set(selectedShapes(scene).map(s => s.id)); return { ...scene, shapes: scene.shapes.map(s => ids.has(s.id) ? transform(s) : s) }; };
export const withCurve = (shape: Shape, curve: CurveNode[]): Shape => ({ ...shape, curve, points: sampleCurve(curve) });
export function transformShape(shape: Shape, transform: (p: Point) => Point): Shape {
  return shape.curve ? withCurve(shape, shape.curve.map(p => mapNode(p, transform))) : { ...shape, points: shape.points.map(transform) };
}
export function bounds(points: Point[]) {
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
}
/** Select solids touched by a rectangle, including edge crossings and a box
 * entirely inside a solid. Work in world coordinates so zoom/pan stay exact. */
export function selectInBox(scene: Scene, a: Point, b: Point, additive = false): Scene {
  const box = bounds([a, b]), ids = new Set(additive ? selectedShapes(scene).map(s => s.id) : []);
  const contains = (p: Point) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
  const crosses = (a: Point, b: Point) => {
    let near = 0, far = 1;
    for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.minX, box.maxX], [a.y, b.y - a.y, box.minY, box.maxY]]) {
      if (Math.abs(delta) < 1e-12) { if (start < min || start > max) return false; }
      else { const t0 = (min - start) / delta, t1 = (max - start) / delta; near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1)); if (near > far) return false; }
    }
    return true;
  };
  for (const shape of scene.shapes) {
    const b = bounds(shape.points);
    if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) continue;
    if (shape.points.some(contains) || [[box.minX, box.minY], [box.minX, box.maxY], [box.maxX, box.minY], [box.maxX, box.maxY]].some(([x, y]) => inside(x, y, shape.points)) || shape.points.some((p, i) => crosses(p, shape.points[(i + 1) % shape.points.length]))) ids.add(shape.id);
  }
  return { ...scene, selectedId: [...ids].at(-1) ?? null, selectedIds: [...ids] };
}
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  return transformShape(shape, p => ({ x: p.x + dx, y: p.y + dy }));
}
export function rotateShape(shape: Shape, degrees: number, pivot = bounds(shape.points).center): Shape {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { ...transformShape(shape, p => ({ x: pivot.x + (p.x - pivot.x) * c - (p.y - pivot.y) * s, y: pivot.y + (p.x - pivot.x) * s + (p.y - pivot.y) * c })), rotation: shape.rotation + degrees };
}
export function scaleShape(shape: Shape, sx: number, sy: number, pivot = bounds(shape.points).center): Shape { return transformShape(shape, p => ({ x: pivot.x + (p.x - pivot.x) * sx, y: pivot.y + (p.y - pivot.y) * sy })); }
export const replaceShape = (scene: Scene, shape: Shape): Scene => ({ ...scene, shapes: scene.shapes.map(s => s.id === shape.id ? shape : s) });
export function sceneMask(outlines: Point[][], nx = NX, ny = NY, domain = DOMAIN) {
  const result = new Float32Array(nx * ny);
  for (const points of outlines) { const mask = maskFor(points, nx, ny, domain); for (let i = 0; i < result.length; i++) if (mask[i]) result[i] = 1; }
  return result;
}
export function sceneError(scene: Scene): string | null {
  const grid = sceneGrid(scene);
  if (scene.referenceLength !== undefined && (!Number.isFinite(scene.referenceLength) || scene.referenceLength < .01 || scene.referenceLength > 1000)) return "Use a finite reference length between 0.01 and 1,000 m.";
  if (scene.shapes.length > 16) return "Use up to 16 shapes in this preview.";
  for (const shape of scene.shapes) {
    if (!shape.name.trim() || shape.name.length > 80) return "Use a shape name between 1 and 80 characters.";
    if (shape.curve && (!validCurve(shape.curve) || shape.points.length > 512)) return "Use up to 64 curve anchors and keep the outline simple.";
    if (!validProfile(shape.points)) return `${shape.name}: keep a closed outline with thickness and no crossing edges.`;
    if (!isEnabled(shape)) continue;
    if (shape.points.some(p => p.x < .04 || p.x > grid.width - .05 || p.y < .025 || p.y > grid.height - .05)) return `Keep the whole shape inside the ${grid.width} m × ${grid.height} m tunnel and above the ground. Choose a larger box if needed.`;
    if (maskFor(shape.points, grid.nx, grid.ny, grid).reduce((a, b) => a + b, 0) < 6) return "That shape is too thin for this grid. Add some thickness.";
  }
  return null;
}
export function restoreScene(): Scene {
  const query = new URLSearchParams(location.search), example = query.get("profile"), requested = query.get("tunnel");
  if (example && Object.hasOwn(PRESETS, example)) { const scene = sceneFrom(PRESETS[example], isTunnel(requested) ? requested : undefined); if (!sceneError(scene)) return scene; }
  if (isTunnel(requested)) return sceneFrom(requested === "large" ? PRESETS.car : PRESETS.airfoil, requested);
  try {
    const saved = JSON.parse(localStorage.getItem(SCENE_KEY) ?? "null") as Scene | null;
    if (saved && Array.isArray(saved.shapes) && saved.shapes.every(s => typeof s.id === "string" && typeof s.name === "string" && Number.isFinite(s.rotation) && Array.isArray(s.points) && s.points.length <= 512 && (!s.curve || validCurve(s.curve))) && new Set(saved.shapes.map(s => s.id)).size === saved.shapes.length) {
      // Earlier projects used metres already. Enlarge their box without
      // silently changing authored lengths, positions or curve handles.
      saved.tunnel = isTunnel(saved.tunnel) ? saved.tunnel : "medium";
      saved.referenceLength = referenceLengthFor(saved);
      saved.shapes = saved.shapes.map(s => s.curve ? withCurve(s, s.curve) : s);
      if (Array.isArray(saved.selectedIds)) { saved.selectedIds = [...new Set(saved.selectedIds.filter(id => saved.shapes.some(s => s.id === id)))]; saved.selectedId = saved.selectedIds.at(-1) ?? null; }
      else delete saved.selectedIds;
      if (!sceneError(saved)) return saved;
    }
    const legacy = JSON.parse(localStorage.getItem("easycfd.flow2d.v1") ?? "null") as Profile | null;
    if (legacy && typeof legacy.name === "string" && Array.isArray(legacy.points) && legacy.points.length <= 512) { const migrated = sceneFrom(legacy); if (!sceneError(migrated)) return migrated; }
  } catch { /* A fresh scene also works without browser storage. */ }
  return sceneFrom(PRESETS.car);
}

export function addedPreset(key: string, selected?: Shape, grid: Grid = LEGACY_GRID): Shape {
  let profile: Profile;
  if (key === "rectangle") profile = { name: "Rectangle", points: [{ x: 0, y: 0 }, { x: .35, y: 0 }, { x: .35, y: .08 }, { x: 0, y: .08 }] };
  else profile = structuredClone(PRESETS[key]);
  const shape = shapeFrom(profile), b = bounds(shape.points);
  // New parts start above the selected geometry, where they can be grabbed.
  if (profile.vehicle || key === "car") return moveShape(shape, grid.width * .15 - b.minX, 0);
  shape.points = shape.points.map(p => ({ x: p.x - b.center.x, y: p.y - b.minY }));
  const target = selected ? bounds(selected.points) : null;
  return moveShape(shape, Math.max(b.width / 2 + .1, Math.min(grid.width - b.width / 2 - .1, target?.center.x ?? grid.width * .35)), Math.min(grid.height - b.height - .1, (target?.maxY ?? .3) + .12));
}
