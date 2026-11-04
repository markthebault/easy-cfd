import * as THREE from "three";
import { LEGACY_GRID, type Grid } from "./grid";

const VERT = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
/** The 3D viewer's bounded MacCormack smoke approach, on a 2D solver field. */
export class Smoke2D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private dye: THREE.WebGLRenderTarget;
  private predicted: THREE.WebGLRenderTarget;
  private next: THREE.WebGLRenderTarget;
  private velocityData: Uint16Array;
  private velocity: THREE.DataTexture;
  private advection: THREE.ShaderMaterial;
  private display: THREE.ShaderMaterial;
  private needsReset = true;
  private time = 0;
  constructor(private grid: Grid = LEGACY_GRID) {
    const {nx: NX, ny: NY} = grid, DOMAIN = grid;
    this.velocityData = new Uint16Array(NX * NY * 4);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, premultipliedAlpha: false });
    if (!this.renderer.extensions.has("EXT_color_buffer_float")) { this.renderer.dispose(); throw new Error("Floating-point smoke targets are unavailable."); }
    const width = 1024, height = Math.round(width * DOMAIN.height / DOMAIN.width);
    this.renderer.setSize(width, height, false); this.renderer.setClearColor(0, 0);
    const target = () => new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
    this.dye = target(); this.predicted = target(); this.next = target();
    this.velocity = new THREE.DataTexture(this.velocityData, NX, NY, THREE.RGBAFormat, THREE.HalfFloatType);
    this.velocity.minFilter = this.velocity.magFilter = THREE.LinearFilter;
    this.advection = new THREE.ShaderMaterial({ vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { uVelocity: { value: this.velocity }, uDye: { value: null }, uPredicted: { value: this.predicted.texture }, uDt: { value: 0 }, uDecay: { value: 1 }, uTime: { value: 0 }, uPass: { value: 0 }, uReset: { value: true }, uSize: { value: new THREE.Vector2(width, height) }, uDomain: { value: new THREE.Vector2(DOMAIN.width, DOMAIN.height) } },
      fragmentShader: `varying vec2 vUv;uniform sampler2D uVelocity,uDye,uPredicted;uniform float uDt,uTime,uDecay;uniform int uPass;uniform bool uReset;uniform vec2 uSize,uDomain;
      bool outside(vec2 p){return any(lessThan(p,vec2(0.)))||any(greaterThan(p,vec2(1.)));}
      float seed(vec2 p){float lane=p.y*18.;float d=fract(lane+.5)-.5;float pulse=.65+.35*pow(sin(uTime*4.-floor(lane)*.7-p.x*22.),2.);return exp(-d*d/0.004)*pulse;}
      vec2 backtrace(vec2 p,float dt){vec2 a=texture2D(uVelocity,p).xy/uDomain;vec2 mid=p-.5*dt*a;return p-dt*texture2D(uVelocity,clamp(mid,0.,1.)).xy/uDomain;}
      void main(){if(texture2D(uVelocity,vUv).z<.5){gl_FragColor=vec4(0.);return;}if(uReset){gl_FragColor=vec4(seed(vUv),0.,0.,1.);return;}
      vec2 back=backtrace(vUv,uDt);if(outside(back)){gl_FragColor=vec4(back.x<0.?seed(vUv):0.,0.,0.,1.);return;}if(texture2D(uVelocity,back).z<.5){gl_FragColor=vec4(0.);return;}
      float d=texture2D(uDye,back).r;
      if(uPass==1){vec2 forward=backtrace(vUv,-uDt);if(!outside(forward)){d=texture2D(uPredicted,vUv).r+.5*(texture2D(uDye,vUv).r-texture2D(uPredicted,forward).r);vec2 lo=(floor(back*uSize-.5)+.5)/uSize;vec2 px=1./uSize;float a=texture2D(uDye,lo).r,b=texture2D(uDye,lo+vec2(px.x,0.)).r,c=texture2D(uDye,lo+vec2(0.,px.y)).r,e=texture2D(uDye,lo+px).r;d=clamp(d,min(min(a,b),min(c,e)),max(max(a,b),max(c,e)));}}
      if(vUv.x<3./uSize.x)d=seed(vUv);gl_FragColor=vec4(d*uDecay,0.,0.,1.);}`,
    });
    this.display = new THREE.ShaderMaterial({ vertexShader: VERT, depthTest: false, depthWrite: false, transparent: true,
      uniforms: { uDye: { value: this.dye.texture }, uColor: { value: new THREE.Color("#b5edf4") }, uOpacity: { value: .7 } },
      fragmentShader: `varying vec2 vUv;uniform sampler2D uDye;uniform vec3 uColor;uniform float uOpacity;void main(){float d=texture2D(uDye,vUv).r;gl_FragColor=vec4(uColor,pow(clamp(d,0.,1.),.8)*uOpacity);}`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.advection); this.quad.frustumCulled = false; this.scene.add(this.quad);
  }
  update(field: Float32Array, solid: Float32Array) {
    const {nx: NX, ny: NY} = this.grid, n = NX * NY;
    for (let i = 0; i < n; i++) { this.velocityData[4*i] = THREE.DataUtils.toHalfFloat(field[i]); this.velocityData[4*i+1] = THREE.DataUtils.toHalfFloat(field[n+i]); this.velocityData[4*i+2] = solid[i] ? 0 : 0x3c00; }
    this.velocity.needsUpdate = true;
  }
  reset() { this.needsReset = true; this.time = 0; }
  render(dt: number, dark: boolean, opacity: number) {
    const {nx: NX} = this.grid, DOMAIN = this.grid;
    const draw = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => { this.quad.material = material; this.renderer.setRenderTarget(target); this.renderer.render(this.scene, this.camera); };
    if (this.needsReset || dt > 0) {
      const steps = Math.max(1, Math.ceil(dt * 2 / (DOMAIN.width / (NX - 1) * .8))), u = this.advection.uniforms;
      u.uDt.value = dt / steps; u.uReset.value = this.needsReset;
      for (let i = 0; i < steps; i++) {
        this.time += dt / steps; u.uTime.value = this.time;
        // WebGL forbids sampling any texture attached to the output framebuffer,
        // even if the sampler's branch is inactive. Match the 3D smoke passes.
        u.uDecay.value = 1; u.uDye.value = this.dye.texture; u.uPredicted.value = this.dye.texture; u.uPass.value = 0; draw(this.advection, this.predicted);
        // Apply decay once per frame: tiny repeated half-float multiplications
        // otherwise round away tracer as the simulation resolution increases.
        u.uDecay.value = i === steps - 1 ? Math.exp(-dt * .02) : 1;
        u.uPredicted.value = this.predicted.texture; u.uPass.value = 1; draw(this.advection, this.next);
        [this.dye, this.next] = [this.next, this.dye]; this.needsReset = false; u.uReset.value = false;
      }
    }
    this.display.uniforms.uDye.value = this.dye.texture; this.display.uniforms.uOpacity.value = opacity;
    this.display.uniforms.uColor.value.set(dark ? "#b5edf4" : "#24799e"); draw(this.display, null); return this.renderer.domElement;
  }
  dispose() { this.dye.dispose(); this.predicted.dispose(); this.next.dispose(); this.velocity.dispose(); this.advection.dispose(); this.display.dispose(); this.quad.geometry.dispose(); this.renderer.dispose(); }
}
