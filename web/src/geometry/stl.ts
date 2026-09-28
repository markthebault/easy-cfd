// STL reader (binary and ASCII). Returns a flat triangle soup, 9 floats per triangle.

export function parseSTL(data: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(data);
  if (bytes.length >= 84) {
    const view = new DataView(data);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.length) return parseBinary(view, count);
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (head.startsWith("solid")) {
    const ascii = parseASCII(new TextDecoder().decode(bytes));
    if (ascii.length) return ascii;
  }
  if (bytes.length >= 84) {
    const view = new DataView(data);
    const count = Math.floor((bytes.length - 84) / 50);
    return parseBinary(view, count);
  }
  throw new Error("Not a readable STL file.");
}

function parseBinary(view: DataView, count: number): Float32Array {
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12;
    for (let v = 0; v < 9; v++) out[t * 9 + v] = view.getFloat32(o + v * 4, true);
  }
  return out;
}

function parseASCII(text: string): Float32Array {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) values.push(+m[1], +m[2], +m[3]);
  return new Float32Array(values.slice(0, values.length - (values.length % 9)));
}

export function writeSTL(positions: Float32Array, name = "easycfd"): ArrayBuffer {
  const count = positions.length / 9;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode(name.slice(0, 79));
  new Uint8Array(buf, 0, header.length).set(header);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    const p = positions.subarray(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    for (let v = 0; v < 9; v++) view.setFloat32(o + 12 + v * 4, p[v], true);
  }
  return buf;
}
