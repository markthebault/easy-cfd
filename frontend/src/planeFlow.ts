// The animated plane view: loading the resampled field from /plane,
// colouring it, and advecting tracers through it.

export type PlaneSettings = {
  playing: boolean;
  speed: number;
  tracers: number;
};

export type Header = {
  axis: "x" | "y" | "z";
  nx: number;
  ny: number;
  position: number;
  horizontal: string;
  vertical: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
  width: number;
  height: number;
  reference_speed: number;
  fields: { name: string; min: number; max: number }[];
};
export type Plane = {
  header: Header;
  fields: Record<string, Float32Array>;
  valid: Uint8Array;
};

const cache = new Map<string, Promise<Plane>>();
export function load(url: string) {
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error("Could not load visualization data.");
          return r.arrayBuffer();
        })
        .then(parse)
        .catch((e) => {
          cache.delete(url);
          throw e;
        }),
    );
  return cache.get(url)!;
}

function parse(buffer: ArrayBuffer): Plane {
  const view = new DataView(buffer);
  if (new TextDecoder().decode(buffer.slice(0, 4)) !== "ECFP")
    throw new Error("Could not load visualization data.");
  const size = view.getUint32(4, true);
  const header: Header = JSON.parse(
    new TextDecoder().decode(buffer.slice(8, 8 + size)),
  );
  const count = header.nx * header.ny;
  let offset = 8 + size;
  const fields: Record<string, Float32Array> = {};
  for (const f of header.fields) {
    const raw = new Int16Array(buffer.slice(offset, offset + 2 * count));
    const out = new Float32Array(count);
    const scale = (f.max - f.min) / 65534;
    for (let i = 0; i < count; i++) out[i] = (raw[i] + 32767) * scale + f.min;
    fields[f.name] = out;
    offset += 2 * count;
  }
  return {
    header,
    fields,
    valid: new Uint8Array(buffer.slice(offset, offset + count)),
  };
}

// Same stops as the 3D colour scale, so both views read alike.
const STOPS = [
  [0.12, 0.29, 0.64],
  [0.15, 0.73, 0.75],
  [0.98, 0.83, 0.34],
  [0.88, 0.22, 0.12],
];
function ramp(t: number) {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x)),
    f = x - i;
  return STOPS[i].map((a, k) => 255 * (a + (STOPS[i + 1][k] - a) * f));
}

// The field as one pixel per grid point, top row first as canvases expect.
// Points without fluid data (the car) stay transparent.
export function paint(
  plane: Plane,
  values: Float32Array,
  low: number,
  high: number,
) {
  const { nx, ny } = plane.header;
  const image = new ImageData(nx, ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i,
        p = ((ny - 1 - j) * nx + i) * 4;
      if (!plane.valid[k]) continue;
      const c = ramp((values[k] - low) / (high - low || 1));
      image.data[p] = c[0];
      image.data[p + 1] = c[1];
      image.data[p + 2] = c[2];
      image.data[p + 3] = 255;
    }
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

// A seeded generator, so paired views start from identical tracer positions.
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tracers advected with bilinear velocity, restarted when they age out, leave
// the plane, or reach a point without fluid data (the car).
export class Tracers {
  private px: Float32Array;
  private py: Float32Array;
  private age: Uint16Array;
  private life: Uint16Array;
  private next = random(1729);
  constructor(
    private plane: Plane,
    private count: number,
  ) {
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.age = new Uint16Array(count);
    this.life = new Uint16Array(count);
    for (let n = 0; n < count; n++) {
      this.spawn(n);
      this.age[n] = this.next() * this.life[n];
    }
  }
  private spawn(n: number) {
    const { nx, ny } = this.plane.header;
    for (let tries = 0; tries < 30; tries++) {
      const i = this.next() * (nx - 1),
        j = this.next() * (ny - 1);
      if (this.plane.valid[Math.round(j) * nx + Math.round(i)]) {
        this.px[n] = i;
        this.py[n] = j;
        break;
      }
    }
    this.age[n] = 0;
    this.life[n] = 40 + this.next() * 110;
  }
  private sample(i: number, j: number) {
    const { nx, ny } = this.plane.header,
      valid = this.plane.valid;
    const i0 = Math.floor(i),
      j0 = Math.floor(j);
    if (i0 < 0 || j0 < 0 || i0 >= nx - 1 || j0 >= ny - 1) return null;
    const k = j0 * nx + i0;
    if (!valid[k] || !valid[k + 1] || !valid[k + nx] || !valid[k + nx + 1])
      return null;
    const fi = i - i0,
      fj = j - j0;
    const mix = (a: Float32Array) =>
      (a[k] * (1 - fi) + a[k + 1] * fi) * (1 - fj) +
      (a[k + nx] * (1 - fi) + a[k + nx + 1] * fi) * fj;
    return [mix(this.plane.fields.u), mix(this.plane.fields.v)];
  }
  // Move every tracer by `dt` seconds of flow; `segment` draws each move in
  // grid coordinates.
  step(
    dt: number,
    segment: (a: number, b: number, c: number, d: number) => void,
  ) {
    const { nx, ny, width, height } = this.plane.header;
    const cells = (nx - 1) / width,
      rows = (ny - 1) / height;
    for (let n = 0; n < this.count; n++) {
      const x = this.px[n],
        y = this.py[n];
      const velocity = this.sample(x, y);
      // sample() is null off the plane or next to the car.
      if (!velocity || ++this.age[n] > this.life[n]) {
        this.spawn(n);
        continue;
      }
      // Midpoint integration follows curved flow more smoothly than Euler steps.
      const midpoint = this.sample(
        x + velocity[0] * dt * cells * 0.5,
        y + velocity[1] * dt * rows * 0.5,
      );
      if (!midpoint) {
        this.spawn(n);
        continue;
      }
      const i = x + midpoint[0] * dt * cells,
        j = y + midpoint[1] * dt * rows;
      if (!this.sample(i, j)) {
        this.spawn(n);
        continue;
      }
      segment(x, y, i, j);
      this.px[n] = i;
      this.py[n] = j;
    }
  }
}

// Flow time per animation second: at 1x, air at the free-stream speed
// crosses `metres` of view in about 6 s. Relative speeds stay true.
export const flowSeconds = (
  metres: number,
  header: Header,
  settings: PlaneSettings,
  elapsedMs: number,
) =>
  ((metres / header.reference_speed / 6) * settings.speed * elapsedMs) / 1000;

export const NOTE =
  "Tracers follow the average in-plane velocity. Motion is scaled, and flow through the plane is not shown.";
