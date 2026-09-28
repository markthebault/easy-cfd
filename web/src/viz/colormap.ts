// Colour maps shared by the 3D layers and the HTML legends. Lightness changes monotonically in the
// sequential maps; the diverging map has a neutral grey midpoint (Cp = 0 reads as "nothing").

import * as THREE from "three";

export type MapName = "speed" | "diverging" | "loss" | "turbulence";

const STOPS: Record<MapName, string[]> = {
  // Slow indigo → teal → warm yellow (fast). Visible on both the dark and light stage.
  speed: ["#2d1e6b", "#2b4fa6", "#1f86b8", "#1fb3a3", "#6bd07a", "#d6e45a", "#fff3a6"],
  // Suction blue ↔ grey ↔ stagnation red.
  diverging: ["#104281", "#2a78d6", "#86b6ef", "#dcdad5", "#f2a488", "#e34948", "#8f1d1d"],
  // Total-pressure coefficient: losses dark violet/red, free-stream pale.
  loss: ["#1b0c41", "#4f0f6f", "#8c2369", "#c73e4c", "#ef7a2f", "#fbc05a", "#fdf2c4"],
  // Turbulent kinetic energy: dark → orange → cream.
  turbulence: ["#1d0f08", "#5a200a", "#a2400f", "#eb6834", "#f7a86b", "#fde2c2"],
};

const parse = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

const PARSED = Object.fromEntries(Object.entries(STOPS).map(([k, v]) => [k, v.map(parse)])) as Record<MapName, [number, number, number][]>;

/** sRGB colour at t ∈ [0, 1]. */
export function sample(map: MapName, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const s = PARSED[map];
  const x = Math.min(1, Math.max(0, t)) * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(x));
  const f = x - i;
  for (let c = 0; c < 3; c++) out[c] = s[i][c] + (s[i + 1][c] - s[i][c]) * f;
  return out;
}

export function cssGradient(map: MapName, direction = "to right"): string {
  return `linear-gradient(${direction}, ${STOPS[map].join(", ")})`;
}

const textures = new Map<MapName, THREE.DataTexture>();

/** 256×1 lookup texture (sRGB) for shaders. */
export function mapTexture(map: MapName): THREE.DataTexture {
  let t = textures.get(map);
  if (t) return t;
  const data = new Uint8Array(256 * 4);
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    sample(map, i / 255, c);
    data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
  }
  t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  textures.set(map, t);
  return t;
}

/** Convert an sRGB triple to linear (three.js vertex colours are linear). */
export function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
