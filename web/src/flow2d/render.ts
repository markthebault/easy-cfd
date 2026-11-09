import { inside, type Point } from "./geometry";
import { LEGACY_GRID, cellSize, type Grid } from "./grid";
import { coreContours, vortexCores } from "./vortices";
import { Smoke2D } from "./Smoke2D";
import { INLET } from "./lattice";
import { FlowDye } from "./dye";
import { isEnabled, sceneMask, type Shape } from "./scene";

export type AnimationMode = "smoke" | "trails" | "arrows" | "none" | "vortex";
export type Layer = "flow" | "pressure" | "vorticity";
export type Viewport = { x: number; y: number; scale: number; width: number; height: number; domain: Grid };
export type Camera = { zoom: number; pan: Point };
type Particle = { x: number; y: number; age: number; life: number; trail: Point[]; lane: number };
const FLOW_COLORS = [[18, 29, 63], [24, 72, 118], [37, 147, 174], [172, 241, 230]];
const NEGATIVE_COLOR = [40, 153, 238], POSITIVE_COLOR = [247, 112, 73];
export function viewport(width: number, height: number, camera?: Camera, domain: Grid = LEGACY_GRID): Viewport {
  const DOMAIN = domain;
  const mobile = width < 600;
  const scale = domain.id === "legacy" ? (mobile ? (width - 24) / 1.9 : Math.min((width - 80) / domain.width, Math.max(100, height - 245) / domain.height)) : Math.min((width - (mobile ? 24 : 80)) / domain.width, Math.max(100, height - (mobile ? 560 : 445)) / domain.height);
  const base = { x: mobile && domain.id === "legacy" ? width / 2 - 1.4 * scale : (width - DOMAIN.width * scale) / 2, y: height - (mobile ? 260 : 185) - DOMAIN.height * scale, scale, width, height, domain };
  if (!camera) return base;
  const center = { x: base.x + DOMAIN.width * scale / 2, y: base.y + DOMAIN.height * scale / 2 };
  return { ...base, x: center.x + (base.x - center.x) * camera.zoom + camera.pan.x, y: center.y + (base.y - center.y) * camera.zoom + camera.pan.y, scale: scale * camera.zoom };
}
export const screenPoint = (p: Point, v: Viewport) => ({ x: v.x + p.x * v.scale, y: v.y + (v.domain.height - p.y) * v.scale });
export const worldPoint = (p: Point, v: Viewport) => ({ x: (p.x - v.x) / v.scale, y: v.domain.height - (p.y - v.y) / v.scale });
export function zoomCamera(camera: Camera, zoom: number, width: number, height: number, cursor?: Point, domain: Grid = LEGACY_GRID): Camera {
  const DOMAIN = domain;
  const base = viewport(width, height, undefined, domain), at = cursor ?? { x: base.x + DOMAIN.width * base.scale / 2, y: base.y + DOMAIN.height * base.scale / 2 };
  const point = worldPoint(at, viewport(width, height, camera, domain)), next = { zoom: Math.max(.5, Math.min(6, zoom)), pan: { x: 0, y: 0 } };
  const screen = screenPoint(point, viewport(width, height, next, domain));
  return { ...next, pan: { x: at.x - screen.x, y: at.y - screen.y } };
}

export class FlowRenderer {
  field: Float32Array | null = null;
  vortexParticles: Float32Array | null = null;
  shapes: Shape[] = [];
  animation: AnimationMode = "smoke";
  private solid!: Float32Array;
  private dye!: FlowDye;
  private smoke = document.createElement("canvas");
  private animationTime = 0;
  private smokeClock = 0;
  private gpuSmoke: Smoke2D | null = null;
  private lastSteps = 0;
  private flowTime = 0;
  private coreLines: number[][] = [];
  layer: Layer = "flow";
  playing = true;
  playback = 1;
  dark = true;
  trails = true;
  particles: Particle[] = [];
  private heat = document.createElement("canvas");
  private dirty = true;
  constructor(public grid: Grid = LEGACY_GRID) {
    this.allocateGrid();
    for (let i = 0; i < 1200; i++) this.particles.push(this.seed(true));
  }
  private allocateGrid() {
    const {nx: NX, ny: NY} = this.grid;
    this.solid = new Float32Array(NX * NY); this.dye = new FlowDye(this.grid);
    this.heat.width = NX; this.heat.height = NY; this.smoke.width = NX; this.smoke.height = NY;
    try { this.gpuSmoke = new Smoke2D(this.grid); } catch { this.gpuSmoke = null; }
  }
  private seed(randomX = false): Particle {
    const DOMAIN = this.grid;
    const lane = Math.floor(Math.random() * 40);
    return { x: randomX ? Math.random() * DOMAIN.width : .01, y: DOMAIN.height * (.015 + (lane + Math.random() * .3) / 40 * .97), age: 0, life: 3 + Math.random() * 9, trail: [], lane };
  }
  update(field: Float32Array, steps = this.lastSteps) { const {nx: NX} = this.grid, DOMAIN = this.grid; this.flowTime += Math.max(0, steps - this.lastSteps) * INLET * DOMAIN.width / (NX - 1); this.lastSteps = steps; this.field = field; this.dirty = true; this.coreLines = this.layer === "vorticity" ? coreContours(vortexCores(field, this.solid, this.grid), 5 * 4.2 / this.grid.width, this.grid) : []; this.gpuSmoke?.update(field, this.solid); }
  clear(shapes: Shape[], grid = this.grid) { if (grid !== this.grid) { this.gpuSmoke?.dispose(); this.grid = grid; this.allocateGrid(); } this.shapes = shapes; this.solid = sceneMask(shapes.filter(isEnabled).map(s => s.points), grid.nx, grid.ny, grid); this.field = null; this.vortexParticles = null; this.dirty = true; this.coreLines = []; this.dye.reset(); this.gpuSmoke?.reset(); this.lastSteps = 0; this.flowTime = 0; this.animationTime = 0; this.particles = this.particles.map(() => this.seed(true)); }
  setAnimation(animation: AnimationMode) { this.animation = animation; this.particles.forEach(p => { p.trail = []; }); }
  sample(x: number, y: number, component: number) {
    const {nx: NX, ny: NY} = this.grid, DOMAIN = this.grid;
    if (!this.field) return component === 0 ? 1 : 0;
    const gx = Math.max(0, Math.min(NX - 1.001, x / DOMAIN.width * (NX - 1)));
    const gy = Math.max(0, Math.min(NY - 1.001, y / DOMAIN.height * (NY - 1)));
    const ix = Math.floor(gx), iy = Math.floor(gy), dx = gx - ix, dy = gy - iy, offset = component * NX * NY + iy * NX + ix;
    return (this.field[offset] * (1 - dx) + this.field[offset + 1] * dx) * (1 - dy) + (this.field[offset + NX] * (1 - dx) + this.field[offset + NX + 1] * dx) * dy;
  }
  private heatmap() {
    const {nx: NX, ny: NY} = this.grid, DOMAIN = this.grid;
    const ctx = this.heat.getContext("2d")!;
    const image = ctx.createImageData(NX, NY), field = this.field;
    if (field) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = y * NX + x, cp = field[2 * NX * NY + i];
      const speed = Math.hypot(field[i], field[NX * NY + i]);
      const curl = x > 0 && x < NX - 1 && y > 0 && y < NY - 1 ? (field[NX * NY + i + 1] - field[NX * NY + i - 1]) / (2 * DOMAIN.width / (NX - 1)) - (field[i + NX] - field[i - NX]) / (2 * DOMAIN.height / (NY - 1)) : 0;
      const value = this.layer === "vorticity" ? Math.tanh(curl / 9) : this.layer === "pressure" ? cp / 2.5 : (speed - 1) * 1.3;
      const strength = Math.min(1, Math.abs(value) ** (this.layer === "vorticity" ? .65 : 1));
      const color = value < 0 ? NEGATIVE_COLOR : POSITIVE_COLOR;
      const j = ((NY - 1 - y) * NX + x) * 4;
      if (this.layer === "flow") {
        const t = Math.max(0, Math.min(1, speed / 1.65));
        const band = Math.min(2, Math.floor(t * 3)), f = t * 3 - band;
        for (let c = 0; c < 3; c++) image.data[j + c] = FLOW_COLORS[band][c] * (1 - f) + FLOW_COLORS[band + 1][c] * f;
      } else { image.data[j] = color[0]; image.data[j + 1] = color[1]; image.data[j + 2] = color[2]; }
      image.data[j + 3] = this.layer === "flow" ? 210 : strength * (this.layer === "vorticity" ? 225 : 165);
    }
    ctx.putImageData(image, 0, 0); this.dirty = false;
  }
  draw(ctx: CanvasRenderingContext2D, v: Viewport, dt: number) {
    const {nx: NX, ny: NY} = this.grid, DOMAIN = this.grid;
    const { width, height, scale } = v;
    ctx.clearRect(0, 0, width, height);
    const ground = screenPoint({ x: 0, y: 0 }, v).y;
    const halo = ctx.createRadialGradient(width * .43, ground - scale * .2, 20, width * .43, ground - scale * .2, width * .65);
    halo.addColorStop(0, this.dark ? "#122b3a" : "#d9e9f0"); halo.addColorStop(1, this.dark ? "#0a1019" : "#edf3f7");
    ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x, v.y, DOMAIN.width * scale, DOMAIN.height * scale); ctx.clip();
    ctx.fillStyle = this.dark ? "#7d9bb51a" : "#56728d22";
    for (let x = 0; x <= DOMAIN.width; x += DOMAIN.width / 42) for (let y = 0; y <= DOMAIN.height; y += DOMAIN.width / 42) {
      const p = screenPoint({ x, y }, v); ctx.fillRect(p.x, p.y, 1, 1);
    }
    if (this.animation !== "vortex") {
    if (this.dirty) this.heatmap();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.heat, v.x, v.y, DOMAIN.width * scale, DOMAIN.height * scale);
    if (this.layer === "vorticity" && this.coreLines.length) {
      ctx.strokeStyle = this.dark ? "#b5eef47a" : "#246e9e80"; ctx.lineWidth = .8; ctx.beginPath();
      for (const [x0,y0,x1,y1] of this.coreLines) { const a = screenPoint({x:x0,y:y0},v), b = screenPoint({x:x1,y:y1},v); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); }
      ctx.stroke();
    }
    if (this.playing) this.animationTime += dt * this.playback;
    const flowDt = this.playing ? Math.min(this.flowTime, dt * 6 * cellSize(this.grid) / cellSize(LEGACY_GRID)) : 0;
    this.flowTime = Math.max(0, this.flowTime - flowDt);
    if (this.field && this.animation === "smoke" && this.gpuSmoke) {
      ctx.drawImage(this.gpuSmoke.render(flowDt, this.dark, this.layer === "flow" ? .42 : .22), v.x, v.y, DOMAIN.width * scale, DOMAIN.height * scale);
    }
    if (this.field && this.animation === "smoke" && !this.gpuSmoke) {
      if (this.playing) this.smokeClock += dt;
      if (this.smokeClock >= 1 / 30) {
      this.dye.step(this.field, this.solid, Math.min(this.smokeClock, .08) * this.playback); this.smokeClock = 0;
      const smokeContext = this.smoke.getContext("2d")!, image = smokeContext.createImageData(NX, NY);
      for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
        const i = y * NX + x, j = ((NY - y - 1) * NX + x) * 4;
        image.data[j] = this.dark ? 158 : 35; image.data[j + 1] = this.dark ? 223 : 116; image.data[j + 2] = this.dark ? 239 : 156;
        image.data[j + 3] = this.solid[i] ? 0 : Math.min(1, this.dye.values[i]) ** .7 * (this.layer === "flow" ? 200 : 90);
      }
      smokeContext.putImageData(image, 0, 0);
      }
      ctx.drawImage(this.smoke, v.x, v.y, DOMAIN.width * scale, DOMAIN.height * scale);
    }
    if (this.field && this.animation === "arrows") {
      ctx.strokeStyle = this.dark ? "#b5ecf1b0" : "#267a9fb0"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = 4; y < NY - 3; y += 7) for (let x = 3; x < NX - 3; x += 8) {
        const wx = (x + (this.animationTime * 5 % 8)) / (NX - 1) * DOMAIN.width, wy = y / (NY - 1) * DOMAIN.height;
        if (this.shapes.some(s => isEnabled(s) && inside(wx, wy, s.points))) continue;
        const u = this.sample(wx, wy, 0), w = this.sample(wx, wy, 1), speed = Math.hypot(u, w);
        if (speed < .02) continue;
        const p = screenPoint({ x: wx, y: wy }, v), length = Math.min(17, 9 * speed), dx = u / speed * length, dy = -w / speed * length;
        ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + dx, p.y + dy);
        ctx.moveTo(p.x + dx - dx * .3 + dy * .25, p.y + dy - dy * .3 - dx * .25); ctx.lineTo(p.x + dx, p.y + dy); ctx.lineTo(p.x + dx - dx * .3 - dy * .25, p.y + dy - dy * .3 + dx * .25);
      }
      ctx.stroke();
    }
    if (this.trails && this.field && this.animation === "trails") {
      // Batch by colour/opacity instead of submitting two canvas draws per particle.
      const paths = Array.from({ length: 8 }, () => new Path2D());
      const heads = Array.from({ length: 8 }, () => new Path2D());
      for (let i = 0; i < this.particles.length; i++) {
        let p = this.particles[i];
        if (this.playing) {
          const step = flowDt;
          const u = this.sample(p.x, p.y, 0), w = this.sample(p.x, p.y, 1);
          const mx = p.x + u * step / 2, my = p.y + w * step / 2;
          p.x += this.sample(mx, my, 0) * step; p.y += this.sample(mx, my, 1) * step; p.age += dt * this.playback;
          if (p.x > DOMAIN.width || p.x < 0 || p.y < .006 || p.y > DOMAIN.height || p.age > p.life || this.shapes.some(s => isEnabled(s) && (inside(p.x, p.y, s.points) || inside(mx, my, s.points)))) {
            this.particles[i] = this.seed(); continue;
          }
          p.trail.push({ x: p.x, y: p.y }); if (p.trail.length > 24) p.trail.shift();
        }
        if (p.trail.length < 2) continue;
        const speed = Math.hypot(this.sample(p.x, p.y, 0), this.sample(p.x, p.y, 1));
        const bin = (speed > 1.2 ? 4 : 0) + i % 4;
        const path = paths[bin];
        p.trail.forEach((q, j) => { const x = v.x + q.x * scale, y = v.y + (DOMAIN.height - q.y) * scale; if (!j) path.moveTo(x, y); else path.lineTo(x, y); });
        const head = screenPoint(p, v);
        const radius = i % 5 === 0 ? 1.5 : .9;
        heads[bin].moveTo(head.x + radius, head.y); heads[bin].arc(head.x, head.y, radius, 0, Math.PI * 2);
      }
      for (let bin = 0; bin < 8; bin++) {
        ctx.strokeStyle = this.dark ? `rgba(${bin >= 4 ? "113,237,239" : "130,187,225"},${.13 + (bin % 4) * .055})` : "rgba(27,109,161,.35)";
        ctx.lineWidth = .85; ctx.stroke(paths[bin]);
        ctx.fillStyle = this.dark ? (bin >= 4 ? "#b9ffff" : "#afd8ef") : "#297fab";
        ctx.globalAlpha = .35 + (bin % 4) * .15; ctx.fill(heads[bin]); ctx.globalAlpha = 1;
      }
    }
    }
    if (this.animation === "vortex" && this.vortexParticles) {
      let max = 0;const values = this.vortexParticles;
      for (let i = 2; i < values.length; i += 4) max = Math.max(max, Math.abs(values[i]));
      const paths = Array.from({length: 8}, () => new Path2D());
      for (let i = 0; i < values.length; i += 4) {
        const strength = Math.sqrt(Math.abs(values[i + 2]) / Math.max(max, 1e-12));
        if (!Number.isFinite(strength) || Math.abs(values[i + 2]) < 1e-12) continue;
        const p = screenPoint({x: values[i], y: values[i + 1]}, v), radius = .8 + Math.min(2, strength * 2);
        const bin = (values[i + 2] > 0 ? 4 : 0) + Math.min(3, Math.floor(strength * 4));
        paths[bin].moveTo(p.x + radius, p.y);paths[bin].arc(p.x, p.y, radius, 0, 2 * Math.PI);
      }
      for (let i = 0; i < paths.length; i++) {ctx.fillStyle = i >= 4 ? "#fa7569" : "#66aaff";ctx.globalAlpha = .35 + i % 4 * .2;ctx.fill(paths[i]);}ctx.globalAlpha = 1;
    }
    ctx.restore();
    // The body covers the field and trails, including antialiased boundary cells.
    for (const shape of this.shapes) {
      ctx.save(); if (!isEnabled(shape)) { ctx.globalAlpha = .35; ctx.setLineDash([5, 5]); }
      ctx.beginPath(); shape.points.forEach((p, i) => { const s = screenPoint(p, v); if (!i) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }); ctx.closePath();
      ctx.fillStyle = this.dark ? "#101822" : "#526477"; if (isEnabled(shape)) ctx.fill();
      ctx.shadowColor = this.dark ? "#9ccce744" : "transparent"; ctx.shadowBlur = 16;
      ctx.lineWidth = 1.7; ctx.strokeStyle = this.dark ? "#b3c7d7" : "#344a60"; ctx.stroke(); ctx.shadowBlur = 0; ctx.restore();
    }
    ctx.strokeStyle = this.dark ? "#7692a953" : "#6c879d70"; ctx.lineWidth = 1;
    const groundLeft = Math.max(0, v.x), groundRight = Math.min(width, v.x + DOMAIN.width * scale);
    ctx.beginPath(); ctx.moveTo(groundLeft, ground + 8); ctx.lineTo(groundRight, ground + 8); ctx.stroke();
    ctx.strokeStyle = this.dark ? "#7692a925" : "#6c879d35";
    for (let x = v.x + Math.ceil((groundLeft - v.x) / 18) * 18; x < groundRight; x += 18) { ctx.beginPath(); ctx.moveTo(x, ground + 9); ctx.lineTo(x - 10, ground + 19); ctx.stroke(); }
    ctx.font = "10px ui-monospace, monospace"; ctx.fillStyle = this.dark ? "#7692a9" : "#60758a";
    const ideal = Math.min(180, width * .25) / scale, power = 10 ** Math.floor(Math.log10(ideal));
    const rulerMetres = ([1, 2, 5, 10].filter(n => n <= ideal / power).at(-1) ?? 1) * power;
    const rulerWidth = scale * rulerMetres, rulerX = width - 38 - rulerWidth;
    ctx.fillText(rulerMetres >= 1 ? `${rulerMetres} m` : `${Math.round(rulerMetres * 1000)} mm`, rulerX + rulerWidth / 2 - 20, ground + 40);
    ctx.strokeStyle = this.dark ? "#7692a9" : "#60758a";
    ctx.beginPath(); ctx.moveTo(rulerX, ground + 28); ctx.lineTo(rulerX + rulerWidth, ground + 28); ctx.stroke();
  }
  dispose() { this.gpuSmoke?.dispose(); }
  setLayer(layer: Layer) { this.layer = layer; this.dirty = true; this.coreLines = layer === "vorticity" && this.field ? coreContours(vortexCores(this.field, this.solid, this.grid), 5 * 4.2 / this.grid.width, this.grid) : []; }
}
