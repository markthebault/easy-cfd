// The 3D wind tunnel: renderer, camera, lighting, car and every flow layer. React drives it through
// a handful of setters; it renders on demand and only runs continuously while something moves.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { frameAt, type FlowAnimation } from "../solver/animation";
import type { VizField } from "../solver/extract";
import type { Ranges } from "../store/types";
import { applyPressureColors, applyStressColors, carGeometry, clayMaterial, pressureMaterial } from "./car";
import { createFieldGPU, disposeFieldGPU, fieldBox, type FieldGPU } from "./field";
import { detailBoxes, labelSprite, OrientationCube, road, tunnelBox, type ViewName } from "./helpers";
import { oilFlowGeometry, oilFlowMaterial } from "./oilflow";
import { Particles } from "./particles";
import { Slice, type SliceField } from "./slice";
import { streamlineMaterial, traceStreamlines, tubeGeometry } from "./streamlines";
import { totalPressureCoefficient, wakeGeometry, wakeMaterial, type WakeColor } from "./wake";
import { pressureCloudGeometry, pressureCloudMaterial, pressureCoefficients } from "./pressureCloud";
import { drivingVelocity, MOTION_TIME_SCALE, rollingAngle, type DrivingConditions } from "./driving";
import { ShapeSmokePreview } from "./previewSmoke";
import type { Axles } from "../solver/types";
import { wheelCenterOfMass } from "../geometry/centroid";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface StagePart {
  id: string;
  role: "body" | "wheel";
  enabled: boolean;
  positions: Float32Array;
  cp?: Float32Array | null;
  wallStress?: Float32Array;
  stressValid?: Uint8Array;
  stressQ?: number;
  shear?: Float32Array | null;
  wheel?: { center: [number, number, number]; radius: number } | null;
}

export interface VizSettings {
  surface: boolean;
  friction?: boolean;
  frictionUnit?: "Pa" | "Cf";
  frictionMax?: number;
  surfaceFlow: boolean;
  smoke: boolean;
  streamlines: boolean;
  slice: boolean;
  animation?: boolean;
  animationLoop?: boolean;
  wake: boolean;
  pressureCloud: boolean;
  cloudLevel: number;
  cloudOpacity: number;
  cloudSign: "both" | "positive" | "negative";
  forces: boolean;
  motion: boolean;
  windDirection: boolean;
  playing: boolean;
  flowSpeed: number;
  smokeDensity: number;
  smokeStyle: "filaments" | "sheet";
  trail: number;
  rake: { x: number; y: number; z: number; width: number; height: number };
  stream: { x: number; y: number; z: number; length: number; count: number; orientation: "vertical" | "horizontal"; animate: boolean };
  sliceAxis: 0 | 1 | 2;
  slicePos: number;
  sliceField: SliceField;
  sliceTracers: boolean;
  wakeLevel: number;
  wakeColor: WakeColor;
}

export interface ForceValues { drag: number; lift: number; side: number }

export type HandleName = "rake" | "stream" | "slice";

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

interface Handle {
  name: HandleName;
  object: THREE.Object3D;
  axis: THREE.Vector3 | null;
}

const SMOKE_SIZE = 256;
const TRACER_SIZE = 128;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private axleMarkers = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private raf = 0;
  private last = performance.now();
  private dirty = true;
  private tween: { from: CameraState; to: CameraState; t0: number; dur: number } | null = null;
  private cube = new OrientationCube();
  private dark = true;

  private carGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private handleGroup = new THREE.Group();
  private road = road();
  private wind = new ShapeSmokePreview();
  private driving: DrivingConditions | null = null;
  private roadDistance = 0;
  private windDistance = 0;
  private wheelMotion: { id: string; radius: number; center: THREE.Vector3; mesh: THREE.Mesh; distance: number; spinGeometry: boolean }[] = [];
  private shadowCatcher: THREE.Mesh;
  private sun = new THREE.DirectionalLight(0xffffff, 1.2);
  private box: THREE.Group | null = null;
  private parts: StagePart[] = [];
  private partsKey = "";
  private cpRange: [number, number] = [-1.5, 1];
  private bounds = new THREE.Box3(new THREE.Vector3(-2, -1, 0), new THREE.Vector3(2, 1, 1.4));

  private field: VizField | null = null;
  private fieldGPU: FieldGPU | null = null;
  private ranges: Ranges | null = null;
  private smoke: Particles | null = null;
  private tracers: Particles | null = null;
  private slice = new Slice();
  private streamMesh: THREE.Mesh | null = null;
  private streamMat = streamlineMaterial();
  private streamKey = "";
  private wakeMesh: THREE.Mesh | null = null;
  private wakeMat = wakeMaterial();
  private wakeKey = "";
  private cp0: Float32Array | null = null;
  private pressureCp: Float32Array | null = null;
  private clouds = new THREE.Group();
  private cloudKey = "";
  private forceGroup = new THREE.Group();
  private forceValues: ForceValues | null = null;
  private forceScale: number | undefined;
  private forceLength: number | undefined;
  private forceKey = "";
  private oilMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null = null;
  private oilMat = oilFlowMaterial();
  private oilKey = "";
  private viz: VizSettings | null = null;
  private handles: Handle[] = [];
  private drag: { handle: Handle; start: THREE.Vector3; hit: THREE.Vector3; plane: THREE.Plane } | null = null;
  private raycaster = new THREE.Raycaster();
  private streamTime = 0;
  private particleError: string | null = null;
  // Adaptive resolution: drop the pixel ratio when animated frames stay slow.
  private maxRatio = Math.min(window.devicePixelRatio, 2);
  private slowFrames = 0;
  private fastFrames = 0;

  onHandleDrag: ((name: HandleName, pos: THREE.Vector3) => void) | null = null;
  onCamera: ((s: CameraState) => void) | null = null;
  onView: ((v: ViewName) => void) | null = null;
  private syncing = false;
  gizmoInset = { right: 16, bottom: 16, size: 104 };
  /** Screen area covered by panels (CSS px); the camera centre shifts to the free area. */
  private insets = { left: 0, bottom: 0, top: 0 };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.maxRatio);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The car does not move: render its shadow only when the geometry or its look changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.className = "stage-canvas";
    container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();

    this.sun.position.set(-3, -4, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.radius = 6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.35));

    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false }));
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.position.z = 0.001;
    this.shadowCatcher.renderOrder = 0;
    this.scene.add(this.road, this.shadowCatcher, this.carGroup, this.helperGroup, this.handleGroup, this.slice.mesh, this.clouds, this.forceGroup, this.wind.group);

    // Our pointer handler is registered before OrbitControls so a handle grab can disable orbiting.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 400;
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      if (!this.syncing) this.onCamera?.(this.cameraState());
    });

    try {
      this.smoke = new Particles(this.renderer, { size: SMOKE_SIZE, mode: 0 });
      this.tracers = new Particles(this.renderer, { size: TRACER_SIZE, mode: 1 });
      this.tracers.setLife(2.2);
      this.tracers.uniforms.uMono.value = true;
      this.tracers.uniforms.uTrail.value = 0.35;
      this.scene.add(this.smoke.mesh, this.tracers.mesh);
    } catch (e) {
      this.particleError = e instanceof Error ? e.message : String(e);
    }

    this.setTheme(true);
    this.setView("iso", false);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  get particlesAvailable() {
    return this.particleError === null;
  }

  carBounds(): { low: number[]; high: number[] } {
    return { low: this.bounds.min.toArray(), high: this.bounds.max.toArray() };
  }

  // -------------------------------------------------------------------------------------------
  // Theme, size, render loop
  // -------------------------------------------------------------------------------------------

  setTheme(dark: boolean) {
    this.dark = dark;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    if (dark) {
      g.addColorStop(0, "#1a1f29");
      g.addColorStop(0.55, "#10131a");
      g.addColorStop(1, "#0b0d11");
    } else {
      g.addColorStop(0, "#f5f7fa");
      g.addColorStop(0.55, "#e9edf2");
      g.addColorStop(1, "#dfe4ea");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
    const old = this.scene.background as THREE.Texture | null;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = tex;
    old?.dispose?.();
    const u = this.road.material.uniforms;
    (u.uColor.value as THREE.Color).set(dark ? 0x12151b : 0xe3e7ec);
    (u.uLine.value as THREE.Color).set(dark ? 0x262b34 : 0xc9cfd8);
    (this.shadowCatcher.material as THREE.ShadowMaterial).opacity = dark ? 0.5 : 0.22;
    this.slice.uniforms.uSolid.value.set(dark ? 0x3a3d44 : 0x8a8f98);
    for (const p of [this.smoke, this.tracers]) {
      if (!p) continue;
      p.mesh.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.mesh.material.needsUpdate = true;
    }
    if (this.tracers) {
      (this.tracers.uniforms.uMonoColor.value as THREE.Color).set(dark ? 0xffffff : 0x111418);
      this.tracers.uniforms.uOpacity.value = dark ? 0.5 : 0.6;
    }
    this.cube.setTheme(dark);
    this.rebuildHelpers();
    this.applyViz();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    // Screen-sized labels collide on narrow screens; the road arrow alone shows the airflow there.
    this.renderer.setSize(w, h, false);
    const ratio = this.renderer.getPixelRatio();
    if (this.smoke) this.smoke.uniforms.uWidth.value = 1.5 * ratio;
    if (this.tracers) this.tracers.uniforms.uWidth.value = 1.1 * ratio;
    const { left, bottom, top } = this.insets;
    // Render a window of a larger virtual image so the car centres in the uncovered area.
    this.camera.aspect = (w + left) / (h + bottom + top);
    if (left || bottom || top) this.camera.setViewOffset(w + left, h + bottom + top, 0, bottom, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    // Keep the framing after a viewport change (rotation, window resize, panel height) unless the
    // user has moved the camera since the last automatic fit.
    if (this.lastFit && !this.tween && this.sameCamera(this.lastFit.state)) {
      const { view, fitBox, flow, forces } = this.lastFit;
      this.applyCamera(this.viewState(view, fitBox, flow, forces));
      this.lastFit.state = this.cameraState();
    }
    this.resizeForceLabels();
  }

  private lastFit: { view: ViewName; fitBox: boolean; flow: boolean; forces: boolean; state: CameraState } | null = null;

  private sameCamera(s: CameraState) {
    const c = this.cameraState();
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const scale = Math.max(1e-3, d(s.position, s.target));
    return d(c.position, s.position) < 1e-3 * scale && d(c.target, s.target) < 1e-3 * scale;
  }

  setInsets(left: number, bottom: number, top = 0) {
    if (left === this.insets.left && bottom === this.insets.bottom && top === this.insets.top) return;
    this.insets = { left, bottom, top };
    this.resize();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      const e = 1 - Math.pow(1 - t, 3);
      const { from, to } = this.tween;
      this.camera.position.set(...(from.position.map((v, i) => v + (to.position[i] - v) * e) as [number, number, number]));
      this.controls.target.set(...(from.target.map((v, i) => v + (to.target[i] - v) * e) as [number, number, number]));
      if (t >= 1) this.tween = null;
      this.dirty = true;
      if (!this.syncing) this.onCamera?.(this.cameraState());
    }
    const moved = this.controls.update();
    let animate = false;
    const v = this.viz;
    if (v?.animation && this.animation && v.playing) {
      const frames = this.animation.frames, first = frames[0].time, last = frames.at(-1)!.time;
      const duration = last - first;
      this.animationClock += dt * duration / 6 * v.flowSpeed;
      if (this.animationClock > last) this.animationClock = v.animationLoop !== false ? first + (this.animationClock - first) % duration : last;
      this.updateAnimationFrame();
      animate = v.animationLoop !== false || this.animationClock < last;
      this.dirty = true;
    }
    const scale = MOTION_TIME_SCALE;
    if (v?.playing && this.driving && (v.motion || v.windDirection)) {
      const distance = dt * scale * v.flowSpeed * drivingVelocity(this.driving)[0];
      if (v.windDirection && this.wind.group.visible) {
        this.windDistance += distance;
        this.wind.material.uniforms.uDistance.value = this.windDistance;
        animate = true;
      }
      if (v.motion && this.driving.moving_ground) {
        this.roadDistance += distance;
        this.road.material.uniforms.uDistance.value = this.roadDistance;
        animate = true;
      }
      if (v.motion && this.driving.wheels) {
        for (const w of this.wheelMotion) if (w.spinGeometry) { w.distance += distance; this.rotateWheel(w); animate = true; }
      }
    }
    if (this.smoke?.mesh.visible && v) {
      this.smoke.playing = v.playing;
      this.smoke.timeScale = scale * v.flowSpeed;
      this.smoke.step(dt, this.camera);
      animate ||= v.playing;
    }
    if (this.tracers?.mesh.visible && v) {
      this.tracers.playing = v.playing;
      this.tracers.timeScale = scale * v.flowSpeed * 0.6;
      this.tracers.step(dt, this.camera);
      animate ||= v.playing;
    }
    if (this.streamMesh?.visible && v?.stream.animate && v.playing) {
      const pulse = this.streamMat.uniforms.uPulse.value as number;
      this.streamTime += (dt * scale * v.flowSpeed) / pulse;
      this.streamMat.uniforms.uTime.value = this.streamTime % 1000;
      animate = true;
    }
    if (this.oilMesh?.visible && v?.playing) {
      this.oilMat.uniforms.uTime.value = (this.oilMat.uniforms.uTime.value + dt * 0.7 * v.flowSpeed) % 1000;
      animate = true;
    }
    if (moved || animate || this.dirty) {
      this.render();
      this.dirty = false;
    }
    if (animate) this.adaptResolution(dt);
  };

  private adaptResolution(dt: number) {
    const r = this.renderer.getPixelRatio();
    if (dt > 0.019) this.slowFrames++;
    else if (dt < 0.0135) this.fastFrames++;
    if (this.slowFrames > 45 && r > 1) {
      this.renderer.setPixelRatio(Math.max(1, r - 0.25));
      this.resize();
      this.slowFrames = this.fastFrames = 0;
    } else if (this.fastFrames > 240 && r < this.maxRatio) {
      this.renderer.setPixelRatio(Math.min(this.maxRatio, r + 0.25));
      this.resize();
      this.slowFrames = this.fastFrames = 0;
    }
    if (this.slowFrames + this.fastFrames > 600) this.slowFrames = this.fastFrames = 0;
  }

  private render() {
    const r = this.renderer;
    this.wind.material.uniforms.uViewportHeight.value = r.domElement.height;
    // Clear the road from below so underbody and diffuser inspection stays unobstructed.
    const roadFade = THREE.MathUtils.smoothstep(this.camera.position.z, 0, Math.max(0.05, this.bounds.getSize(new THREE.Vector3()).z * 0.12));
    this.road.material.uniforms.uVisibility.value = roadFade;
    this.road.visible = roadFade > 0;
    this.shadowCatcher.visible = roadFade > 0;
    (this.shadowCatcher.material as THREE.ShadowMaterial).opacity = (this.dark ? 0.5 : 0.22) * roadFade;
    r.setScissorTest(false);
    r.autoClear = true;
    const size = r.getSize(new THREE.Vector2());
    r.setViewport(0, 0, size.x, size.y);
    r.render(this.scene, this.camera);
    // Orientation cube in the corner, same rotation as the main camera.
    const g = this.gizmoInset;
    if (g.size > 0) {
      this.cube.sync(this.camera, this.controls.target);
      r.autoClear = false;
      r.clearDepth();
      r.setScissorTest(true);
      r.setScissor(size.x - g.right - g.size, g.bottom, g.size, g.size);
      r.setViewport(size.x - g.right - g.size, g.bottom, g.size, g.size);
      r.render(this.cube.scene, this.cube.camera);
      r.setScissorTest(false);
      r.setViewport(0, 0, size.x, size.y);
      r.autoClear = true;
    }
  }

  requestRender() {
    this.dirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------------------------

  cameraState(): CameraState {
    return { position: this.camera.position.toArray() as CameraState["position"], target: this.controls.target.toArray() as CameraState["target"] };
  }

  applyCamera(s: CameraState) {
    this.syncing = true;
    this.tween = null;
    this.camera.position.set(...s.position);
    this.controls.target.set(...s.target);
    this.controls.update();
    this.syncing = false;
    this.dirty = true;
  }

  private viewState(view: ViewName, fitBox = false, flow = false, forces = false): CameraState {
    let b = fitBox && this.box ? new THREE.Box3().setFromObject(this.box) : this.bounds;
    if (flow) {
      // Car plus the near wake, for section planes.
      const L = this.bounds.max.x - this.bounds.min.x;
      b = this.bounds.clone();
      b.min.x -= 0.25 * L;
      b.max.x += 1.1 * L;
      b.max.z += 0.2 * L;
    }
    if (forces) {
      const s = this.bounds.getSize(new THREE.Vector3());
      b = this.bounds.clone();
      b.min.x -= s.x * 0.1;
      b.max.x += s.x * 0.15;
      b.min.y -= s.y * 0.6;
      b.max.z = Math.max(b.max.z, (this.forceLength ?? s.x) * 0.7);
    }
    const c = b.getCenter(new THREE.Vector3());
    const radius = Math.max(0.3, b.getSize(new THREE.Vector3()).length() / 2);
    // Fit into the uncovered part of the screen; the virtual image is (w + left) × (h + bottom).
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const { left, bottom, top } = this.insets;
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const visV = 2 * Math.atan((tanV * Math.max(1, h - bottom - top)) / (h + bottom + top));
    const visH = 2 * Math.atan((tanV * Math.max(1, w - left)) / (h + bottom + top));
    const D = (radius * 1.08) / Math.sin(Math.min(visV, visH) / 2);
    const target: [number, number, number] = [c.x, c.y, fitBox ? c.z * 0.5 : c.z * 0.75];
    const dir: Record<ViewName, [number, number, number]> = {
      front: [-1, 0, 0.1],
      rear: [1, 0, 0.14],
      side: [0, -1, 0.08],
      top: [0, -0.02, 1],
      bottom: [1, -1, -0.85],
      iso: [-1, -1.25, 0.55],
    };
    const d = new THREE.Vector3(...dir[view]).normalize().multiplyScalar(D);
    return { position: [target[0] + d.x, target[1] + d.y, target[2] + d.z], target };
  }

  setView(view: ViewName, animate = true, fitBox = false, flow = false, forces = false) {
    const to = this.viewState(view, fitBox, flow, forces);
    this.lastFit = { view, fitBox, flow, forces, state: to };
    if (!animate) {
      this.applyCamera(to);
      this.onCamera?.(this.cameraState());
      return;
    }
    this.tween = { from: this.cameraState(), to, t0: performance.now(), dur: 550 };
    this.onView?.(view);
  }

  // -------------------------------------------------------------------------------------------
  // Car
  // -------------------------------------------------------------------------------------------

  /** `key` identifies the geometry; meshes are rebuilt only when it changes. */
  setParts(parts: StagePart[], key: string, cpRange: [number, number] = this.cpRange) {
    const rebuild = key !== this.partsKey;
    this.parts = parts;
    this.cpRange = cpRange;
    if (rebuild) {
      this.partsKey = key;
      this.wheelMotion = [];
      for (const m of this.carGroup.children as THREE.Mesh[]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      this.carGroup.clear();
      for (const p of parts) {
        if (p.positions.length < 9) continue;
        const base = carGeometry(p.positions);
        // Own geometry object per mesh (shared attributes) so each can carry its own colours.
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", base.getAttribute("position"));
        geo.setAttribute("normal", base.getAttribute("normal"));
        geo.boundingBox = base.boundingBox;
        geo.boundingSphere = base.boundingSphere;
        const mesh = new THREE.Mesh(geo, clayMaterial(p.role));
        mesh.castShadow = true;
        mesh.userData.partId = p.id;
        this.carGroup.add(mesh);
        if (p.role === "wheel" && p.wheel && p.wheel.radius > 0) {
          const center = new THREE.Vector3(...wheelCenterOfMass(p.positions, p.wheel.center));
          this.wheelMotion.push({ id: p.id, radius: p.wheel.radius, center, mesh, distance: 0, spinGeometry: true });
        }
      }
      const enabled = parts.filter((p) => p.enabled && p.positions.length >= 9);
      if (enabled.length) {
        this.bounds.makeEmpty();
        for (const m of this.carGroup.children as THREE.Mesh[])
          if (enabled.some((p) => p.id === m.userData.partId)) this.bounds.union(m.geometry.boundingBox!);
      }
      this.fitShadow();

      this.rebuildHelpers();
    }
    this.wind.setGeometry(parts.filter(p => p.enabled && p.role === "body").map(p => p.positions));
    this.updateCarLook();
    this.applyDriving();
  }

  private fitShadow() {
    const s = this.bounds.getSize(new THREE.Vector3());
    const c = this.bounds.getCenter(new THREE.Vector3());
    const r = Math.max(s.x, s.y, 1) * 0.9;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.1;
    cam.far = 40;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(new THREE.Vector3(-0.15 * r, -0.2 * r, 12));
    this.road.material.uniforms.uFade.value = Math.max(8, s.x * 4.5);
    this.road.material.uniforms.uCell.value = s.x > 1.5 ? 0.5 : 0.1;
    this.road.material.uniforms.uRoadCenter.value = c.y;
    this.road.material.uniforms.uRoadWidth.value = Math.max(s.y * 1.55, 0.2);
    this.road.material.uniforms.uCarLength.value = Math.max(s.x, 0.1);
  }

  private updateCarLook() {
    const surface = !!this.viz?.surface;
    const ghost = !!this.viz?.slice && !!this.field;
    for (const m of this.carGroup.children as THREE.Mesh[]) {
      const p = this.parts.find((q) => q.id === m.userData.partId);
      if (!p) continue;
      const geo = m.geometry;
      const wantFriction = !!this.viz?.friction && !!p.wallStress;
      const wantCp = (surface && !!p.cp) || wantFriction;
      let mat = m.material as THREE.MeshStandardMaterial;
      if (wantCp) {
        const max = this.viz?.frictionMax ?? (this.viz?.frictionUnit === "Cf" ? this.ranges?.cf?.[1] : this.ranges?.friction?.[1]) ?? 1;
        const key = `${this.cpRange[0]}:${this.cpRange[1]}:${wantFriction}:${this.viz?.frictionUnit}:${max}`;
        if (geo.userData.cpFor !== p.cp || geo.userData.cpKey !== key) {
          const colors = wantFriction ? applyStressColors(p.wallStress!,p.stressValid,max,this.viz?.frictionUnit === "Cf" ? p.stressQ ?? 1 : 1) : applyPressureColors(p.positions, p.cp ?? null, this.cpRange);
          if (colors) geo.setAttribute("color", colors);
          geo.userData.cpFor = p.cp;
          geo.userData.cpKey = key;
        }
        if (!mat.vertexColors) {
          mat.dispose();
          mat = pressureMaterial();
          m.material = mat;
        }
      } else if (mat.vertexColors) {
        mat.dispose();
        mat = clayMaterial(p.role);
        m.material = mat;
      }
      const opacity = !p.enabled ? 0.12 : ghost ? 0.22 : 1;
      mat.transparent = opacity < 1;
      mat.opacity = opacity;
      mat.depthWrite = opacity >= 1;
      mat.needsUpdate = true;
      m.castShadow = p.enabled && opacity >= 1;
      m.renderOrder = opacity < 1 ? 6 : 0;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Helpers: orientation labels, flow arrow, tunnel box
  // -------------------------------------------------------------------------------------------

  private showHelpers = true;

  setHelpers(show: boolean) {
    this.showHelpers = show;
    this.helperGroup.visible = show;
    this.dirty = true;
  }

  private rebuildHelpers() {
    for (const o of this.helperGroup.children) {
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material & { map?: THREE.Texture };
        mat?.map?.dispose();
        mat?.dispose?.();
      });
    }
    this.helperGroup.clear();
    const b = this.bounds;
    const s = b.getSize(new THREE.Vector3());
    const L = Math.max(s.x, 0.3);
    const front = labelSprite("FRONT", this.dark ? "#0b0d11" : "#ffffff", this.dark ? "rgba(255,255,255,0.92)" : "rgba(20,24,30,0.9)", 0.018);
    front.position.set(b.min.x - 0.02 * L, (b.min.y + b.max.y) / 2, b.max.z * 0.75);
    this.helperGroup.add(front);
    this.helperGroup.visible = this.showHelpers;
  }

  private detailGroup: THREE.Group | null = null;

  setDetailBoxes(boxes: number[][] | null) {
    if (this.detailGroup) {
      this.detailGroup.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose?.();
      });
      this.scene.remove(this.detailGroup);
      this.detailGroup = null;
    }
    if (boxes?.length) {
      this.detailGroup = detailBoxes(boxes);
      this.scene.add(this.detailGroup);
    }
    this.dirty = true;
  }

  setBox(domain: number[] | null, fit = false) {
    if (this.box) {
      this.box.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose?.();
      });
      this.scene.remove(this.box);
      this.box = null;
    }
    if (domain) {
      this.box = tunnelBox(domain);
      this.scene.add(this.box);
      if (fit) this.setView("iso", true, true);
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Flow field and layers
  // -------------------------------------------------------------------------------------------

  private animation: FlowAnimation | null = null;
  private animationRanges: Ranges | null = null;
  private animationClock = 0;
  private animationIndex = -1;
  private animationGPU: [FieldGPU | null, FieldGPU | null] = [null, null];

  setAnimation(animation: FlowAnimation | null, ranges: Ranges | null) {
    if (animation !== this.animation) {
      this.clearAnimationGPU();
      this.animation = animation;
      this.animationClock = animation?.frames[0].time ?? 0;
    }
    this.animationRanges = ranges;
    this.applyViz();
  }

  animationPosition() {
    const frames = this.animation?.frames;
    if (!frames) return 0;
    return (this.animationClock - frames[0].time) / Math.max(1e-12, frames.at(-1)!.time - frames[0].time);
  }

  seekAnimation(position: number) {
    const frames = this.animation?.frames;
    if (!frames) return;
    this.animationClock = frames[0].time + Math.min(1, Math.max(0, position)) * (frames.at(-1)!.time - frames[0].time);
    this.updateAnimationFrame();
    this.requestRender();
  }

  private clearAnimationGPU() {
    this.animationGPU.forEach(disposeFieldGPU);
    this.animationGPU = [null, null];
    this.animationIndex = -1;
  }

  private updateAnimationFrame() {
    const a = this.animation;
    if (!this.viz?.animation || !a || a.frames.length < 2) return;
    const pair = frameAt(a.frames.map(f => f.time), this.animationClock);
    if (pair.index !== this.animationIndex) {
      this.clearAnimationGPU();
      this.animationIndex = pair.index;
      this.animationGPU = [createFieldGPU(a.frames[pair.index].field), createFieldGPU(a.frames[pair.index + 1].field)];
      const { min, max } = fieldBox(a.frames[0].field);
      this.slice.setField(this.animationGPU[0], min, max);
    }
    this.slice.setNextField(this.animationGPU[1], pair.mix);
  }

  setField(field: VizField | null, ranges: Ranges | null) {
    if (field !== this.field) {
      disposeFieldGPU(this.fieldGPU);
      this.field = field;
      this.fieldGPU = field ? createFieldGPU(field) : null;
      this.cp0 = null;
      this.pressureCp = null;
      this.cloudKey = "";
      this.streamKey = "";
      this.wakeKey = "";
      if (field) {
        const { min, max } = fieldBox(field);
        this.slice.setField(this.fieldGPU, min, max);
        this.smoke?.setField(this.fieldGPU, field.freestream);
        this.tracers?.setField(this.fieldGPU, field.freestream);
        // Particles cross the field box in about one life.
        this.smoke?.setLife(Math.max(6, ((max.x - min.x) / (0.3 * field.length)) * 1.05));
      } else {
        this.slice.setField(null, new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
        this.smoke?.setField(null, 1);
        this.tracers?.setField(null, 1);
      }
    }
    this.ranges = ranges;
    this.applyViz();
  }

  setViz(v: VizSettings) {
    this.viz = v;
    this.applyViz();
  }

  private applyViz() {
    const v = this.viz;
    const f = this.field;
    const r = this.ranges;
    const on = (x: boolean | undefined) => !!x && !!f && !!r;
    if (this.smoke) {
      this.smoke.mesh.visible = on(v?.smoke);
      if (v && r) {
        const spacing = v.smokeStyle === "filaments" && f ? Math.max(0.028 * f.length, Math.min(v.rake.width, v.rake.height) / 12) : 0;
        this.smoke.setRake(new THREE.Vector3(v.rake.x, v.rake.y, v.rake.z), v.rake.width, v.rake.height, spacing);
        this.smoke.uniforms.uOpacity.value = (v.smokeStyle === "filaments" ? 0.26 : 0.09) * (this.dark ? 1 : 2.2);
        this.smoke.uniforms.uSpeedMax.value = r.speed[1];
        this.smoke.uniforms.uTrail.value = v.trail;
        this.smoke.mesh.geometry.instanceCount = Math.round(SMOKE_SIZE * SMOKE_SIZE * v.smokeDensity);
      }
    }
    if (v?.animation && this.animation) this.updateAnimationFrame();
    else {
      this.clearAnimationGPU();
      this.slice.setNextField(null, 0);
      if (f) { const { min, max } = fieldBox(f); this.slice.setField(this.fieldGPU, min, max); }
    }
    this.slice.mesh.visible = on(v?.slice) && (!v?.animation || !!this.animation);
    if (v && r && f) {
      this.slice.place(v.sliceAxis, v.slicePos);
      const sr = v.animation ? this.animationRanges ?? r : r;
      const range = v.sliceField === "speed" ? sr.speed : v.sliceField === "pressure" ? sr.pressure : v.sliceField === "cp0" ? sr.cp0 : sr.k;
      this.slice.setMode(v.sliceField, range, sr.density, sr.q, v.animation);
    }
    if (this.tracers) {
      this.tracers.mesh.visible = on(v?.slice && v.sliceTracers);
      if (v && f && this.tracers.mesh.visible) {
        const { min, max } = fieldBox(f);
        this.tracers.setPlane(v.sliceAxis, this.slice.pos, min, max);
      }
    }
    this.updateStreamlines();
    this.updateWake();
    this.updatePressureCloud();
    this.updateForces();
    this.updateOilFlow();
    this.updateHandles();
    this.updateCarLook();
    this.applyDriving();
    this.dirty = true;
  }

  frictionScale(unit?: "Pa" | "Cf") { return (unit === "Cf" ? this.ranges?.cf?.[1] : this.ranges?.friction?.[1]) ?? (unit === "Cf" ? .01 : 5); }

  setAxles(axles: Axles | undefined) {
    this.clearGroup(this.axleMarkers);
    this.scene.add(this.axleMarkers);
    if(axles && Number.isFinite(axles.frontX) && axles.rearX>axles.frontX) {
      const box=this.carBounds(),half=(box.high[1]-box.low[1])*.65;
      for(const [x,color] of [[axles.frontX,0x70acff],[axles.rearX,0x67d6be]]) {
        const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x,axles.centrelineY-half,.008),new THREE.Vector3(x,axles.centrelineY+half,.008)]);
        this.axleMarkers.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color,transparent:true,opacity:axles.confirmed?.7:.35})));
      }
    }
    this.requestRender();
  }

  setDriving(conditions: DrivingConditions | null) {
    this.driving = conditions;
    this.applyDriving();
    this.dirty = true;
  }

  private rotateWheel(w: typeof this.wheelMotion[number]) {
    const angle = rollingAngle(w.distance, w.radius) % (Math.PI * 2);
    w.mesh.rotation.y = w.spinGeometry ? angle : 0;
    if (w.spinGeometry) w.mesh.position.copy(w.center).sub(w.center.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle));
    else w.mesh.position.set(0, 0, 0);
  }

  private applyDriving() {
    const v = this.viz, d = this.driving;
    this.wind.group.visible = !!v?.windDirection && !!d && !this.field && this.parts.some(p => p.enabled && p.role === "body");
    this.road.material.uniforms.uDriving.value = !!v?.motion && !!d;
    this.wind.setYaw(d ? d.yaw_deg * Math.PI / 180 : 0);
    this.wind.material.uniforms.uColor.value.set(this.dark ? 0xd4e7ef : 0x476579);
    this.wind.material.uniforms.uOpacity.value = this.dark ? 0.10 : 0.08;
    for (const w of this.wheelMotion) {
      const p = this.parts.find(p => p.id === w.id);
      const coloured = !!v?.surface && !!p?.cp;
      const keepFieldAligned = coloured || !!v?.friction || !!v?.surfaceFlow || !!v?.slice;
      w.spinGeometry = !!v?.motion && !!d && !!p?.enabled && !keepFieldAligned;
      w.radius = p?.wheel?.radius ?? w.radius;
      // Saved surface samples describe a fixed pose. Restore that pose in surface analyses.
      if (w.spinGeometry) this.rotateWheel(w);
      else { w.mesh.rotation.set(0, 0, 0); w.mesh.position.set(0, 0, 0); }
    }
  }

  private updateStreamlines() {
    const v = this.viz, f = this.field, r = this.ranges;
    const show = !!v?.streamlines && !!f && !!r;
    if (!show) {
      if (this.streamMesh) this.streamMesh.visible = false;
      return;
    }
    const s = v!.stream;
    const key = `${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)},${s.length.toFixed(3)},${s.count},${s.orientation}`;
    if (key !== this.streamKey) {
      this.streamKey = key;
      const lines = traceStreamlines(f!, { center: new THREE.Vector3(s.x, s.y, s.z), length: s.length, count: s.count, orientation: s.orientation });
      const geo = tubeGeometry(lines, f!.length * 0.0032);
      if (this.streamMesh) {
        this.streamMesh.geometry.dispose();
        this.streamMesh.geometry = geo;
      } else {
        this.streamMesh = new THREE.Mesh(geo, this.streamMat);
        this.streamMesh.renderOrder = 4;
        this.scene.add(this.streamMesh);
      }
    }
    this.streamMesh!.visible = true;
    this.streamMat.uniforms.uSpeedMax.value = r!.speed[1];
    this.streamMat.uniforms.uAnimate.value = s.animate ? 1 : 0;
    this.streamMat.uniforms.uPulse.value = (0.12 * f!.length) / f!.freestream;
  }

  private updateOilFlow() {
    const v = this.viz, f = this.field;
    const withShear = this.parts.filter((p) => p.enabled && p.shear && p.shear.length === p.positions.length);
    const show = !!v?.surfaceFlow && !!f && withShear.length > 0;
    if (!show) {
      if (this.oilMesh) this.oilMesh.visible = false;
      return;
    }
    if (this.oilKey !== this.partsKey) {
      this.oilKey = this.partsKey;
      const geo = oilFlowGeometry(withShear.map((p) => ({ positions: p.positions, shear: p.shear! })), f!.length, f!.freestream);
      this.oilMesh?.geometry.dispose();
      if (!geo) {
        if (this.oilMesh) this.oilMesh.visible = false;
        return;
      }
      if (this.oilMesh) this.oilMesh.geometry = geo;
      else {
        this.oilMesh = new THREE.Mesh(geo, this.oilMat);
        this.oilMesh.frustumCulled = false;
        this.oilMesh.renderOrder = 3;
        this.scene.add(this.oilMesh);
      }
      this.oilMat.uniforms.uWidth.value = 0.0011 * f!.length;
      this.oilMat.uniforms.uLift.value = 0.0012 * f!.length;
    }
    // White streaks over the pressure colours, dark ones over the pale clay.
    (this.oilMat.uniforms.uColor.value as THREE.Color).set(v!.surface ? 0xffffff : 0x1d2530);
    this.oilMat.uniforms.uOpacity.value = v!.surface ? 0.6 : 0.55;
    this.oilMesh!.visible = !(v!.slice && this.field);
  }

  private updateWake() {
    const v = this.viz, f = this.field, r = this.ranges;
    const show = !!v?.wake && !!f && !!r;
    if (!show) {
      if (this.wakeMesh) this.wakeMesh.visible = false;
      return;
    }
    const key = `${v!.wakeLevel.toFixed(3)},${v!.wakeColor},${r!.speed[1]},${r!.cp[0]},${r!.cp[1]}`;
    if (key !== this.wakeKey) {
      this.wakeKey = key;
      this.cp0 ??= totalPressureCoefficient(f!);
      const geo = wakeGeometry(f!, this.cp0, v!.wakeLevel, v!.wakeColor, r!.speed[1], r!.cp);
      if (this.wakeMesh) {
        this.wakeMesh.geometry.dispose();
        this.wakeMesh.geometry = geo;
      } else {
        this.wakeMesh = new THREE.Mesh(geo, this.wakeMat);
        this.wakeMesh.renderOrder = 7;
        this.scene.add(this.wakeMesh);
      }
    }
    this.wakeMesh!.visible = true;
  }

  private clearGroup(group: THREE.Group) {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const materials = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of materials) {
        (mat as THREE.SpriteMaterial)?.map?.dispose();
        mat?.dispose();
      }
    });
    group.clear();
  }

  private updatePressureCloud() {
    const v = this.viz, f = this.field;
    this.clouds.visible = !!v?.pressureCloud && !!f;
    if (!this.clouds.visible || !v || !f) return;
    const key = `${v.cloudLevel}`;
    if (this.cloudKey !== key) {
      this.clearGroup(this.clouds);
      this.pressureCp ??= pressureCoefficients(f);
      for (const sign of [-1, 1]) {
        const mesh = new THREE.Mesh(pressureCloudGeometry(f, this.pressureCp, sign * v.cloudLevel), pressureCloudMaterial(sign > 0));
        mesh.userData.sign = sign;
        mesh.renderOrder = 7;
        this.clouds.add(mesh);
      }
      this.cloudKey = key;
    }
    for (const mesh of this.clouds.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>[]) {
      mesh.visible = v.cloudSign === "both" || (v.cloudSign === "positive" ? mesh.userData.sign > 0 : mesh.userData.sign < 0);
      mesh.material.opacity = v.cloudOpacity;
    }
  }

  setForces(values: ForceValues | null, scale?: number, length?: number) {
    this.forceValues = values;
    this.forceScale = scale;
    this.forceLength = length;
    this.updateForces();
    this.dirty = true;
  }

  private updateForces() {
    const f = this.forceValues;
    this.forceGroup.visible = !!this.viz?.forces && !!f;
    if (!this.forceGroup.visible || !f) return;
    const key = `${this.partsKey}:${f.drag}:${f.lift}:${f.side}:${this.forceScale}:${this.forceLength}`;
    if (key === this.forceKey) return;
    this.forceKey = key;
    this.clearGroup(this.forceGroup);
    const size = this.bounds.getSize(new THREE.Vector3());
    const L = this.forceLength ?? size.x;
    const anchor = this.bounds.getCenter(new THREE.Vector3());
    anchor.y = this.bounds.min.y - size.y * 0.35;
    anchor.z = Math.max(this.bounds.max.z * 0.55, size.x * 0.3);
    const max = this.forceScale ?? Math.max(...[f.drag, f.lift, f.side].filter(Number.isFinite).map(Math.abs), 1e-9);
    const components = [
      { value: f.drag, axis: new THREE.Vector3(1, 0, 0), color: 0xffaa63, label: "Drag" },
      { value: f.lift, axis: new THREE.Vector3(0, 0, 1), color: 0x64d8ca, label: f.lift < 0 ? "Downforce" : "Lift" },
      { value: f.side, axis: new THREE.Vector3(0, 1, 0), color: 0xc6a2ff, label: "Side force" },
    ];
    for (const c of components) {
      if (!Number.isFinite(c.value) || Math.abs(c.value) < 0.05) continue;
      const length = L * 0.28 * Math.abs(c.value) / max;
      const direction = c.axis.multiplyScalar(Math.sign(c.value));
      const arrow = new THREE.ArrowHelper(direction, anchor, length, c.color, Math.min(length * 0.25, L * 0.08), Math.min(length * 0.12, L * 0.04));
      // ArrowHelper shares its base geometry; own copies let this group dispose safely.
      arrow.line.geometry = arrow.line.geometry.clone();
      arrow.cone.geometry = arrow.cone.geometry.clone();
      const label = labelSprite(`${c.label} ${Math.abs(c.value).toFixed(1)} N`, "#ffffff", "rgba(20,27,38,0.9)");
      label.position.copy(anchor).addScaledVector(direction, length + L * 0.08);
      this.forceGroup.add(arrow, label);
    }
    this.resizeForceLabels();
  }

  private resizeForceLabels() {
    const h = Math.max(1, this.container.clientHeight + this.insets.bottom + this.insets.top);
    const height = 22 * 2 * Math.tan(this.camera.fov * Math.PI / 360) / h;
    for (const o of this.forceGroup.children) if (o instanceof THREE.Sprite) o.scale.multiplyScalar(height / o.scale.y);
  }

  // -------------------------------------------------------------------------------------------
  // Draggable handles (smoke rake, streamline rake, slice)
  // -------------------------------------------------------------------------------------------

  private updateHandles() {
    for (const h of this.handles)
      h.object.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose?.();
      });
    this.handleGroup.clear();
    this.handles = [];
    const v = this.viz, f = this.field;
    if (!v || !f || !this.ranges) return;
    const L = f.length;
    const accent = this.dark ? 0x7cc4ff : 0x1c5cab;
    const knob = (color: number) => {
      const g = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(L * 0.022, 24, 16), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      const halo = new THREE.Mesh(new THREE.SphereGeometry(L * 0.036, 24, 16), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.22 }));
      core.renderOrder = halo.renderOrder = 30;
      g.add(halo, core);
      return g;
    };
    const lineMat = () => new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.8, depthTest: false });
    const dashMat = () => new THREE.LineDashedMaterial({ color: accent, transparent: true, opacity: 0.45, depthTest: false, dashSize: L * 0.02, gapSize: L * 0.015 });
    if (v.smoke && this.smoke) {
      const { x, y, z, width, height } = v.rake;
      const g = new THREE.Group();
      const pts = [
        [x, y - width / 2, z - height / 2], [x, y + width / 2, z - height / 2], [x, y + width / 2, z + height / 2], [x, y - width / 2, z + height / 2],
      ].map((p) => new THREE.Vector3(...p));
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), dashMat());
      outline.computeLineDistances();
      outline.renderOrder = 29;
      const k = knob(accent);
      k.position.set(x, y, z);
      g.add(outline, k);
      this.handleGroup.add(g);
      this.handles.push({ name: "rake", object: k, axis: null });
    }
    if (v.streamlines) {
      const s = v.stream;
      const a = new THREE.Vector3(s.x, s.y, s.z), b = a.clone();
      if (s.orientation === "vertical") {
        a.z -= s.length / 2;
        b.z += s.length / 2;
      } else {
        a.y -= s.length / 2;
        b.y += s.length / 2;
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat());
      line.renderOrder = 29;
      const k = knob(this.dark ? 0xffd166 : 0xb7791f);
      k.position.set(s.x, s.y, s.z);
      this.handleGroup.add(line, k);
      this.handles.push({ name: "stream", object: k, axis: null });
    }
    if (v.slice) {
      const { min, max } = fieldBox(f);
      const k = knob(this.dark ? 0xffffff : 0x333a44);
      const p = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
      p.setComponent(v.sliceAxis, this.slice.pos);
      if (v.sliceAxis === 2) p.y = max.y;
      else p.z = max.z;
      k.position.copy(p);
      this.handleGroup.add(k);
      const axis = new THREE.Vector3();
      axis.setComponent(v.sliceAxis, 1);
      this.handles.push({ name: "slice", object: k, axis });
    }
  }

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickHandle(e: PointerEvent): Handle | null {
    if (!this.handles.length) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    for (const h of this.handles) if (this.raycaster.intersectObject(h.object, true).length) return h;
    return null;
  }

  private cubeHit(e: PointerEvent): THREE.Vector2 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const g = this.gizmoInset;
    const x = e.clientX - r.left - (r.width - g.right - g.size);
    const y = r.bottom - e.clientY - g.bottom;
    if (x < 0 || y < 0 || x > g.size || y > g.size) return null;
    return new THREE.Vector2((x / g.size) * 2 - 1, (y / g.size) * 2 - 1);
  }

  private onPointerDown = (e: PointerEvent) => {
    const c = this.cubeHit(e);
    if (c) {
      const view = this.cube.pick(c);
      if (view) {
        this.controls.enabled = false;
        this.setView(view);
        requestAnimationFrame(() => (this.controls.enabled = true));
      }
      return;
    }
    const h = this.pickHandle(e);
    if (!h) return;
    this.controls.enabled = false;
    const start = h.object.getWorldPosition(new THREE.Vector3());
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start);
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? start.clone();
    this.drag = { handle: h, start, hit, plane };
    this.renderer.domElement.setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  private onPointerMove = (e: PointerEvent) => {
    const el = this.renderer.domElement;
    if (!this.drag) {
      el.style.cursor = this.cubeHit(e) ? "pointer" : this.pickHandle(e) ? "grab" : "";
      return;
    }
    el.style.cursor = "grabbing";
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const p = this.raycaster.ray.intersectPlane(this.drag.plane, new THREE.Vector3());
    if (!p) return;
    const delta = p.sub(this.drag.hit);
    const { axis } = this.drag.handle;
    if (axis) delta.copy(axis).multiplyScalar(delta.dot(axis));
    const pos = this.drag.start.clone().add(delta);
    if (this.field) {
      const { min, max } = fieldBox(this.field);
      pos.clamp(min, max);
    }
    this.onHandleDrag?.(this.drag.handle.name, pos);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = "";
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
  };

  // -------------------------------------------------------------------------------------------

  async screenshot(): Promise<Blob> {
    this.render();
    const canvas=document.createElement("canvas"); canvas.width=this.renderer.domElement.width; canvas.height=this.renderer.domElement.height;
    const ctx=canvas.getContext("2d")!; ctx.drawImage(this.renderer.domElement,0,0);
    if(this.viz?.friction) {
      const cf=this.viz.frictionUnit==="Cf",max=this.viz.frictionMax ?? (cf?this.ranges?.cf?.[1]:this.ranges?.friction?.[1]) ?? 1;
      ctx.fillStyle="rgba(15,20,28,.92)";ctx.fillRect(24,canvas.height-94,520,70);
      ctx.fillStyle="#f3f5f8";ctx.font="18px sans-serif";ctx.fillText(`Surface friction · final snapshot · ${cf?"Cf":"Pa"}`,40,canvas.height-65);
      ctx.font="16px sans-serif";ctx.fillText(`0 → ${max.toFixed(cf?4:2)} ${cf?"Cf":"Pa"}  ·  grey = missing data`,40,canvas.height-37);
    }
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Screenshot failed."))), "image/png"),
    );
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.smoke?.dispose();
    this.tracers?.dispose();
    this.clearAnimationGPU();
    this.slice.dispose();
    disposeFieldGPU(this.fieldGPU);
    this.streamMesh?.geometry.dispose();
    this.wakeMesh?.geometry.dispose();
    this.oilMesh?.geometry.dispose();
    this.clearGroup(this.clouds);
    this.clearGroup(this.forceGroup);
    this.wind.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
