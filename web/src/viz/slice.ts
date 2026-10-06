// Section plane coloured by a solver field, sampled per pixel from the 3D textures. Faint
// isolines help read gradients; samples inside the car are drawn as a flat cut face.

import * as THREE from "three";
import { FRAME_FIELD_GLSL, fieldUniforms, updateFieldUniforms, type FieldGPU } from "./field";
import { mapTexture, type MapName } from "./colormap";

export type SliceField = "speed" | "pressure" | "cp0" | "k";

export const SLICE_MAP: Record<SliceField, MapName> = { speed: "speed", pressure: "diverging", cp0: "loss", k: "turbulence" };
const MODE: Record<SliceField, number> = { speed: 0, pressure: 1, cp0: 2, k: 3 };

export class Slice {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private fieldU = fieldUniforms(null);
  private nextU = fieldUniforms(null);
  axis: 0 | 1 | 2 = 1;
  pos = 0;
  min = new THREE.Vector3();
  max = new THREE.Vector3(1, 1, 1);

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.fieldU,
        ...Object.fromEntries(Object.entries(this.nextU).map(([k,v])=>[`${k}Next`, v])),
        uFrameMix: { value: 0 },
        uMap: { value: mapTexture("speed") },
        uMode: { value: 0 },
        uRange: { value: new THREE.Vector2(0, 1) },
        uDensity: { value: 1.225 },
        uQ: { value: 1 },
        uSolid: { value: new THREE.Color(0x3a3d44) },
        uOpacity: { value: 0.94 },
        uSmoke: { value: null },
        uSmokeEnabled: { value: false },
        uSmokeAxis: { value: 1 },
        uSmokeMin: { value: new THREE.Vector3() },
        uSmokeSize: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${FRAME_FIELD_GLSL}
        uniform sampler2D uMap;
        uniform int uMode;
        uniform vec2 uRange;
        uniform float uDensity;
        uniform float uQ;
        uniform vec3 uSolid;
        uniform float uOpacity;
        uniform sampler2D uSmoke;
        uniform bool uSmokeEnabled;
        uniform int uSmokeAxis;
        uniform vec3 uSmokeMin;
        uniform vec3 uSmokeSize;
        varying vec3 vWorld;
        void main() {
          vec4 a = velocityFrameAt(vWorld);
          if (a.w < 0.5) { gl_FragColor = vec4(uSolid, 0.96);
            #include <colorspace_fragment>
            return; }
          vec4 b = scalarsAt(vWorld);
          if (uFrameMix > 0.0) b = mix(b, scalarsAtNext(vWorld), uFrameMix);
          // Renormalise the fluid-weighted blend near the wall (solid samples carry zeros).
          vec3 u = a.xyz / max(a.w, 0.5);
          float speed = length(u);
          float value;
          float t;
          if (uMode == 0) { value = speed; t = value / uRange.y; }
          else if (uMode == 1) {
            value = b.x / max(a.w, 0.5) * uDensity;
            t = value < 0.0 ? 0.5 - 0.5 * min(1.0, value / min(uRange.x, -1e-6)) : 0.5 + 0.5 * min(1.0, value / max(uRange.y, 1e-6));
          }
          else if (uMode == 2) { value = (b.x / max(a.w, 0.5) + 0.5 * speed * speed) * uDensity / uQ; t = (value - uRange.x) / (uRange.y - uRange.x); }
          else { value = b.y / max(a.w, 0.5); t = value / uRange.y; }
          t = clamp(t, 0.0, 1.0);
          vec3 col = texture2D(uMap, vec2(t, 0.5)).rgb;
          if (uSmokeEnabled) {
            vec3 uvw = (vWorld - uSmokeMin) / uSmokeSize;
            vec2 uv = uSmokeAxis == 0 ? uvw.yz : uSmokeAxis == 1 ? uvw.xz : uvw.xy;
            float dye = smoothstep(0.18, 0.82, texture2D(uSmoke, uv).r);
            // Density reveals continuous transported wisps; hue still comes from the CFD scalar.
            col *= mix(0.58, 1.12, dye);
            gl_FragColor = vec4(col, mix(0.68, 0.98, dye));
            #include <colorspace_fragment>
            return;
          }
          // Isolines every 1/12 of the colour range, anti-aliased with screen-space derivatives.
          float bands = t * 12.0;
          float line = abs(fract(bands - 0.5) - 0.5) / max(fwidth(bands), 1e-4);
          col *= mix(0.82, 1.0, smoothstep(0.0, 1.2, line));
          gl_FragColor = vec4(col, uOpacity);
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  setField(g: FieldGPU | null, min: THREE.Vector3, max: THREE.Vector3) {
    updateFieldUniforms(this.fieldU, g);
    this.min.copy(min);
    this.max.copy(max);
    this.place(this.axis, this.pos);
  }

  setNextField(g: FieldGPU | null, mix: number) {
    updateFieldUniforms(this.nextU, g);
    this.uniforms.uFrameMix.value = g ? mix : 0;
  }

  setMode(field: SliceField, range: [number, number], density: number, q: number, animation = false) {
    const u = this.uniforms;
    u.uMode.value = MODE[field];
    u.uMap.value = mapTexture(animation && field === "speed" ? "flow" : SLICE_MAP[field]);
    (u.uRange.value as THREE.Vector2).set(range[0], range[1]);
    u.uDensity.value = density;
    u.uQ.value = q;
  }

  setSmoke(texture: THREE.Texture | null) {
    this.uniforms.uSmoke.value = texture;
    this.uniforms.uSmokeEnabled.value = !!texture;
    this.uniforms.uSmokeAxis.value = this.axis;
    this.uniforms.uSmokeMin.value.copy(this.min);
    this.uniforms.uSmokeSize.value.subVectors(this.max, this.min);
  }

  /** Position the plane across the whole field box on the given axis. */
  place(axis: 0 | 1 | 2, pos: number) {
    this.axis = axis;
    const lo = this.min.getComponent(axis), hi = this.max.getComponent(axis);
    this.pos = Math.min(hi, Math.max(lo, pos));
    const size = new THREE.Vector3().subVectors(this.max, this.min);
    const c = new THREE.Vector3().addVectors(this.min, this.max).multiplyScalar(0.5);
    c.setComponent(axis, this.pos);
    const m = this.mesh;
    m.position.copy(c);
    m.rotation.set(0, 0, 0);
    // PlaneGeometry lies in local XY; rotate so its normal matches the slice axis.
    if (axis === 0) {
      m.rotation.set(0, Math.PI / 2, 0);
      m.scale.set(size.z, size.y, 1);
    } else if (axis === 1) {
      m.rotation.set(Math.PI / 2, 0, 0);
      m.scale.set(size.x, size.z, 1);
    } else m.scale.set(size.x, size.y, 1);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
