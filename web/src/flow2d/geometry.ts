import type { CurveNode } from "./curves";
import { MX5_NC_PRHT } from "./presets/mx5NcPrht";

export type Point = { x: number; y: number };
export type Profile = { name: string; points: Point[]; curve?: CurveNode[]; vehicle?: boolean };
// Kept for compatibility with previous saved scenes and numerical fixtures.
export const DOMAIN = { width: 4.2, height: 1.2 };
export const NX = 672;
export const NY = 192;

export const PRESETS: Record<string, Profile> = {
  // Traced from the grey body in the supplied Car.png CFD screenshot.
  // Calibrated below to a 4.3 m long, 1.5 m high illustrative car.
  car: { name: "Car silhouette", vehicle: true, points: [
    { x: .68, y: .1087 }, { x: .6941, y: .1511 }, { x: .7154, y: .1723 },
    { x: .8215, y: .2714 }, { x: .8781, y: .2997 }, { x: .9771, y: .3209 },
    { x: 1.345, y: .335 }, { x: 1.4865, y: .4341 }, { x: 1.6138, y: .4836 },
    { x: 1.8472, y: .4765 }, { x: 1.9251, y: .4553 }, { x: 2.0312, y: .3987 },
    { x: 2.2222, y: .335 }, { x: 2.2576, y: .3492 }, { x: 2.2929, y: .3916 },
    { x: 2.3, y: .2643 }, { x: 2.2717, y: .1087 }, { x: 2.2363, y: .0733 },
    { x: 2.1585, y: .0521 }, { x: .6941, y: .045 },
  ] },
  "mx5-nc-prht": MX5_NC_PRHT,
  splitter: { name: "Raised leading edge", points: [
    { x: .7, y: .27 }, { x: .78, y: .28 }, { x: 1.02, y: .2 },
    { x: 1.32, y: .15 }, { x: 1.7, y: .15 }, { x: 2.12, y: .2 },
    { x: 2.12, y: .16 }, { x: 1.7, y: .11 }, { x: 1.32, y: .11 },
    { x: 1.02, y: .16 }, { x: .78, y: .24 }, { x: .7, y: .23 },
  ] },
  airfoil: { name: "Airfoil section", points: Array.from({ length: 64 }, (_, i) => {
    const t = i < 32 ? i / 31 : (63 - i) / 31;
    const x = (1 - Math.cos(t * Math.PI)) / 2;
    const thickness = 5 * .15 * (.2969 * Math.sqrt(x) - .126 * x - .3516 * x ** 2 + .2843 * x ** 3 - .1036 * x ** 4);
    return { x: .7 + 1.45 * x, y: .52 + (i < 32 ? thickness : -thickness) * 1.45 - x * .12 };
  }) },
  cylinder: { name: "Cylinder wake", points: Array.from({ length: 48 }, (_, i) => ({
    x: 1 + .14 * Math.cos(i / 48 * Math.PI * 2), y: .54 + .14 * Math.sin(i / 48 * Math.PI * 2),
  })) },
};
export const CAR_REFERENCE = structuredClone(PRESETS.car);
PRESETS.car.points = CAR_REFERENCE.points.map(p => ({ x: 3 + (p.x - .68) * 4.3 / 1.62, y: .15 + (p.y - .045) * 1.5 / .4386 }));
// Mirror the existing inclined section vertically: the trailing edge rises
// downstream for downforce. Start with a 500 mm chord; transforms stay editable.
PRESETS["inverted-airfoil"] = { name: "Inverted airfoil", points: PRESETS.airfoil.points.map(p => ({ x: .7 + (p.x - .7) * .5 / 1.45, y: .65 - (p.y - .46) * .5 / 1.45 })) };

export function inside(x: number, y: number, points: Point[]) {
  let yes = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
}

export function maskFor(points: Point[], nx = NX, ny = NY, domain = DOMAIN) {
  const mask = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    mask[y * nx + x] = inside(x / (nx - 1) * domain.width, y / (ny - 1) * domain.height, points) ? 1 : 0;
  }
  return mask;
}

export function signedArea(points: Point[]) {
  return points.reduce((area, a, i) => { const b = points[(i + 1) % points.length]; return area + a.x * b.y - a.y * b.x; }, 0) / 2;
}

export function validProfile(points: Point[]) {
  if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || Math.abs(signedArea(points)) < .0005) return false;
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue;
    const a = points[i], b = points[(i + 1) % points.length], c = points[j], d = points[(j + 1) % points.length];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
  }
  return true;
}
