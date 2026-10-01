// Persisted shapes (IndexedDB) and the in-memory view of a loaded run.

import type { ImportOptions, Part } from "../geometry/model";
import type { SurfaceSample, VizField } from "../solver/extract";
import type { RunResult, Settings, TyreLoads, Vec3, VehicleWeight } from "../solver/types";

export interface FileRef {
  /** SHA-256 of the bytes; key in the `files` store. */
  hash: string;
  name: string;
  base: boolean;
  size: number;
}

export type SourceRef = { kind: "sample"; wing: boolean } | { kind: "files"; files: FileRef[] };

/** User choices per part, keyed by `file::name` so they survive re-imports. */
export interface PartOverride {
  enabled?: boolean;
  role?: "body" | "wheel";
  radius?: number;
  /** Group id; unset means the automatic group. */
  group?: string;
}

/** A named set of parts that is switched on and off together (e.g. one rear-wing version). */
export interface PartGroup {
  id: string;
  name: string;
  enabled: boolean;
  /** Finer cells around the group's parts: auto (thin or small parts, default), always, off. */
  detail?: "auto" | "always" | "off";
}

export interface DesignDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: SourceRef;
  importOptions: ImportOptions;
  overrides: Record<string, PartOverride>;
  /** Group names and switches; automatic groups appear here once the user changes them. */
  groups?: PartGroup[];
  settings: Settings;
}

export interface GeometrySummary {
  dimensions: Vec3;
  triangles: number;
  frontalArea: number;
  parts: { key: string; name: string; role: "body" | "wheel"; enabled: boolean; triangles: number; radius: number | null; group?: string }[];
  /** Groups and whether each was simulated. */
  groups?: { id: string; name: string; enabled: boolean; parts: number }[];
}

export interface RunDoc {
  /** Editable weight assessment; original CFD settings and results remain unchanged. */
  tyreLoadAssessment?: { version: "steady-axle-loads-1"; assessedAt: number; inputs: VehicleWeight; loads?: TyreLoads };
  id: string;
  designId: string;
  designName: string;
  createdAt: number;
  settings: Settings;
  source: SourceRef;
  importOptions: ImportOptions;
  overrides: Record<string, PartOverride>;
  groups?: PartGroup[];
  geometry: GeometrySummary;
  result: RunResult;
  adapter: string;
  hasField: boolean;
}

/** Int16 quantisation between min and max; -32768 marks NaN (no data). */
export interface Quantized {
  min: number;
  max: number;
  data: Int16Array;
}

export interface EncodedField {
  origin: Vec3;
  spacing: Vec3;
  dims: [number, number, number];
  freestream: number;
  inlet: Vec3;
  length: number;
  u: Quantized;
  v: Quantized;
  w: Quantized;
  p: Quantized;
  k: Quantized;
  solid: Uint8Array;
}

export interface FieldDoc {
  id: string;
  field: EncodedField;
  /** One entry per enabled part, in solver order. */
  surface: { key: string; cp: Quantized; shear: Quantized; version?: 2; wallStress?: Float32Array; stressValid?: Uint8Array; snapshot?: SurfaceSample["snapshot"] }[];
}

export interface FileDoc {
  hash: string;
  name: string;
  bytes: ArrayBuffer;
}

/** Colour ranges fixed per result (and merged across a comparison). */
export interface Ranges {
  friction?: [number, number];
  cf?: [number, number];
  speed: [number, number];
  pressure: [number, number];
  cp: [number, number];
  k: [number, number];
  cp0: [number, number];
  q: number;
  density: number;
}

export interface LoadedRun {
  doc: RunDoc;
  parts: Part[];
  field: VizField | null;
  surface: (SurfaceSample | null)[] | null;
  ranges: Ranges;
  notice?: string;
}
