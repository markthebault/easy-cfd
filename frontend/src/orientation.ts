import type { Geometry, ImportOptions } from "./types";

// Import axes are strings like "-X". A world rotation of the result is a change of
// which source axis is read as forward or up, so rebuilding from the originals
// applies it exactly, with no accumulated transform.
const vector = (axis: string) => {
  const v = [0, 0, 0];
  v["XYZ".indexOf(axis[1])] = axis[0] === "+" ? 1 : -1;
  return v;
};
const axis = (v: number[]) => {
  const i = v.findIndex((x) => x !== 0);
  return (v[i] > 0 ? "+" : "-") + "XYZ"[i];
};
const negate = (a: string) => (a[0] === "+" ? "-" : "+") + a[1];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const rotations = {
  // 90° clockwise seen from above, about the vertical axis.
  turn: (o: ImportOptions) => ({
    ...o,
    forward: axis(cross(vector(o.up), vector(o.forward))),
  }),
  // 180° about the vertical axis: nose and tail swap.
  reverse: (o: ImportOptions) => ({ ...o, forward: negate(o.forward) }),
  // 90° about the transverse axis: nose goes up.
  pitch: (o: ImportOptions) => ({ ...o, forward: negate(o.up), up: o.forward }),
  // 180° about the longitudinal axis: roof and floor swap, nose stays.
  flip: (o: ImportOptions) => ({ ...o, up: negate(o.up) }),
};

export const UNITS = { m: 1, mm: 0.001, cm: 0.01, in: 0.0254 } as const;
export const UNIT_NAMES = {
  m: "metres",
  mm: "millimetres",
  cm: "centimetres",
  in: "inches",
} as const;

export type Hint = { text: string; fix?: ImportOptions; action?: string };

// Suggestions from the bounding box only. They can be wrong for unusual shapes,
// so each is phrased as a question and applied only when the user chooses it.
export function hints(geometry: Geometry): Hint[] {
  const options = geometry.import_options;
  const [length, width, height] = geometry.dimensions;
  const longest = Math.max(length, width, height);
  const out: Hint[] = [];
  const hasStl = geometry.sources?.some((s) => /\.stl$/i.test(s.name));
  if (options && hasStl && (longest > 15 || longest < 0.5)) {
    const raw = longest / UNITS[options.units];
    const best = (Object.keys(UNITS) as (keyof typeof UNITS)[])
      .filter((u) => u !== options.units)
      .map((u) => ({ u, size: raw * UNITS[u] }))
      .filter(({ size }) => size >= 1 && size <= 12)
      .sort(
        (a, b) =>
          Math.abs(Math.log(a.size / 4)) - Math.abs(Math.log(b.size / 4)),
      )[0];
    if (best)
      out.push({
        text: `Longest side is ${longest.toPrecision(3)} m. If this is a full-size car, the STL units may be wrong: read as ${UNIT_NAMES[best.u]} it would be ${best.size.toFixed(2)} m.`,
        fix: { ...options, units: best.u },
        action: `Use ${UNIT_NAMES[best.u]}`,
      });
  }
  if (height > length * 1.1 && height >= width)
    out.push({
      text: "The model is taller than it is long. The up direction may be wrong.",
      fix: options && rotations.pitch(options),
      action: "Pitch 90°",
    });
  else if (width > length * 1.1)
    out.push({
      text: "The model is wider than it is long. It may be sideways to the airflow.",
      fix: options && rotations.turn(options),
      action: "Turn 90°",
    });
  const on = geometry.parts.filter((p) => p.enabled !== false);
  const middle = (role: string) => {
    const zs = on
      .filter((p) => p.role === role)
      .map((p) => (p.bounds[0][2] + p.bounds[1][2]) / 2);
    return zs.length ? zs.reduce((a, b) => a + b) / zs.length : null;
  };
  const wheels = middle("wheel"),
    body = middle("body");
  if (wheels !== null && body !== null && wheels > body)
    out.push({
      text: "The wheels sit above the body. The model may be upside down.",
      fix: options && rotations.flip(options),
      action: "Flip upside down",
    });
  return out;
}
