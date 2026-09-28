// Compact storage for fields: Int16 quantisation per array (≈ 1/30 000 of the range, far below
// what a colour map can show), NaN preserved as a sentinel.

import type { SurfaceSample, VizField } from "../solver/extract";
import type { EncodedField, FieldDoc, Quantized } from "./types";

const NAN = -32768;

export function quantize(a: Float32Array): Quantized {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v === v) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) min = max = 0;
  const data = new Int16Array(a.length);
  const scale = max > min ? 65534 / (max - min) : 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    data[i] = v === v ? Math.round((v - min) * scale) - 32767 : NAN;
  }
  return { min, max, data };
}

export function dequantize(q: Quantized): Float32Array {
  const out = new Float32Array(q.data.length);
  const scale = (q.max - q.min) / 65534;
  for (let i = 0; i < out.length; i++) {
    const d = q.data[i];
    out[i] = d === NAN ? NaN : (d + 32767) * scale + q.min;
  }
  return out;
}

export function encodeField(f: VizField): EncodedField {
  return {
    origin: f.origin, spacing: f.spacing, dims: f.dims, freestream: f.freestream, inlet: f.inlet, length: f.length,
    u: quantize(f.u), v: quantize(f.v), w: quantize(f.w), p: quantize(f.p), k: quantize(f.k), solid: f.solid,
  };
}

export function decodeField(e: EncodedField): VizField {
  return {
    origin: e.origin, spacing: e.spacing, dims: e.dims, freestream: e.freestream, inlet: e.inlet, length: e.length,
    u: dequantize(e.u), v: dequantize(e.v), w: dequantize(e.w), p: dequantize(e.p), k: dequantize(e.k), solid: e.solid,
  };
}

export function encodeSurface(keys: string[], s: SurfaceSample[]): FieldDoc["surface"] {
  return s.map((x, i) => ({ key: keys[i], cp: quantize(x.cp), shear: quantize(x.shear) }));
}

export function decodeSurface(s: FieldDoc["surface"]): SurfaceSample[] {
  return s.map((x) => ({ cp: dequantize(x.cp), shear: dequantize(x.shear) }));
}
