import * as T from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { TrackPath, ROAD_HEIGHT } from './trackPath';
import { TrackTerrain, type TerrainInput } from './terrain';

export function makeSky() {
  const sky = new Sky();
  sky.name = 'Daylight skybox';
  sky.scale.setScalar(400000);
  sky.material.depthWrite = false;
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.7;
  u.mieCoefficient.value = .004;
  u.mieDirectionalG.value = .8;
  u.sunPosition.value.copy(new T.Vector3(-.4, .65, -.45).normalize());
  return sky;
}

function asphaltTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(256, 256);
  // Fixed fine aggregate: texture only, no changes to the flow or geometry.
  let seed = 1928;
  for (let i = 0; i < data.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const v = 70 + ((seed >>> 24) / 255 - .5) * 16;
    data.data.set([v, v + 2, v + 3, 255], i);
  }
  ctx.putImageData(data, 0, 0);
  const texture = new T.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.colorSpace = T.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Swept strips share sampled positions, so kerbs follow corners and grades without separate boxes. */
export class TrackEnvironment {
  readonly group = new T.Group();
  readonly materials: T.MeshStandardMaterial[] = [];
  readonly road: T.Mesh;
  readonly terrain: TrackTerrain;
  readonly kerbs: T.Mesh[] = [];
  private asphalt = asphaltTexture();
  opacity = 1;

  constructor(readonly path: TrackPath, terrainInput?: TerrainInput) {
    this.group.name = 'Track surface';
    this.terrain = new TrackTerrain(path, terrainInput);
    const earth = new T.Mesh(this.terrain.geometry, this.material({ color: 0x72905b, roughness: 1 })); earth.name = 'Conformed terrain'; this.group.add(earth);
    const ground = new T.Mesh(new T.PlaneGeometry(20000, 20000), this.material({ color: 0x6d8156, roughness: 1 }));
    ground.name = 'Terrain'; ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.terrain.base - .02;
    this.group.add(ground);
    this.strip(-10, 10, -.04, this.material({ color: 0x72905b, roughness: 1 }), 'Grass verge');
    this.strip(-7.3, 7.3, 0, this.material({ color: 0xa4a08a, roughness: 1 }), 'Shoulder');
    this.road = this.strip(-6, 6, ROAD_HEIGHT, this.material({ map: this.asphalt, color: 0xc6c8c9, roughness: .95 }), 'Asphalt');
    const paint = this.material({ color: 0xf2f0df, roughness: .85 });
    this.strip(-5.85, -5.71, ROAD_HEIGHT + .006, paint, 'Left edge');
    this.strip(5.71, 5.85, ROAD_HEIGHT + .006, paint, 'Right edge');
    const kerbMat = this.material({ vertexColors: true, roughness: .8 });
    for (const side of [-1, 1]) this.kerbs.push(this.strip(side * 6, side * 6.85, ROAD_HEIGHT + .025, kerbMat, 'Continuous corner kerb', true));
  }
  private material(options: T.MeshStandardMaterialParameters) {
    const m = new T.MeshStandardMaterial({ ...options, side: T.DoubleSide, transparent: true });
    this.materials.push(m); return m;
  }
  private strip(a: number, b: number, height: number, material: T.MeshStandardMaterial, name: string, kerb = false) {
    const count = Math.ceil(this.path.length / 1.25), positions: number[] = [], uv: number[] = [], colors: number[] = [], indices: number[] = [];
    const red = new T.Color(0xc84137), white = new T.Color(0xf5eee4);
    for (let i = 0; i <= count; i++) {
      const t = i / count, s = this.path.at(t);
      // Crossfall is not invented: only the supplied longitudinal grade is used.
      for (const w of [Math.min(a, b), Math.max(a, b)]) {
        const p = s.position.clone().addScaledVector(s.right, w).addScaledVector(s.up, height);
        positions.push(p.x, p.y, p.z); uv.push(w / 4, t * this.path.length / 4);
        const c = Math.floor(t * this.path.length / 2.5) % 2 ? red : white;
        colors.push(c.r, c.g, c.b);
      }
      if (i === count) continue;
      const before = this.path.at(t - 6 / this.path.length).forward;
      const after = this.path.at(t + 6 / this.path.length).forward;
      // These are schematic kerb locations, restricted to bends rather than dashed boxes on straights.
      if (kerb && before.angleTo(after) < .065) continue;
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    if (kerb) geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = new T.Mesh(geometry, material); mesh.name = name; mesh.receiveShadow = true;
    mesh.renderOrder = 0; this.group.add(mesh); return mesh;
  }
  update(camera: T.Camera, roadPoint: T.Vector3, up: T.Vector3, dt: number) {
    const below = camera.position.clone().sub(roadPoint).dot(up) < -.08;
    const target = below ? .055 : 1;
    this.opacity = T.MathUtils.lerp(this.opacity, target, 1 - Math.exp(-12 * dt));
    if (Math.abs(this.opacity - target) < .002) this.opacity = target;
    for (const material of this.materials) {
      material.opacity = this.opacity;
      material.depthWrite = this.opacity > .98;
    }
    this.group.traverse(o => { if (o instanceof T.Mesh) o.receiveShadow = !below; });
  }
  dispose() {
    this.group.traverse(o => { if (o instanceof T.Mesh) o.geometry.dispose(); });
    this.materials.forEach(m => m.dispose()); this.asphalt.dispose();
  }
}
