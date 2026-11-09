export type Case = { shape: number; panels: number; re: number; dt: number; angle: number; density: number };
export type Frame = { type: 'frame'; particles: Float32Array; bodies: Float32Array; stats: number[]; elapsed: number; running: boolean };
export type PressureField = { values: Float32Array; xmin: number; ymin: number; spacing: number; nx: number; ny: number; time: number; elapsed: number };
export type Message = Frame | { type: 'pressure'; field: PressureField } | { type: 'pressure-error'; error: string } | { type: 'error'; error: string } | { type: 'ready' };
export interface VVModule {
  HEAPF64: Float64Array;
  UTF8ToString(pointer: number): string;
  _vv_init(shape: number, panels: number, re: number, dt: number, angle: number): number;
  _vv_step(count: number): number;
  _vv_count(): number;
  _vv_particles(): number;
  _vv_body_count(): number;
  _vv_bodies(): number;
  _vv_stats(): number;
  _vv_error(): number;
  _vv_dispose(): void;
  _vv_density(density: number): number;
  _vv_pressure(xmin: number, ymin: number, spacing: number, nx: number, ny: number): number;
  _vv_pressure_data(): number;
}
