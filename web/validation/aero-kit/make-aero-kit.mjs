// Synthetic aero kit for the MX-5 validation body (synthetic test geometry, not a real product):
// rear wing (inverted NACA 6412, 10° nose-down, 0.28 m chord, 1.40 m span) with endplates and two
// supports (10–12 mm plates, thick enough for the legacy OpenFOAM mesher), a 12 mm front splitter and a pair of 15° canards. All parts are closed, outward-wound
// solids in the MX-5 validation frame (metres, nose −X, up +Z).
// Usage: node validation/aero-kit/make-aero-kit.mjs  → validation/aero-kit/*.stl
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = dirname(fileURLToPath(import.meta.url));

function writeSTL(name, tris) {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write(`EasyCFD synthetic aero kit: ${name}`.slice(0, 79));
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach(([a, b, c], i) => {
    const o = 84 + 50 * i;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    [...n.map((x) => x / l), ...a, ...b, ...c].forEach((x, k) => buf.writeFloatLE(x, o + 4 * k));
  });
  writeFileSync(resolve(out, `${name}.stl`), buf);
  const vol = tris.reduce((s, [a, b, c]) => s + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
  console.log(`${name}.stl  ${tris.length} triangles, volume ${(vol * 1e6).toFixed(0)} cm³`);
  if (vol <= 0) throw new Error(`${name}: inward winding`);
}

/** Box from 8 corners given as a function of (i, j, k) ∈ {0,1}³, outward winding. */
function hexa(corner) {
  const p = (i, j, k) => corner(i, j, k);
  const quads = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)], // bottom (−z)
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], // top
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], // −y
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)], // +y
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)], // −x
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], // +x
  ];
  return quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
}

const box = (x0, x1, y0, y1, z0, z1) => hexa((i, j, k) => [i ? x1 : x0, j ? y1 : y0, k ? z1 : z0]);

// Rear wing: inverted NACA 6412 section, rotated nose-down about the leading edge.
const chord = 0.28, span = 0.703, pc = 0.4, t = 0.12, N = 48;
function section(m = 0.06, aoaDeg = 10, leZ = 1.08) {
  const le = [1.5, leZ], aoa = (aoaDeg * Math.PI) / 180;
  const up = [], lo = [];
  for (let i = 0; i <= N; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / N));
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = x < pc ? (m / pc ** 2) * (2 * pc * x - x * x) : (m / (1 - pc) ** 2) * (1 - 2 * pc + 2 * pc * x - x * x);
    const dyc = x < pc ? ((2 * m) / pc ** 2) * (pc - x) : ((2 * m) / (1 - pc) ** 2) * (pc - x);
    const th = Math.atan(dyc);
    // Standard section (camber up), then inverted: camber points down, suction side underneath.
    const u = [x - yt * Math.sin(th), yc + yt * Math.cos(th)];
    const l = [x + yt * Math.sin(th), yc - yt * Math.cos(th)];
    up.push([l[0], -l[1]]); // inverted: the old lower surface becomes the upper one
    lo.push([u[0], -u[1]]);
  }
  // Close the trailing edge.
  const te = [(up[N][0] + lo[N][0]) / 2, (up[N][1] + lo[N][1]) / 2];
  up[N] = te;
  lo[N] = te;
  // Nose-down rotation (trailing edge up) about the leading edge, then scale and place.
  const place = ([x, z]) => {
    const X = x * chord, Z = z * chord;
    return [le[0] + X * Math.cos(aoa) - Z * Math.sin(aoa), le[1] + X * Math.sin(aoa) + Z * Math.cos(aoa)];
  };
  return { up: up.map(place), lo: lo.map(place) };
}
function wing(...args) {
  const { up, lo } = section(...args);
  const tris = [];
  const P = (q, y) => [q[0], y, q[1]];
  for (let i = 0; i < N; i++) {
    // upper surface (outward +z), lower surface (outward −z), spanning −span..+span
    if (i < N) {
      tris.push([P(up[i], -span), P(up[i], span), P(up[i + 1], span)], [P(up[i], -span), P(up[i + 1], span), P(up[i + 1], -span)]);
      tris.push([P(lo[i], -span), P(lo[i + 1], span), P(lo[i], span)], [P(lo[i], -span), P(lo[i + 1], -span), P(lo[i + 1], span)]);
    }
    // end caps as strips between the upper and lower points of each station
    for (const [y, s] of [[span, 1], [-span, -1]]) {
      const a = P(up[i], y), b = P(up[i + 1], y), c = P(lo[i + 1], y), d = P(lo[i], y);
      // the leading and trailing edges are single points: one triangle there
      const q = i === N - 1 ? [[a, b, d]] : i === 0 ? [[a, b, c]] : [[a, b, c], [a, c, d]];
      for (const tr of q) tris.push(s > 0 ? [tr[0], tr[2], tr[1]] : tr);
    }
  }
  return tris.map(([a, b, c]) => [a, c, b]); // built inward; flip to outward winding
}

function camberZ(xw, ...args) {
  const { up, lo } = section(...args);
  let best = 0;
  for (let i = 0; i < up.length; i++) if (Math.abs(up[i][0] - xw) < Math.abs(up[best][0] - xw)) best = i;
  return 0.5 * (up[best][1] + lo[best][1]);
}

const kit = {
  rear_wing: wing(),
  wing_endplate_left: box(1.44, 1.84, 0.7, 0.71, 0.98, 1.24),
  wing_endplate_right: box(1.44, 1.84, -0.71, -0.7, 0.98, 1.24),
  wing_support_left: box(1.6, 1.72, 0.344, 0.356, 0.85, camberZ(1.66)),
  wing_support_right: box(1.6, 1.72, -0.356, -0.344, 0.85, camberZ(1.66)),
  front_splitter: box(-2.1, -1.62, -0.78, 0.78, 0.228, 0.24),
};
// Canards: 10 mm plates, 0.14 m chord, root inside the bumper, trailing edge 15° up.
const tan15 = Math.tan((15 * Math.PI) / 180);
for (const [name, s] of [["canard_left", 1], ["canard_right", -1]]) {
  kit[name] = hexa((i, j, k) => {
    const x = i ? -1.72 : -1.86;
    const y = s * (j ? 0.82 : 0.45);
    const z = 0.42 + (x + 1.86) * tan15 + (k ? 0.01 : 0);
    return [x, y, z];
  });
  if (s < 0) kit[name] = kit[name].map(([a, b, c]) => [a, c, b]); // mirrored: flip winding
}
// The same wing assembly 0.25 m higher, above the roofline in clean flow (tests the wing model
// without the cabin's wake).
const DZ = 0.25;
const lift = (tris, dz, below = -Infinity) => tris.map((t) => t.map(([x, y, z]) => [x, y, z > below ? z + dz : z]));
kit.rear_wing_high = lift(kit.rear_wing, DZ);
kit.wing_high_endplate_left = lift(kit.wing_endplate_left, DZ);
kit.wing_high_endplate_right = lift(kit.wing_endplate_right, DZ);
// Supports keep their foot in the deck and reach the raised wing.
kit.wing_high_support_left = lift(kit.wing_support_left, DZ, 0.9);
kit.wing_high_support_right = lift(kit.wing_support_right, DZ, 0.9);
// A moderately loaded version in the raised position: inverted NACA 4412 at 4° (about 8° from
// zero lift), in the linear range where RANS lift predictions are dependable.
kit.rear_wing_mid = wing(0.04, 4, 1.08 + DZ);
kit.wing_mid_support_left = box(1.6, 1.72, 0.344, 0.356, 0.85, camberZ(1.66, 0.04, 4, 1.08 + DZ));
kit.wing_mid_support_right = box(1.6, 1.72, -0.356, -0.344, 0.85, camberZ(1.66, 0.04, 4, 1.08 + DZ));
for (const [name, tris] of Object.entries(kit)) writeSTL(name, tris);
