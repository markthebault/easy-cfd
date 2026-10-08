// GPU smoke: particle positions live in a float render target (GPGPU ping-pong) and are advected
// through the solver velocity texture with RK2. Transient streaks retain actual position history;
// steady smoke can trace its recent streamline backwards without storing history.
// Each particle is an instanced ribbon whose vertices integrate that backward path in the shader.
// Two modes: 0 = emitted from a rake plane upstream, 1 = tracers confined to a section plane.

import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { FRAME_FIELD_GLSL, fieldUniforms, updateFieldUniforms, type FieldGPU } from "./field";
import { mapTexture } from "./colormap";

const SEGMENTS = 6;

const COMMON = /* glsl */ `
${FRAME_FIELD_GLSL}
uniform int uMode;
uniform int uAxis;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 inPlane(vec3 v) {
  if (uMode == 1) {
    if (uAxis == 0) v.x = 0.0; else if (uAxis == 1) v.y = 0.0; else v.z = 0.0;
  }
  return v;
}
float lifeOf(vec2 uv, float life) { return life * (0.55 + 0.45 * hash12(uv * 53.7)); }
`;

const SIM = /* glsl */ `
${COMMON}
uniform float uDt;
uniform float uDtAge;
uniform float uTime;
uniform float uLife;
uniform float uStall;
uniform vec3 uRakeCenter;
uniform vec2 uRakeSize;
uniform vec2 uNozzles;
uniform float uPlanePos;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;

vec3 spawn(vec2 uv, float seed) {
  float a = hash12(uv * 917.13 + seed * 1.713);
  float b = hash12(uv * 331.71 + seed * 2.371 + 4.1);
  if (uMode == 0) {
    if (uNozzles.x < 0.5) return uRakeCenter + vec3(0.0, (a - 0.5) * uRakeSize.x, (b - 0.5) * uRakeSize.y);
    // Discrete nozzles, like a wind-tunnel smoke rake: each particle leaves one nozzle with a
    // small jitter, so the smoke forms filaments that follow individual streamlines.
    float c = hash12(uv * 71.37 + seed * 3.17 + 9.2) - 0.5;
    float d = hash12(uv * 19.91 + seed * 5.03 + 1.7) - 0.5;
    float fy = (floor(a * uNozzles.x) + 0.5 + 0.22 * c) / uNozzles.x - 0.5;
    float fz = (floor(b * uNozzles.y) + 0.5 + 0.22 * d) / uNozzles.y - 0.5;
    return uRakeCenter + vec3(0.0, fy * uRakeSize.x, fz * uRakeSize.y);
  }
  if (uAxis == 0) return vec3(uPlanePos, mix(uBoxMin.y, uBoxMax.y, a), mix(uBoxMin.z, uBoxMax.z, b));
  if (uAxis == 1) return vec3(mix(uBoxMin.x, uBoxMax.x, a), uPlanePos, mix(uBoxMin.z, uBoxMax.z, b));
  return vec3(mix(uBoxMin.x, uBoxMax.x, a), mix(uBoxMin.y, uBoxMax.y, b), uPlanePos);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 s = texture2D(tPos, uv);
  vec3 p = s.xyz;
  float age = s.w;
  if (age < 0.0) {
    // Waiting to be emitted: staggered start keeps the emission rate even.
    age += uDtAge;
    if (age >= 0.0) { p = spawn(uv, uTime); age = 0.0; }
    gl_FragColor = vec4(p, age);
    return;
  }
  vec3 v1 = inPlane(flowFrameAt(p));
  vec3 v2 = inPlane(flowFrameAt(p + 0.5 * uDt * v1));
  p += uDt * v2;
  age += uDtAge;
  vec4 here = velocityFrameAt(p);
  bool dead = age > lifeOf(uv, uLife) || !insideField(p) || here.w < 0.5 || length(inPlane(here.xyz / max(here.w, 0.5))) < uStall;
  if (dead) { p = spawn(uv, uTime + age * 7.31); age = 0.0; }
  gl_FragColor = vec4(p, age);
}
`;

const VERT = /* glsl */ `
${COMMON}
uniform sampler2D uPos;
uniform float uTrail;
uniform float uTimeScale;
uniform float uLife;
uniform float uWidth;
uniform vec2 uViewport;
uniform bool uHistory;
${Array.from({length:SEGMENTS}, (_,i)=>`uniform sampler2D uHistory${i};`).join("\n")}
attribute float aSeg;
attribute float aSide;
attribute vec2 aRef;
varying float vSpeed;
varying float vAlpha;
varying float vSide;
vec4 historyPosition(float segment) {
  ${Array.from({length:SEGMENTS}, (_,i)=>`if (segment < ${i + 1}.5) return texture2D(uHistory${i}, aRef);`).join("\n")}
  return texture2D(uHistory${SEGMENTS - 1}, aRef);
}
void main() {
  vec4 s = texture(uPos, aRef);
  float age = s.w;
  vAlpha = 0.0;
  vSide = aSide;
  vSpeed = 0.0;
  if (age <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float trail = min(uTrail, age);
  float h = trail / float(${SEGMENTS}) * uTimeScale;
  vec3 p = s.xyz;
  vec3 v = inPlane(flowFrameAt(p));
  vec3 head = v;
  if (uHistory && aSeg > 0.0) {
    vec4 past = historyPosition(aSeg);
    // Respawning starts a new path; never join it to a particle's previous lifetime.
    if (past.w >= 0.0 && past.w <= age) p = past.xyz;
    v = inPlane(flowFrameAt(p));
  } else if (!uHistory) {
    for (int i = 0; i < ${SEGMENTS}; i++) {
      if (float(i) >= aSeg) break;
      p -= h * v;
      v = inPlane(flowFrameAt(p));
    }
  }
  if (velocityFrameAt(p).w < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 dirWorld = length(v) > 1e-5 ? v : head;
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(p + normalize(dirWorld + 1e-6) * 0.05, 1.0);
  if (c0.w <= 0.0 || c1.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 s0 = c0.xy / c0.w * uViewport, s1 = c1.xy / c1.w * uViewport;
  vec2 d = s1 - s0;
  d = length(d) < 1e-4 ? vec2(1.0, 0.0) : normalize(d);
  float taper = 1.0 - aSeg / float(${SEGMENTS});
  float w = uWidth * (0.3 + 0.7 * taper);
  c0.xy += vec2(-d.y, d.x) * aSide * w / uViewport * c0.w;
  gl_Position = c0;
  float life = lifeOf(aRef, uLife);
  vSpeed = length(v);
  vAlpha = taper * smoothstep(0.0, 0.2 * life, age) * (1.0 - smoothstep(0.8 * life, life, age));
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uSpeedMax;
uniform float uOpacity;
uniform bool uMono;
uniform vec3 uMonoColor;
uniform bool uContrast;
varying float vSpeed;
varying float vAlpha;
varying float vSide;
void main() {
  float edge = 1.0 - vSide * vSide;
  vec3 col = uMono ? uMonoColor : texture2D(uMap, vec2(clamp(vSpeed / uSpeedMax, 0.0, 1.0), 0.5)).rgb;
  if (uContrast) col = mix(vec3(1.0), vec3(0.015, 0.025, 0.045), smoothstep(0.2, 0.65, abs(vSide)));
  gl_FragColor = vec4(col, vAlpha * uOpacity * edge);
  if (gl_FragColor.a < 0.003) discard;
  #include <colorspace_fragment>
}
`;

export interface ParticleOptions {
  size: number;
  mode: 0 | 1;
}

export class Particles {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private gpu: GPUComputationRenderer;
  private variable: Variable;
  private simUniforms: Record<string, THREE.IUniform>;
  private fieldU = fieldUniforms(null);
  private nextU = fieldUniforms(null);
  private frameMix = { value: 0 };
  private history: THREE.WebGLRenderTarget[] = [];
  private historyHead = 0;
  private historyTime = 0;
  private minSpacing = 1;
  private freestream = 1;
  private time = 0;
  private seeded = false;
  readonly size: number;
  /** Simulated seconds per displayed second. */
  timeScale = 0.05;
  life = 12;
  playing = true;

  constructor(private renderer: THREE.WebGLRenderer, opts: ParticleOptions) {
    this.size = opts.size;
    this.gpu = new GPUComputationRenderer(opts.size, opts.size, renderer);
    if (!renderer.extensions.has("EXT_color_buffer_float")) this.gpu.setDataType(THREE.HalfFloatType);
    const init = this.gpu.createTexture();
    this.variable = this.gpu.addVariable("tPos", SIM, init);
    this.gpu.setVariableDependencies(this.variable, [this.variable]);
    this.simUniforms = this.variable.material.uniforms;
    Object.assign(this.simUniforms, this.fieldU, Object.fromEntries(Object.entries(this.nextU).map(([k,v])=>[`${k}Next`,v])), {
      uFrameMix: this.frameMix,
      uMode: { value: opts.mode },
      uAxis: { value: 0 },
      uDt: { value: 0 },
      uDtAge: { value: 0 },
      uTime: { value: 0 },
      uLife: { value: this.life },
      uStall: { value: 0 },
      uRakeCenter: { value: new THREE.Vector3() },
      uRakeSize: { value: new THREE.Vector2(1, 1) },
      uNozzles: { value: new THREE.Vector2(0, 0) },
      uPlanePos: { value: 0 },
      uBoxMin: { value: new THREE.Vector3() },
      uBoxMax: { value: new THREE.Vector3(1, 1, 1) },
    });
    const err = this.gpu.init();
    if (err) throw new Error(err);

    const base = new THREE.InstancedBufferGeometry();
    const seg: number[] = [], side: number[] = [], index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      seg.push(i, i);
      side.push(-1, 1);
      if (i < SEGMENTS) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    // Dummy positions: the vertex shader computes everything.
    base.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(seg.length * 3), 3));
    base.setAttribute("aSeg", new THREE.Float32BufferAttribute(seg, 1));
    base.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    base.setIndex(index);
    const n = opts.size * opts.size;
    const ref = new Float32Array(n * 2);
    for (let j = 0; j < opts.size; j++)
      for (let i = 0; i < opts.size; i++) ref.set([(i + 0.5) / opts.size, (j + 0.5) / opts.size], 2 * (i + j * opts.size));
    base.setAttribute("aRef", new THREE.InstancedBufferAttribute(ref, 2));
    base.instanceCount = n;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...this.fieldU,
        ...Object.fromEntries(Object.entries(this.nextU).map(([k,v])=>[`${k}Next`,v])),
        uFrameMix: this.frameMix,
        uHistory: { value: false },
        ...Object.fromEntries(Array.from({length:SEGMENTS}, (_,i)=>[`uHistory${i}`,{value:null}])),
        uMode: this.simUniforms.uMode,
        uAxis: this.simUniforms.uAxis,
        uLife: this.simUniforms.uLife,
        uPos: { value: null },
        uTrail: { value: 0.6 },
        uTimeScale: { value: this.timeScale },
        uWidth: { value: 2 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uMap: { value: mapTexture("speed") },
        uSpeedMax: { value: 1 },
        uOpacity: { value: 0.8 },
        uMono: { value: false },
        uMonoColor: { value: new THREE.Color(1, 1, 1) },
        uContrast: { value: false },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(base, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  setField(g: FieldGPU | null, freestream: number) {
    updateFieldUniforms(this.fieldU, g);
    this.freestream = freestream;
    if (g) this.minSpacing = Math.min(g.extent.x / (g.dims.x - 1), g.extent.y / (g.dims.y - 1), g.extent.z / (g.dims.z - 1));
    this.simUniforms.uStall.value = (this.history.length ? 0.001 : 0.015) * freestream;
    this.mesh.visible = !!g && this.mesh.visible;
  }

  setNextField(g: FieldGPU | null, mix: number) {
    updateFieldUniforms(this.nextU, g);
    this.frameMix.value = g ? mix : 0;
  }

  /** Keep six GPU snapshots of the path actually travelled, instead of steady backtracing. */
  setHistory(enabled: boolean) {
    if (enabled === !!this.history.length) return;
    if (enabled) {
      const source = this.gpu.getCurrentRenderTarget(this.variable);
      this.history = Array.from({length:SEGMENTS}, () => source.clone());
    } else {
      this.history.forEach(target=>target.dispose());
      this.history = [];
      for (let i=0;i<SEGMENTS;i++) this.uniforms[`uHistory${i}`].value = null;
    }
    this.uniforms.uHistory.value = enabled;
    this.simUniforms.uStall.value = (enabled ? 0.001 : 0.015) * this.freestream;
    this.uniforms.uContrast.value = enabled;
    this.mesh.material.blending = enabled ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.seeded = false;
  }

  private syncHistory() {
    for (let i=0;i<SEGMENTS;i++) this.uniforms[`uHistory${i}`].value = this.history[(this.historyHead - i + SEGMENTS) % SEGMENTS].texture;
  }

  /** `spacing` > 0 emits from a grid of nozzles that far apart; 0 emits a continuous sheet. */
  setRake(center: THREE.Vector3, width: number, height: number, spacing: number) {
    (this.simUniforms.uRakeCenter.value as THREE.Vector3).copy(center);
    (this.simUniforms.uRakeSize.value as THREE.Vector2).set(width, height);
    const n = (ext: number) => (spacing > 0 ? Math.max(1, Math.min(48, Math.round(ext / spacing))) : 0);
    (this.simUniforms.uNozzles.value as THREE.Vector2).set(n(width), n(height));
  }

  setPlane(axis: 0 | 1 | 2, pos: number, min: THREE.Vector3, max: THREE.Vector3) {
    const changed = this.simUniforms.uAxis.value !== axis || Math.abs(this.simUniforms.uPlanePos.value - pos) > 1e-6;
    this.simUniforms.uAxis.value = axis;
    this.simUniforms.uPlanePos.value = pos;
    (this.simUniforms.uBoxMin.value as THREE.Vector3).copy(min);
    (this.simUniforms.uBoxMax.value as THREE.Vector3).copy(max);
    if (changed) this.reseed();
  }

  setLife(seconds: number) {
    this.life = seconds;
    this.simUniforms.uLife.value = seconds;
  }

  /** Scatter start times so particles are emitted evenly instead of in one burst. */
  reseed() {
    const tex = this.gpu.createTexture();
    const d = tex.image.data as Float32Array;
    for (let i = 0; i < d.length; i += 4) {
      if (this.history.length && this.simUniforms.uMode.value === 1) {
        const min = this.simUniforms.uBoxMin.value as THREE.Vector3, max = this.simUniforms.uBoxMax.value as THREE.Vector3;
        for (let axis=0;axis<3;axis++) d[i+axis] = axis === this.simUniforms.uAxis.value ? this.simUniforms.uPlanePos.value : THREE.MathUtils.lerp(min.getComponent(axis),max.getComponent(axis),Math.random());
        d[i+3] = this.life * (0.2 + 0.6 * Math.random());
      } else d[i + 3] = -Math.random() * this.life;
    }
    for (const rt of (this.variable as unknown as { renderTargets: THREE.WebGLRenderTarget[] }).renderTargets) this.gpu.renderTexture(tex, rt);
    tex.dispose();
    if (this.history.length) {
      const current = this.gpu.getCurrentRenderTarget(this.variable).texture;
      this.history.forEach(target=>this.gpu.renderTexture(current,target));
      this.historyHead = 0;
      this.historyTime = this.time;
      this.syncHistory();
    }
    this.seeded = true;
  }

  /** Advance by `dt` displayed seconds. */
  step(dt: number, camera: THREE.Camera) {
    void camera;
    if (!this.mesh.visible || !this.fieldU.uVelocity.value) return;
    if (!this.seeded) this.reseed();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    (this.uniforms.uViewport.value as THREE.Vector2).set(size.x / 2, size.y / 2);
    this.uniforms.uTimeScale.value = this.timeScale;
    if (this.playing && dt > 0) {
      const d = Math.min(dt, this.history.length ? 0.1 : 0.05);
      if (this.history.length && this.time + d - this.historyTime >= this.uniforms.uTrail.value / SEGMENTS) {
        this.historyHead = (this.historyHead + 1) % SEGMENTS;
        this.gpu.renderTexture(this.gpu.getCurrentRenderTarget(this.variable).texture, this.history[this.historyHead]);
        this.historyTime = this.time;
        this.syncHistory();
      }
      this.time += d;
      const substeps = this.history.length ? Math.max(1, Math.min(12, Math.ceil(d * this.timeScale * this.freestream / (0.45 * this.minSpacing)))) : 1;
      this.simUniforms.uDt.value = d * this.timeScale / substeps;
      this.simUniforms.uDtAge.value = d / substeps;
      this.simUniforms.uTime.value = this.time % 1000;
      for (let i=0;i<substeps;i++) this.gpu.compute();
    }
    this.uniforms.uPos.value = this.gpu.getCurrentRenderTarget(this.variable).texture;
  }

  dispose() {
    this.history.forEach(target=>target.dispose());
    this.gpu.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
