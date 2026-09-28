// The 3D wind tunnel: renderer, camera, lighting, car and every flow layer. React drives it through
// a handful of setters; it renders on demand and only runs continuously while something moves.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { VizField } from "../solver/extract";
import type { Ranges } from "../store/types";
import { applyPressureColors, carGeometry, clayMaterial, pressureMaterial } from "./car";
import { createFieldGPU, disposeFieldGPU, fieldBox, type FieldGPU } from "./field";
import { flowArrow, labelSprite, OrientationCube, road, tunnelBox, type ViewName } from "./helpers";
import { oilFlowGeometry, oilFlowMaterial } from "./oilflow";
import { Particles } from "./particles";
import { Slice, type SliceField } from "./slice";
import { streamlineMaterial, traceStreamlines, tubeGeometry } from "./streamlines";
import { totalPressureCoefficient, wakeGeometry, wakeMaterial, type WakeColor } from "./wake";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface StagePart {
  id: string;
  role: "body" | "wheel";
  enabled: boolean;
  positions: Float32Array;
  cp?: Float32Array | null;
  shear?: Float32Array | null;
}

export interface VizSettings {
  surface: boolean;
  surfaceFlow: boolean;
  smoke: boolean;
  streamlines: boolean;
  slice: boolean;
  wake: boolean;
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
  private insets = { left: 0, bottom: 0 };

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
    this.scene.add(this.road, this.shadowCatcher, this.carGroup, this.helperGroup, this.handleGroup, this.slice.mesh);

    // Our pointer handler is registered before OrbitControls so a handle grab can disable orbiting.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI * 0.495;
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
    const airLabel = this.helperGroup?.getObjectByName("airLabel");
    if (airLabel) airLabel.visible = w >= 600;
    this.renderer.setSize(w, h, false);
    const ratio = this.renderer.getPixelRatio();
    if (this.smoke) this.smoke.uniforms.uWidth.value = 1.5 * ratio;
    if (this.tracers) this.tracers.uniforms.uWidth.value = 1.1 * ratio;
    const { left, bottom } = this.insets;
    // Render a window of a larger virtual image so the car centres in the uncovered area.
    this.camera.aspect = (w + left) / (h + bottom);
    if (left || bottom) this.camera.setViewOffset(w + left, h + bottom, 0, bottom, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    // Keep the framing after a viewport change (rotation, window resize, panel height) unless the
    // user has moved the camera since the last automatic fit.
    if (this.lastFit && !this.tween && this.sameCamera(this.lastFit.state)) {
      const { view, fitBox, flow } = this.lastFit;
      this.applyCamera(this.viewState(view, fitBox, flow));
      this.lastFit.state = this.cameraState();
    }
  }

  private lastFit: { view: ViewName; fitBox: boolean; flow: boolean; state: CameraState } | null = null;

  private sameCamera(s: CameraState) {
    const c = this.cameraState();
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const scale = Math.max(1e-3, d(s.position, s.target));
    return d(c.position, s.position) < 1e-3 * scale && d(c.target, s.target) < 1e-3 * scale;
  }

  setInsets(left: number, bottom: number) {
    if (left === this.insets.left && bottom === this.insets.bottom) return;
    this.insets = { left, bottom };
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
    const scale = this.field ? (0.3 * this.field.length) / this.field.freestream : 0.05;
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

  private viewState(view: ViewName, fitBox = false, flow = false): CameraState {
    let b = fitBox && this.box ? new THREE.Box3().setFromObject(this.box) : this.bounds;
    if (flow) {
      // Car plus the near wake, for section planes.
      const L = this.bounds.max.x - this.bounds.min.x;
      b = this.bounds.clone();
      b.min.x -= 0.25 * L;
      b.max.x += 1.1 * L;
      b.max.z += 0.2 * L;
    }
    const c = b.getCenter(new THREE.Vector3());
    const radius = Math.max(0.3, b.getSize(new THREE.Vector3()).length() / 2);
    // Fit into the uncovered part of the screen; the virtual image is (w + left) × (h + bottom).
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const { left, bottom } = this.insets;
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const visV = 2 * Math.atan((tanV * (h - bottom)) / (h + bottom));
    const visH = 2 * Math.atan((tanV * (w - left)) / (h + bottom));
    const D = (radius * 1.08) / Math.sin(Math.min(visV, visH) / 2);
    const target: [number, number, number] = [c.x, c.y, fitBox ? c.z * 0.5 : c.z * 0.75];
    const dir: Record<ViewName, [number, number, number]> = {
      front: [-1, 0, 0.1],
      rear: [1, 0, 0.14],
      side: [0, -1, 0.08],
      top: [0, -0.02, 1],
      iso: [-1, -1.25, 0.55],
    };
    const d = new THREE.Vector3(...dir[view]).normalize().multiplyScalar(D);
    return { position: [target[0] + d.x, target[1] + d.y, target[2] + d.z], target };
  }

  setView(view: ViewName, animate = true, fitBox = false, flow = false) {
    const to = this.viewState(view, fitBox, flow);
    this.lastFit = { view, fitBox, flow, state: to };
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
    this.updateCarLook();
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
  }

  private updateCarLook() {
    const surface = !!this.viz?.surface;
    const ghost = !!this.viz?.slice && !!this.field;
    for (const m of this.carGroup.children as THREE.Mesh[]) {
      const p = this.parts.find((q) => q.id === m.userData.partId);
      if (!p) continue;
      const geo = m.geometry;
      const wantCp = surface && !!p.cp;
      let mat = m.material as THREE.MeshStandardMaterial;
      if (wantCp) {
        const key = `${this.cpRange[0]}:${this.cpRange[1]}`;
        if (geo.userData.cpFor !== p.cp || geo.userData.cpKey !== key) {
          const colors = applyPressureColors(p.positions, p.cp ?? null, this.cpRange);
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
    const accent = this.dark ? 0x3f9bff : 0x2a78d6;
    // Airflow arrow on the road beside the car, visible from the front, side and top views.
    const side = b.max.y + Math.max(0.25 * s.y, 0.1 * L);
    const arrow = flowArrow(L * 0.9, Math.max(0.12 * L, 0.2), accent);
    arrow.position.set(b.min.x, side, 0.003);
    const air = labelSprite("AIRFLOW  →", "#ffffff", this.dark ? "rgba(40,120,230,0.92)" : "rgba(42,120,214,0.95)", 0.018);
    air.position.set(b.min.x + 0.6 * L, side, 0.05);
    air.name = "airLabel";
    air.visible = this.container.clientWidth >= 600;
    const front = labelSprite("FRONT", this.dark ? "#0b0d11" : "#ffffff", this.dark ? "rgba(255,255,255,0.92)" : "rgba(20,24,30,0.9)", 0.018);
    front.position.set(b.min.x - 0.02 * L, (b.min.y + b.max.y) / 2, b.max.z * 0.75);
    this.helperGroup.add(arrow, air, front);
    this.helperGroup.visible = this.showHelpers;
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

  setField(field: VizField | null, ranges: Ranges | null) {
    if (field !== this.field) {
      disposeFieldGPU(this.fieldGPU);
      this.field = field;
      this.fieldGPU = field ? createFieldGPU(field) : null;
      this.cp0 = null;
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
    this.slice.mesh.visible = on(v?.slice);
    if (v && r && f) {
      this.slice.place(v.sliceAxis, v.slicePos);
      const range = v.sliceField === "speed" ? r.speed : v.sliceField === "pressure" ? r.pressure : v.sliceField === "cp0" ? r.cp0 : r.k;
      this.slice.setMode(v.sliceField, range, r.density, r.q);
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
    this.updateOilFlow();
    this.updateHandles();
    this.updateCarLook();
    this.dirty = true;
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
    return new Promise((resolve, reject) =>
      this.renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error("Screenshot failed."))), "image/png"),
    );
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.smoke?.dispose();
    this.tracers?.dispose();
    this.slice.dispose();
    disposeFieldGPU(this.fieldGPU);
    this.streamMesh?.geometry.dispose();
    this.wakeMesh?.geometry.dispose();
    this.oilMesh?.geometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
