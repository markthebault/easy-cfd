import * as T from 'three';
import { applyPressureColors, carGeometry, clayMaterial, pressureMaterial, pressureCoefficients } from '../viz/car';
import { traceOverview, tubeGeometry, streamlineMaterial } from '../viz/streamlines';
import { createFieldGPU, disposeFieldGPU } from '../viz/field';
import { Particles } from '../viz/particles';
import type { CfdData } from './cfd';
import type { AeroWeights } from './aeroMap';
import { mapPressureMaterial } from './mapPressure';

export type FlowMode = 'streamlines' | 'smoke' | 'off';

/** Identical float32 solver data and drawing algorithms to the main wind-tunnel workspace. */
export class CfdCar {
  readonly group = new T.Group();
  readonly solverFrame = new T.Group();
  readonly tireBottom: number;
  readonly wheelbase: number;
  readonly streamMesh: T.Mesh;
  readonly smoke: Particles | null;
  private weights = new T.Vector4(1, 0, 0, 0);
  private mapGPU: ReturnType<typeof createFieldGPU>[] = [];
  private cpAttributes: T.BufferAttribute[][] = [];
  private activeIndices = '';
  private streamWorker: Worker | null = null;
  private streamBusy = false;
  private streamKey = '';
  private requestedStreamKey = '';
  private lastTraceAt = -Infinity;
  private fieldGPU: ReturnType<typeof createFieldGPU> | null = null;
  private surfaces: { mesh: T.Mesh; clay: T.Material; pressure: T.Material; hasPressure: boolean }[] = [];
  private streamMat = streamlineMaterial();
  private time = 0;
  private warmed = false;
  readonly streamPointCount: number;

  constructor(renderer: T.WebGLRenderer, readonly data: CfdData) {
    const { manifest, field } = data;
    // CFD: nose -X, +Z up. Track/car frame: nose -Z, +Y up. Rigid transform only.
    this.solverFrame.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(
      new T.Vector3(0, 0, 1), new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0),
    ));
    const wheelCenters = data.parts.flatMap(p => p.info.wheel ? [p.info.wheel.center[0]] : []);
    const front = wheelCenters.length ? Math.min(...wheelCenters) : manifest.bounds.low[0] * .6;
    const rear = wheelCenters.length ? Math.max(...wheelCenters) : manifest.bounds.high[0] * .6;
    this.wheelbase = rear - front;
    this.solverFrame.position.z = -(front + rear) / 2;
    this.group.add(this.solverFrame);
    let bottom = Infinity;
    for (const p of data.parts) {
      if (p.info.role === 'wheel') for (let i = 2; i < p.positions.length; i += 3) bottom = Math.min(bottom, p.positions[i]);
      // carGeometry and applyPressureColors preserve the same creases, welds and Cp treatment.
      const geometry = carGeometry(p.positions).clone();
      const color = applyPressureColors(p.positions, p.cp, manifest.cpRange);
      if (color) geometry.setAttribute('color', color);
      const clay = clayMaterial(p.info.role), pressure = data.map ? mapPressureMaterial(this.weights, manifest.cpRange) : pressureMaterial();
      if (data.map) {
        const partIndex = data.parts.indexOf(p);
        const attrs = data.map.samples.map(s => new T.BufferAttribute(pressureCoefficients(p.positions, s.cp[partIndex])!, 1));
        this.cpAttributes.push(attrs);
        for (let k = 0; k < 4; k++) geometry.setAttribute(`aCp${k}`, attrs[0]);
      }
      const mesh = new T.Mesh(geometry, pressure); mesh.name = p.info.id; mesh.castShadow = true;
      this.solverFrame.add(mesh); this.surfaces.push({ mesh, clay, pressure, hasPressure: p.cp.some(Number.isFinite) });
    }
    this.tireBottom = Number.isFinite(bottom) ? bottom : manifest.bounds.low[2];
    const low = manifest.bounds.low, high = manifest.bounds.high, L = field.length;
    const lines = traceOverview(field, {
      center: new T.Vector3(low[0] - L * .22, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2),
      length: (high[2] - low[2]) * 1.35, count: 48, orientation: 'vertical',
    }, manifest.bounds);
    this.streamPointCount = lines.reduce((n, l) => n + l.speed.length, 0);
    this.streamMesh = new T.Mesh(tubeGeometry(lines, L * .0015), this.streamMat);
    this.streamMesh.name = 'OpenFOAM streamlines'; this.streamMesh.renderOrder = 4;
    this.streamMat.uniforms.uSpeedMax.value = data.map?.manifest.speedMax ?? manifest.speedMax;
    this.streamMat.uniforms.uShading.value = .15;
    this.solverFrame.add(this.streamMesh);
    let smoke: Particles | null = null;
    try {
      if (data.map) this.mapGPU = data.map.samples.map(s => createFieldGPU(s.field));
      this.fieldGPU = this.mapGPU[0] ?? createFieldGPU(field);
      smoke = new Particles(renderer, { size: 20, mode: 0 });
      smoke.setField(this.fieldGPU, field.freestream);
      smoke.setRake(new T.Vector3(field.origin[0] + .15, 0, .95), 2.8, 1.65, .42);
      smoke.timeScale = .12; smoke.setLife(7);
      smoke.setHistory(true);
      smoke.uniforms.uContrast.value = false;
      smoke.uniforms.uRelativeColour.value = true;
      smoke.uniforms.uTrail.value = .45;
      smoke.mesh.material.blending = T.NormalBlending;
      smoke.uniforms.uSpeedMax.value = data.map?.manifest.speedMax ?? manifest.speedMax;
      smoke.uniforms.uOpacity.value = .7;
      smoke.uniforms.uWidth.value = 1.4;
      smoke.mesh.visible = false;
      this.solverFrame.add(smoke.mesh);
    } catch { /* Computed streamlines remain available without float render-target support. */ }
    this.smoke = smoke;
    if (data.map) {
      this.streamWorker = new Worker(new URL('./mapStreams.worker.ts', import.meta.url), { type: 'module' });
      const zero = new Float32Array(field.u.length);
      this.streamWorker.postMessage({ type: 'init', fields: data.map.samples.map(s => ({ ...s.field, p: zero, k: zero })), bounds: manifest.bounds });
      this.streamWorker.onmessage = ({ data: result }) => {
        this.streamBusy = false;
        if (result.key !== this.requestedStreamKey) return;
        const geometry = new T.BufferGeometry();
        for (const [name, a] of Object.entries(result.arrays) as [string, { array: Float32Array; size: number }][]) geometry.setAttribute(name, new T.BufferAttribute(a.array, a.size));
        geometry.setIndex(new T.BufferAttribute(result.index, 1)); geometry.computeBoundingSphere();
        this.streamMesh.geometry.dispose(); this.streamMesh.geometry = geometry; this.streamKey = result.key;
      };
      this.streamWorker.onerror = () => { this.streamBusy = false; this.streamMesh.visible = false; };
    }
  }
  update(dt: number, camera: T.Camera, pressure: boolean, mode: FlowMode, playbackRate: number, operating?: AeroWeights, relativeAirSpeed?: number) {
    if (operating && this.data.map) {
      this.weights.fromArray(operating.weights);
      const key = operating.indices.join(',');
      if (key !== this.activeIndices) {
        this.surfaces.forEach((s, j) => { for (let k = 0; k < 4; k++) s.mesh.geometry.setAttribute(`aCp${k}`, this.cpAttributes[j][operating.indices[k]]); });
        this.activeIndices = key;
      }
      const fields = operating.indices.map(i => this.mapGPU[i]);
      if (this.smoke && fields.every(Boolean)) this.smoke.setOperatingFields(fields, operating.weights, operating.indices.reduce((v, i, j) => v + operating.weights[j] * this.data.map!.samples[i].info.freestream, 0));
      const streamKey = key + ':' + operating.weights.map(w => Math.round(w * 1000)).join(',');
      if (mode === 'streamlines' && this.streamWorker && !this.streamBusy && streamKey !== this.streamKey && performance.now() - this.lastTraceAt > 500) {
        this.streamBusy = true; this.lastTraceAt = performance.now(); this.requestedStreamKey = streamKey;
        this.streamWorker.postMessage({ indices: operating.indices, weights: operating.weights, key: streamKey });
      }
    }
    for (const p of this.surfaces) p.mesh.material = pressure && p.hasPressure ? p.pressure : p.clay;
    this.streamMesh.visible = mode === 'streamlines';
    const referenceScale = !this.data.map && relativeAirSpeed !== undefined ? relativeAirSpeed / Math.max(.1, this.data.field.freestream) : 1;
    // Time of flight is calculated by traceOverview from the actual solver velocity.
    // Playback is slowed by the main workspace's 0.05 time scale. No synthetic corner forces.
    this.time += dt * playbackRate * referenceScale * .05 / this.streamMat.uniforms.uPulse.value;
    this.streamMat.uniforms.uTime.value = this.time % 1000;
    if (this.smoke) {
      this.smoke.mesh.visible = mode === 'smoke';
      if (!this.warmed && this.smoke.mesh.visible) {
        // Start with an established dye distribution, advected through the current computed field.
        // Only tracer ages advance here; neither the car timeline nor CFD values are changed.
        this.smoke.playing = true;
        for (let i = 0; i < 120; i++) this.smoke.step(.05, camera);
        this.warmed = true;
      }
      this.smoke.playing = dt > 0;
      if (dt <= 0) this.smoke.step(0, camera);
      else {
        let remaining = dt * playbackRate * referenceScale;
        while (remaining > 1e-8) { const step = Math.min(.05, remaining); this.smoke.step(step, camera); remaining -= step; }
      }
    }
  }
  dispose() {
    this.streamWorker?.terminate();
    this.smoke?.dispose();
    if (this.mapGPU.length) this.mapGPU.forEach(disposeFieldGPU); else disposeFieldGPU(this.fieldGPU);
    this.streamMesh.geometry.dispose(); this.streamMat.dispose();
    this.surfaces.forEach(p => { p.mesh.geometry.dispose(); p.clay.dispose(); p.pressure.dispose(); });
  }
}
