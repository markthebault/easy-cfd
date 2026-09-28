// Scene furniture: road, labels, airflow arrow, tunnel box and the orientation cube.

import * as THREE from "three";

export function labelTexture(text: string, opts: { fg: string; bg: string; size?: number; weight?: number; pad?: number }): THREE.CanvasTexture {
  const size = opts.size ?? 44;
  const pad = opts.pad ?? 18;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = `${opts.weight ?? 650} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = size + pad * 1.4;
  c.width = w;
  c.height = h;
  ctx.font = font;
  ctx.fillStyle = opts.bg;
  const r = h / 2;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fill();
  ctx.fillStyle = opts.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + size * 0.04);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Screen-sized label (sizeAttenuation off), always drawn on top. */
export function labelSprite(text: string, fg: string, bg: string, height = 0.035): THREE.Sprite {
  const tex = labelTexture(text, { fg, bg });
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true });
  const s = new THREE.Sprite(m);
  const img = tex.image as HTMLCanvasElement;
  s.scale.set((height * img.width) / img.height, height, 1);
  s.renderOrder = 20;
  return s;
}

/** Flat arrow on the road pointing downstream (+X). */
export function flowArrow(length: number, width: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const s = new THREE.Shape();
  const hw = width / 2, head = Math.min(length * 0.35, width * 1.6);
  s.moveTo(0, -hw * 0.45);
  s.lineTo(length - head, -hw * 0.45);
  s.lineTo(length - head, -hw);
  s.lineTo(length, 0);
  s.lineTo(length - head, hw);
  s.lineTo(length - head, hw * 0.45);
  s.lineTo(0, hw * 0.45);
  s.closePath();
  const m = new THREE.Mesh(
    new THREE.ShapeGeometry(s),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  m.position.z = 0.002;
  m.renderOrder = 1;
  return m;
}

/** Road with a fading grid, drawn in a shader so it has no visible edge. */
export function road(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x1a1d23) },
      uLine: { value: new THREE.Color(0x2c313a) },
      uFade: { value: 18 },
      uCell: { value: 0.5 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uLine; uniform float uFade; uniform float uCell;
      varying vec3 vWorld;
      void main() {
        vec2 g = vWorld.xy / uCell;
        vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        float line = 1.0 - min(min(d.x, d.y), 1.0);
        vec2 g2 = vWorld.xy / (uCell * 5.0);
        vec2 d2 = abs(fract(g2 - 0.5) - 0.5) / fwidth(g2);
        float major = 1.0 - min(min(d2.x, d2.y), 1.0);
        float r = length(vWorld.xy) / uFade;
        float fade = 1.0 - smoothstep(0.35, 1.0, r);
        vec3 col = mix(uColor, uLine, max(line * 0.55, major) * fade);
        gl_FragColor = vec4(col, fade);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
  m.renderOrder = -1;
  return m;
}

export function tunnelBox(domain: number[]): THREE.Group {
  const [x0, x1, y0, y1, z0, z1] = domain;
  const g = new THREE.Group();
  const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)),
    new THREE.LineBasicMaterial({ color: 0x5aa2ff, transparent: true, opacity: 0.9 }),
  );
  const faces = new THREE.Mesh(
    new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0),
    new THREE.MeshBasicMaterial({ color: 0x5aa2ff, transparent: true, opacity: 0.05, side: THREE.BackSide, depthWrite: false }),
  );
  const c = box.getCenter(new THREE.Vector3());
  edges.position.copy(c);
  faces.position.copy(c);
  // Inlet face highlighted so the direction of the box reads at a glance.
  const inlet = new THREE.Mesh(
    new THREE.PlaneGeometry(z1 - z0, y1 - y0),
    new THREE.MeshBasicMaterial({ color: 0x5aa2ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
  );
  inlet.rotation.set(0, Math.PI / 2, 0);
  inlet.position.set(x0, c.y, c.z);
  g.add(faces, edges, inlet);
  const inletLabel = labelSprite("INLET", "#ffffff", "rgba(40,110,220,0.9)", 0.02);
  inletLabel.position.set(x0, c.y, z1);
  const outletLabel = labelSprite("OUTLET", "#ffffff", "rgba(40,110,220,0.9)", 0.02);
  outletLabel.position.set(x1, c.y, z1);
  g.add(inletLabel, outletLabel);
  g.renderOrder = 3;
  return g;
}

/** Wireframe outlines of detail boxes ([x0, x1, y0, y1, z0, z1] each). */
export function detailBoxes(boxes: number[][]): THREE.Group {
  const g = new THREE.Group();
  for (const [x0, x1, y0, y1, z0, z1] of boxes) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3), Math.max(z1 - z0, 1e-3))),
      new THREE.LineBasicMaterial({ color: 0xffa23d, transparent: true, opacity: 0.95, depthTest: false }),
    );
    edges.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    edges.renderOrder = 4;
    g.add(edges);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Orientation cube
// ---------------------------------------------------------------------------------------------

export type ViewName = "front" | "side" | "top" | "rear" | "iso";

export class OrientationCube {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.1, 10);
  private cube: THREE.Mesh;
  private materials: THREE.MeshBasicMaterial[] = [];
  private raycaster = new THREE.Raycaster();
  private dark = true;

  constructor() {
    // Car-like proportions: long in X (nose at −X), narrower in Y, low in Z.
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.8), []);
    this.scene.add(this.cube);
    const arrow = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x3f9bff });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12), mat);
    shaft.rotation.z = -Math.PI / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.28, 16), mat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = 0.85;
    arrow.add(shaft, head);
    arrow.position.set(0, -0.78, -0.25);
    const air = labelSprite("AIR", "#ffffff", "rgba(40,120,230,0.95)", 0.3);
    air.position.set(-0.95, -0.78, -0.25);
    this.scene.add(arrow, air);
    this.setTheme(true);
  }

  setTheme(dark: boolean) {
    this.dark = dark;
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }
    const bg = dark ? "#2a2f38" : "#f4f5f7";
    const fg = dark ? "#e8ecf2" : "#1b1f26";
    // uExt/vExt: face size along the texture axes; rot turns the text so it reads upright with Z up.
    const face = (text: string, uExt: number, vExt: number, rot: number, accent = false) => {
      const c = document.createElement("canvas");
      c.width = Math.round(256 * uExt);
      c.height = Math.round(256 * vExt);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = accent ? (dark ? "#1f5fbf" : "#2a78d6") : bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 12;
      ctx.strokeRect(6, 6, c.width - 12, c.height - 12);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(rot);
      const along = Math.abs(Math.sin(rot)) > 0.5 ? c.height : c.width;
      ctx.fillStyle = accent ? "#ffffff" : fg;
      ctx.font = `750 ${Math.min(72, (along * 0.78) / Math.max(3, text.length * 0.62))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 0, 4);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return new THREE.MeshBasicMaterial({ map: t });
    };
    const P = Math.PI;
    // BoxGeometry faces: +X, −X, +Y, −Y, +Z, −Z (texture axes derived from three's box UV layout).
    this.materials = [
      face("REAR", 0.8, 1.0, -P / 2),
      face("FRONT", 0.8, 1.0, P / 2, true),
      face("SIDE", 1.5, 0.8, P),
      face("SIDE", 1.5, 0.8, 0),
      face("TOP", 1.5, 1.0, 0),
      face("BELOW", 1.5, 1.0, 0),
    ];
    this.cube.material = this.materials;
  }

  get isDark() {
    return this.dark;
  }

  sync(main: THREE.Camera, target: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(main.position, target).normalize();
    this.camera.position.copy(dir.multiplyScalar(4));
    this.camera.up.copy(main.up);
    this.camera.lookAt(0, 0, 0);
  }

  /** Which view a click at normalised device coords (inside the cube viewport) asks for. */
  pick(ndc: THREE.Vector2): ViewName | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube)[0];
    if (!hit || hit.face == null) return null;
    const n = hit.face.normal;
    if (n.x < -0.5) return "front";
    if (n.x > 0.5) return "rear";
    if (Math.abs(n.y) > 0.5) return "side";
    if (n.z > 0.5) return "top";
    return "iso";
  }
}
