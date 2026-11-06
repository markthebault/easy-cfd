import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CfdCar, type FlowMode } from './CfdCar';
import type { CfdData } from './cfd';
import { TrackEnvironment, makeSky } from './environment';
import { TrackPath } from './trackPath';
import type { TerrainInput } from './terrain';
import { type Setup, type solve } from './physics';
import { airConditions, mapWeights, type Wind, type AeroWeights, type AeroLoads } from './aeroMap';
import { lateralCapacity, vehicleLoads, type VehicleAero } from './vehicleAero';

export interface TrackState { paused: boolean; free: boolean; pressure: boolean; flow: FlowMode; rate: number; wind: Wind; setup: Setup; aero: VehicleAero; baseAero: VehicleAero; result: ReturnType<typeof solve> }
export interface Telemetry { speed: number; g: number; down: number; elapsed: number; index: number; progress: number; airSpeed: number; airYaw: number; slip: number; covered: boolean; samples: string[]; weights: number[]; loads: AeroLoads | null; lateralN: number; baseLateralN: number; lateralG: number; lateralGainG: number }

export class TrackStage {
  readonly scene = new T.Scene();
  readonly renderer: T.WebGLRenderer;
  readonly camera = new T.PerspectiveCamera(48, 1, .05, 6000);
  readonly controls: OrbitControls;
  readonly path: TrackPath;
  readonly environment: TrackEnvironment;
  readonly car: CfdCar;
  private resize: ResizeObserver;
  private environmentMap: T.WebGLRenderTarget;
  private sky = makeSky();
  private sun = new T.DirectionalLight(0xfff2de, 2.3);
  private frame = 0;
  private previous = performance.now();
  private elapsed = 0;
  private lastDistance = 0;
  private wasFree = false;
  private lastUI = 0;
  private initializedCamera = false;
  private timelineResult: TrackState['result'] | null = null;
  private timeKey: TrackState['result'] | null = null;
  private times: number[] = [];
  private timelineKey = '';
  private timeline: { speed: number; air: ReturnType<typeof airConditions>; blend?: AeroWeights }[] = [];
  private keyboard = new Set<string>();
  private travel = new T.Vector3();
  private right = new T.Vector3();
  private keyDown = (e: KeyboardEvent) => { if (!(e.target as HTMLElement).matches('input,select,textarea') && this.readState().free && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) { this.keyboard.add(e.code); e.preventDefault(); } };
  private keyUp = (e: KeyboardEvent) => this.keyboard.delete(e.code);
  private blur = () => this.keyboard.clear();

  constructor(private host: HTMLElement, points: T.Vector3[], cfd: CfdData, private readState: () => TrackState, private onTelemetry: (t: Telemetry) => void, terrain?: TerrainInput) {
    this.path = new TrackPath(points);
    this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = T.NeutralToneMapping;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', '3D track and OpenFOAM airflow');
    host.appendChild(this.renderer.domElement);
    // The main workspace uses Z-up globally; set this camera explicitly before creating controls.
    this.camera.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .09;
    this.controls.minDistance = .5;
    this.controls.maxDistance = 1800;
    this.controls.maxPolarAngle = Math.PI;
    this.scene.add(this.sky);
    this.scene.fog = new T.Fog(0xb0c8d6, 650, 3800);
    const pmrem = new T.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.environmentMap = pmrem.fromScene(room, .04);
    this.scene.environment = this.environmentMap.texture;
    this.scene.environmentIntensity = .65;
    room.dispose(); pmrem.dispose();
    this.scene.add(new T.HemisphereLight(0xebf5ff, 0x596443, 1));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -8;
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 8;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 130;
    this.sun.shadow.bias = -.00015; this.sun.shadow.normalBias = .01;
    this.scene.add(this.sun, this.sun.target);
    this.environment = new TrackEnvironment(this.path, terrain);
    this.scene.add(this.environment.group);
    this.car = new CfdCar(this.renderer, cfd);
    this.scene.add(this.car.group);
    this.resize = new ResizeObserver(() => {
      this.camera.aspect = host.clientWidth / host.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(host.clientWidth, host.clientHeight);
    });
    this.resize.observe(host);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    this.frame = requestAnimationFrame(this.animate);
  }
  seek(fraction: number) { this.elapsed = T.MathUtils.clamp(fraction, 0, .999999) * this.readState().result.lap; }
  private animate = (now: number) => {
    this.frame = requestAnimationFrame(this.animate);
    const dt = Math.min(.1, Math.max(0, (now - this.previous) / 1000)); this.previous = now;
    const state = this.readState(), r = state.result;
    if (this.timeKey !== r) {
      const previousResult = this.timeKey;
      this.timeKey = r; this.times = [0]; r.time.forEach(t => this.times.push(this.times.at(-1)! + t));
      if (previousResult) {
        let station = 0;
        while (station < r.time.length - 1 && this.path.distances[station + 1] <= this.lastDistance) station++;
        this.elapsed = this.times[station] + (this.lastDistance - this.path.distances[station]) / r.ds[station] * r.time[station];
      }
    }
    if (!state.paused) this.elapsed += dt * state.rate;
    this.elapsed %= r.lap;
    let lo = 0, hi = r.time.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (this.times[mid] <= this.elapsed) lo = mid; else hi = mid; }
    const i = lo, fraction = (this.elapsed - this.times[i]) / r.time[i];
    const distance = this.path.distances[i] + fraction * r.ds[i];
    this.lastDistance = distance;
    // Bake the operating conditions at every track sample when setup/wind changes, not every frame.
    const timelineKey = state.wind.speed + ':' + state.wind.bearing;
    if (this.timelineKey !== timelineKey || this.timeline.length !== r.speed.length || this.timelineResult !== r) {
      this.timelineKey = timelineKey; this.timelineResult = r;
      this.timeline = r.speed.map((speed, j) => {
        const air = airConditions(speed, r.forward[j], r.signedCurvature[j], state.aero.wheelbase / 2, state.wind);
        return { speed, air, blend: this.car.data.map ? mapWeights(this.car.data.map.manifest, air.speedKmh, air.yawDeg) : undefined };
      });
    }
    const a = this.timeline[i], b = this.timeline[(i + 1) % this.timeline.length];
    const v = T.MathUtils.lerp(a.speed, b.speed, fraction);
    const air = {
      speedKmh: T.MathUtils.lerp(a.air.speedKmh, b.air.speedKmh, fraction),
      relativeSpeedKmh: T.MathUtils.lerp(a.air.relativeSpeedKmh, b.air.relativeSpeedKmh, fraction),
      yawDeg: T.MathUtils.lerp(a.air.yawDeg, b.air.yawDeg, fraction),
      slipRad: T.MathUtils.lerp(a.air.slipRad, b.air.slipRad, fraction),
    };
    const operating = this.car.data.map ? mapWeights(this.car.data.map.manifest, air.speedKmh, air.yawDeg) : undefined;
    const pose = this.path.pose(distance, this.car.wheelbase, this.car.tireBottom);
    // The body heading differs from the CG velocity direction by the bicycle-model sideslip.
    pose.quaternion.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), -air.slipRad));
    this.car.group.position.copy(pose.position);
    this.car.group.quaternion.copy(pose.quaternion);
    const target = pose.position.clone().addScaledVector(pose.up, .7);
    if (!state.free || !this.initializedCamera) {
      const behind = pose.position.clone().addScaledVector(pose.forward, -9.5).add(new T.Vector3(0, 3.4, 0));
      const a = !this.initializedCamera || this.wasFree ? 1 : 1 - Math.exp(-7 * dt);
      this.camera.position.lerp(behind, a);
      this.controls.target.copy(target);
      this.initializedCamera = true;
    } else if (!this.wasFree) this.controls.target.copy(target);
    this.controls.enabled = state.free;
    if (state.free && this.keyboard.size) {
      this.camera.getWorldDirection(this.travel);
      this.right.crossVectors(this.travel, this.camera.up).normalize();
      const delta = new T.Vector3();
      if (this.keyboard.has('KeyW')) delta.add(this.travel);
      if (this.keyboard.has('KeyS')) delta.sub(this.travel);
      if (this.keyboard.has('KeyD')) delta.add(this.right);
      if (this.keyboard.has('KeyA')) delta.sub(this.right);
      if (this.keyboard.has('KeyE')) delta.y += 1;
      if (this.keyboard.has('KeyQ')) delta.y -= 1;
      delta.normalize().multiplyScalar(dt * 6);
      this.camera.position.add(delta); this.controls.target.add(delta);
    }
    this.controls.update(dt);
    this.wasFree = state.free;
    this.environment.update(this.camera, pose.position, pose.up, dt);
    this.sun.position.copy(pose.position).add(new T.Vector3(-35, 60, -35));
    this.sun.target.position.copy(pose.position);
    this.car.update(state.paused ? 0 : dt, this.camera, state.pressure, state.flow, state.rate, operating, air.relativeSpeedKmh / 3.6);
    this.renderer.render(this.scene, this.camera);
    if (now - this.lastUI > 100) {
      // Reconstruct full relative speed from the same speed/yaw pair used by the displayed map.
      const currentAir = { ...air, relativeSpeedKmh: air.speedKmh / Math.cos(air.yawDeg * Math.PI / 180) };
      const current = vehicleLoads(state.aero, currentAir), base = vehicleLoads(state.baseAero, currentAir);
      const lateralN = lateralCapacity(state.setup.grip, state.setup.mass, r.calibration, current.netLiftN);
      const baseLateralN = lateralCapacity(state.setup.grip, state.setup.mass, r.calibration, base.netLiftN);
      this.onTelemetry({ speed: v * 3.6, g: v * v * r.curvature[i] / 9.81, down: -current.netLiftN, elapsed: this.elapsed, index: i, progress: this.elapsed / r.lap, airSpeed: air.speedKmh, airYaw: air.yawDeg, slip: air.slipRad * 180 / Math.PI, covered: current.covered, samples: operating?.indices.map(j => this.car.data.map!.samples[j].info.id) ?? [], weights: operating?.weights ?? [], loads: current.covered ? current : null, lateralN, baseLateralN, lateralG: lateralN / (state.setup.mass * 9.81), lateralGainG: (lateralN - baseLateralN) / (state.setup.mass * 9.81) });
      this.lastUI = now;
    }
  };
  dispose() {
    cancelAnimationFrame(this.frame); this.resize.disconnect(); this.controls.dispose();
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur);
    this.car.dispose(); this.environment.dispose(); this.environmentMap.dispose();
    this.sky.geometry.dispose(); this.sky.material.dispose(); this.sun.shadow.dispose();
    this.renderer.dispose(); this.host.removeChild(this.renderer.domElement);
  }
}
