const vertex = `#version 300 es
in vec4 particle;
uniform vec4 view;
uniform float strength;
uniform float size;
out float signG;
out float alpha;
void main(){
 vec2 p=(particle.xy-view.xy)/view.zw;
 gl_Position=vec4(p*2.-1.,0.,1.);
 float g=abs(particle.z)/max(strength,1e-12);
 gl_PointSize=clamp((2.3+6.*sqrt(g))*size,1.,20.);
 signG=sign(particle.z);
 alpha=clamp(.4+sqrt(g)*.45,.0,.85);
 if(abs(particle.z)<1e-12)alpha=0.;
}`;
const fragment = `#version 300 es
precision highp float;
in float signG;
in float alpha;
out vec4 color;
void main(){
 float r=length(gl_PointCoord-.5)*2.;
 float a=exp(-2.5*r*r)*smoothstep(1.,.65,r)*alpha;
 vec3 c=signG>0.?vec3(.98,.28,.24):vec3(.2,.57,1.);
 color=vec4(c,a);
}`;
export class Particles {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('This particle preview needs WebGL 2. Try a browser with graphics acceleration enabled.');
    this.gl = gl;
    const compile = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'Shader compilation failed'); return s; };
    const p = gl.createProgram()!, v = compile(gl.VERTEX_SHADER, vertex), f = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p); gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'Particle program failed');
    this.program = p; this.buffer = gl.createBuffer()!;
    gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const attribute = gl.getAttribLocation(p, 'particle'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, 16, 0);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  draw(data: Float32Array, view: number[], size: number) {
    const gl = this.gl, dpr = Math.min(devicePixelRatio, 2), bounds = this.canvas.getBoundingClientRect();
    const width = Math.round(bounds.width * dpr), height = Math.round(bounds.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    let strength = 0; for (let i = 2; i < data.length; i += 4) strength = Math.max(strength, Math.abs(data[i]));
    gl.uniform4fv(gl.getUniformLocation(this.program, 'view'), view);
    gl.uniform1f(gl.getUniformLocation(this.program, 'strength'), strength);
    gl.uniform1f(gl.getUniformLocation(this.program, 'size'), size * dpr);
    gl.drawArrays(gl.POINTS, 0, data.length / 4);
  }
  dispose() { this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); }
}
