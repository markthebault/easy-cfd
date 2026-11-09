export type Case = { shape: number; panels: number; re: number; dt: number; angle: number };
export type Frame = { type: 'frame'; particles: Float32Array; bodies: Float32Array; stats: number[]; elapsed: number; running: boolean };
export type Message = Frame | { type: 'error'; error: string } | { type: 'ready' };
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
}
