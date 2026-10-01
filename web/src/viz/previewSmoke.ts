import * as THREE from "three";

const STATIONS = 128, NX = 80, N = 32;

/** Five illustrative paths from coarse body envelopes. No flow solver or force estimates. */
export function previewSmokePaths(parts: Float32Array[], yaw = 0): Float32Array[] {
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (const p of parts) for (let i = 0; i < p.length; i += 3) box.expandByPoint(vertex.set(p[i], p[i + 1], p[i + 2]));
  if (box.isEmpty()) return [];
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const L = Math.max(size.x, 0.1), W = Math.max(size.y, 0.1), H = Math.max(size.z, 0.1);
  const top = new Float32Array(NX * N).fill(-Infinity);
  const left = new Float32Array(NX * N).fill(-Infinity), right = new Float32Array(NX * N).fill(Infinity);
  const bin = (v: number, low: number, span: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor((v - low) / span * n)));
  // Conservative triangle footprints capture even large flat panels without expensive ray casts.
  for (const p of parts) for (let i = 0; i + 8 < p.length; i += 9) {
    const xs = [p[i], p[i + 3], p[i + 6]], ys = [p[i + 1], p[i + 4], p[i + 7]], zs = [p[i + 2], p[i + 5], p[i + 8]];
    const x0 = bin(Math.min(...xs), box.min.x, L, NX), x1 = bin(Math.max(...xs), box.min.x, L, NX);
    const y0 = bin(Math.min(...ys), box.min.y, W, N), y1 = bin(Math.max(...ys), box.min.y, W, N);
    const z0 = bin(Math.min(...zs), box.min.z, H, N), z1 = bin(Math.max(...zs), box.min.z, H, N);
    const z = Math.max(...zs), yl = Math.max(...ys), yr = Math.min(...ys);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) top[x * N + y] = Math.max(top[x * N + y], z);
      for (let zz = z0; zz <= z1; zz++) { left[x * N + zz] = Math.max(left[x * N + zz], yl); right[x * N + zz] = Math.min(right[x * N + zz], yr); }
    }
  }
  const start = box.min.x - L * 0.7, end = box.max.x + L * 0.9, gap = L * 0.035;
  return Array.from({ length: 5 }, (_, lane) => {
    const path = new Float32Array(STATIONS * 3);
    const side = lane >= 3, sign = lane === 3 ? -1 : 1;
    for (let i = 0; i < STATIONS; i++) {
      const x = start + (end - start) * i / (STATIONS - 1), crosswind = (x - c.x) * Math.tan(yaw);
      let y = c.y + (side ? sign * W * 0.28 : (lane - 1) * W * 0.22) + crosswind;
      let z = box.min.z + H * (side ? 0.43 : 0.42);
      if (x >= box.min.x && x <= box.max.x) {
        const xb = bin(x, box.min.x, L, NX);
        if (!side && y >= box.min.y && y <= box.max.y) {
          const yb = bin(y, box.min.y, W, N);
          for (let yy = Math.max(0, yb - 1); yy <= Math.min(N - 1, yb + 1); yy++) z = Math.max(z, top[xb * N + yy] + gap);
        } else if (side) {
          const zb = bin(z, box.min.z, H, N);
          for (let zz = Math.max(0, zb - 1); zz <= Math.min(N - 1, zb + 1); zz++) {
            y = sign > 0 ? Math.max(y, left[xb * N + zz] + gap) : Math.min(y, right[xb * N + zz] - gap);
          }
        }
      }
      path.set([x, y, z], i * 3);
    }
    // Begin bending upstream of the nose and relax into a short wake, avoiding abrupt steps.
    const coordinate = side ? 1 : 2, direction = side ? sign : 1;
    const raw = path.slice();
    for (let i = 0; i < STATIONS; i++) {
      let envelope = direction * raw[i * 3 + coordinate];
      for (let j = 0; j < STATIONS; j++) envelope = Math.max(envelope, direction * raw[j * 3 + coordinate] - Math.abs(raw[i * 3] - raw[j * 3]) * 0.8);
      path[i * 3 + coordinate] = direction * envelope;
    }
    return path;
  });
}

/** Overlapping soft sprites make continuous smoke ribbons; moving wisps reveal their direction. */
export class ShapeSmokePreview {
  readonly group = new THREE.Group();
  readonly material = new THREE.ShaderMaterial({
    uniforms: {
      uDistance: { value: 0 }, uYaw: { value: 0 }, uLength: { value: 1 }, uSize: { value: 0.1 }, uViewportHeight: { value: 800 },
      uPaths: { value: null as THREE.DataTexture | null }, uColor: { value: new THREE.Color(0xd4e7ef) }, uOpacity: { value: 0.22 },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase, aLane, aSeed;
      uniform sampler2D uPaths;
      uniform float uDistance, uLength, uSize, uViewportHeight;
      varying float vAlpha;
      void main() {
        float t = fract(aPhase + uDistance / uLength);
        vec3 p = texture2D(uPaths, vec2(t, (aLane + 0.5) / 5.0)).xyz;
        float wake = smoothstep(0.58, 0.95, t);
        float wiggle = sin(t * 55.0 - uDistance * 3.0 + aSeed * 6.28);
        p.y += wiggle * uSize * (0.12 + 0.35 * wake);
        p.z += cos(t * 43.0 - uDistance * 2.0 + aSeed * 6.28) * uSize * (0.08 + 0.22 * wake);
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp(uSize * (1.0 + 0.4 * wake) * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(0.1, -view.z), 2.0, 160.0);
        vAlpha = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.85, 1.0, t)) * (0.65 + 0.35 * wiggle);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float alpha = exp(-r * 4.0) * (1.0 - smoothstep(0.5, 1.0, r));
        gl_FragColor = vec4(uColor, alpha * vAlpha * uOpacity);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
  private parts: Float32Array[] = [];
  private texture: THREE.DataTexture | null = null;
  constructor() {
    const perStream = 480, count = 5 * perStream, geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const phase = new Float32Array(count), lane = new Float32Array(count), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) { phase[i] = (i % perStream) / perStream; lane[i] = Math.floor(i / perStream); seed[i] = (i * 0.61803398875) % 1; }
    geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute("aLane", new THREE.BufferAttribute(lane, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.group.add(points);
  }
  setGeometry(parts: Float32Array[]) {
    if (parts.length === this.parts.length && parts.every((p, i) => p === this.parts[i])) return;
    this.parts = parts;
    this.rebuild();
  }
  setYaw(yaw: number) {
    if (this.material.uniforms.uYaw.value === yaw) return;
    this.material.uniforms.uYaw.value = yaw;
    this.rebuild();
  }
  private rebuild() {
    const paths = previewSmokePaths(this.parts, this.material.uniforms.uYaw.value);
    this.texture?.dispose();
    this.texture = null;
    if (!paths.length) return;
    const data = new Float32Array(STATIONS * 5 * 4);
    paths.forEach((p, lane) => { for (let i = 0; i < STATIONS; i++) data.set([p[i * 3], p[i * 3 + 1], p[i * 3 + 2], 1], (lane * STATIONS + i) * 4); });
    this.texture = new THREE.DataTexture(data, STATIONS, 5, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.material.uniforms.uPaths.value = this.texture;
    const L = paths[0][(STATIONS - 1) * 3] - paths[0][0];
    this.material.uniforms.uLength.value = L;
    this.material.uniforms.uSize.value = L * 0.035;
  }
  dispose() {
    this.texture?.dispose();
    for (const p of this.group.children as THREE.Points[]) p.geometry.dispose();
    this.material.dispose();
  }
}
