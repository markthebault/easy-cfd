// A continuous dye sheet carried by the recorded velocity in a section plane. Only the dye is
// synthetic: this renderer never adds forces, changes CFD velocities, or invents wake vortices.
// Limited MacCormack advection preserves wisps better than repeated bilinear advection:
// https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids
import * as THREE from "three";
import { FRAME_FIELD_GLSL, fieldUniforms, updateFieldUniforms, type FieldGPU } from "./field";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PLANE = /* glsl */ `
uniform int uAxis;
uniform float uPlanePos;
uniform vec3 uMin;
uniform vec3 uSize;
vec3 worldAt(vec2 uv) {
  if (uAxis == 0) return vec3(uPlanePos, uMin.yz + uv * uSize.yz);
  if (uAxis == 1) return vec3(uMin.x + uv.x * uSize.x, uPlanePos, uMin.z + uv.y * uSize.z);
  return vec3(uMin.xy + uv * uSize.xy, uPlanePos);
}
vec2 inPlane(vec3 v) { return uAxis == 0 ? v.yz : uAxis == 1 ? v.xz : v.xy; }
`;

const ADVECT = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uDye;
uniform sampler2D uForward;
uniform sampler2D uFlow;
uniform vec2 uResolution;
uniform float uDt;
uniform float uTime;
uniform float uLength;
uniform float uFreestream;
uniform int uPass;
uniform bool uReset;
${PLANE}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+1.0), f.x), f.y);
}
float seed(vec2 uv) {
  vec2 p = inPlane(worldAt(uv)) / uLength;
  // A textured inflow makes even uniform air motion legible. Interior dye is only transported.
  if (uAxis != 0) p.x -= uTime * uFreestream / uLength;
  p *= vec2(0.65, 1.25);
  return 0.58*noise(p*9.0) + 0.29*noise(p*23.0+17.0) + 0.13*noise(p*57.0+31.0);
}
bool outside(vec2 p) { return any(lessThan(p, vec2(0))) || any(greaterThan(p, vec2(1))); }
vec2 departure(vec2 p, float dt) {
  vec2 v = texture2D(uFlow, p).xy;
  vec2 mid = p - 0.5*dt*v;
  // Do not trace across an obstacle, including at the midpoint of the RK2 path.
  if (!outside(mid) && texture2D(uFlow, mid).z < 0.5) return p;
  vec2 back = p - dt*texture2D(uFlow, mid).xy;
  if (!outside(back) && texture2D(uFlow, back).z < 0.5) return p;
  return back;
}
void main() {
  if (texture2D(uFlow, vUv).z < 0.5) { gl_FragColor = vec4(0); return; }
  if (uReset) { gl_FragColor = vec4(seed(vUv), 0, 0, 1); return; }
  vec2 back = departure(vUv, uDt);
  if (outside(back)) { gl_FragColor = vec4(seed(vUv), 0, 0, 1); return; }
  float dye = texture2D(uDye, back).r;
  if (uPass == 1) {
    vec2 forward = departure(vUv, -uDt);
    if (!outside(forward)) {
      dye = texture2D(uForward, vUv).r + 0.5*(texture2D(uDye, vUv).r-texture2D(uForward, forward).r);
      vec2 lo = (floor(back*uResolution-0.5)+0.5)/uResolution;
      vec2 px = 1.0/uResolution;
      float a=texture2D(uDye,lo).r, b=texture2D(uDye,lo+vec2(px.x,0)).r;
      float c=texture2D(uDye,lo+vec2(0,px.y)).r, d=texture2D(uDye,lo+px).r;
      dye = clamp(dye, min(min(a,b),min(c,d)), max(max(a,b),max(c,d)));
    }
  }
  gl_FragColor = vec4(dye, 0, 0, 1);
}
`;

export class FlowSmoke {
  private fieldU = fieldUniforms(null);
  private nextU = fieldUniforms(null);
  private planeU = {
    uAxis: { value: 1 }, uPlanePos: { value: 0 },
    uMin: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3(1, 1, 1) },
  };
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private velocityMaterial: THREE.ShaderMaterial;
  private advectionMaterial: THREE.ShaderMaterial;
  private flow: THREE.WebGLRenderTarget;
  private dye: THREE.WebGLRenderTarget;
  private forward: THREE.WebGLRenderTarget;
  private next: THREE.WebGLRenderTarget;
  private needsReset = true;
  private key = "";
  private time = 0;
  private minSpacing = 1;
  private freestream = 1;
  private hasField = false;
  readonly frameMix = { value: 0 };

  constructor(private renderer: THREE.WebGLRenderer) {
    const target = () => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.flow = target(); this.dye = target(); this.forward = target(); this.next = target();
    this.velocityMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.fieldU, ...Object.fromEntries(Object.entries(this.nextU).map(([k,v])=>[`${k}Next`,v])), ...this.planeU, uFrameMix: this.frameMix },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        ${FRAME_FIELD_GLSL}
        ${PLANE}
        void main() {
          vec4 a = velocityFrameAt(worldAt(vUv));
          gl_FragColor = vec4(inPlane(a.xyz / max(a.w, 0.5)) / inPlane(uSize), a.w, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.advectionMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.planeU, uDye: { value: null }, uForward: { value: this.forward.texture },
        uFlow: { value: this.flow.texture }, uResolution: { value: new THREE.Vector2(1, 1) },
        uDt: { value: 0 }, uTime: { value: 0 }, uLength: { value: 1 },
        uFreestream: { value: 1 }, uPass: { value: 0 }, uReset: { value: true } },
      vertexShader: VERT, fragmentShader: ADVECT, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.velocityMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get texture() { return this.dye.texture; }

  setField(current: FieldGPU | null, next: FieldGPU | null, mix: number) {
    updateFieldUniforms(this.fieldU, current); updateFieldUniforms(this.nextU, next);
    this.frameMix.value = next ? mix : 0;
    this.hasField = !!current;
    if (current) this.minSpacing = Math.min(...current.extent.toArray().map((s,i)=>s/(current.dims.getComponent(i)-1)));
  }

  configure(axis: 0 | 1 | 2, pos: number, min: THREE.Vector3, max: THREE.Vector3, length: number, freestream: number) {
    const key = `${axis}:${pos}:${min.toArray()}:${max.toArray()}:${length}:${freestream}`;
    if (key === this.key) return;
    this.key = key;
    const size = new THREE.Vector3().subVectors(max, min);
    this.planeU.uAxis.value = axis; this.planeU.uPlanePos.value = pos;
    this.planeU.uMin.value.copy(min); this.planeU.uSize.value.copy(size);
    const w = axis === 0 ? size.y : size.x, h = axis === 2 ? size.y : size.z;
    const width = Math.max(64, Math.round(768 * w / Math.max(w,h)));
    const height = Math.max(64, Math.round(768 * h / Math.max(w,h)));
    for (const t of [this.flow, this.dye, this.forward, this.next]) t.setSize(width, height);
    this.advectionMaterial.uniforms.uResolution.value.set(width, height);
    this.advectionMaterial.uniforms.uLength.value = Math.max(length, 0.01);
    this.advectionMaterial.uniforms.uFreestream.value = freestream;
    this.freestream = freestream;
    this.reset();
  }

  reset() { this.needsReset = true; this.time = 0; }

  /** dt is the same physical duration used by the recorded colour field and timeline. */
  step(dt: number) {
    if (!this.hasField || (!this.needsReset && dt <= 0)) return;
    const r = this.renderer, target = r.getRenderTarget(), viewport = r.getViewport(new THREE.Vector4());
    const scissor = r.getScissor(new THREE.Vector4()), scissorTest = r.getScissorTest(), autoClear = r.autoClear;
    const draw = (material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget) => {
      this.quad.material = material; r.setRenderTarget(to); r.render(this.scene, this.camera);
    };
    try {
      r.setScissorTest(false); r.autoClear = true;
      draw(this.velocityMaterial, this.flow);
      const u = this.advectionMaterial.uniforms;
      u.uReset.value = this.needsReset;
      if (this.needsReset) {
        u.uTime.value = 0;
        u.uDye.value = this.next.texture; u.uForward.value = this.forward.texture;
        draw(this.advectionMaterial, this.dye);
        this.needsReset = false; u.uReset.value = false;
      }
      // Resolve wall curvature at the CFD sample scale, even during fast playback.
      const steps = Math.max(1, Math.ceil(dt * this.freestream * 2 / (this.minSpacing * 0.7)));
      u.uDt.value = dt / steps;
      for (let i = 0; dt > 0 && i < steps; i++) {
        this.time += dt / steps; u.uTime.value = this.time;
        u.uDye.value = this.dye.texture; u.uForward.value = this.dye.texture; u.uPass.value = 0;
        draw(this.advectionMaterial, this.forward);
        u.uForward.value = this.forward.texture; u.uPass.value = 1;
        draw(this.advectionMaterial, this.next);
        [this.dye, this.next] = [this.next, this.dye];
      }
    } finally {
      r.setRenderTarget(target); r.setViewport(viewport); r.setScissor(scissor);
      r.setScissorTest(scissorTest); r.autoClear = autoClear;
    }
  }

  dispose() {
    for (const t of [this.flow, this.dye, this.forward, this.next]) t.dispose();
    this.quad.geometry.dispose(); this.velocityMaterial.dispose(); this.advectionMaterial.dispose();
  }
}
