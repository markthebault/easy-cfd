import { expect, test } from '@playwright/test';

test('main smoke supports an operating map without changing ordinary playback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Dev-server ESM imports.
    const T = await import('/node_modules/.vite/deps/three.js');
    // @ts-expect-error Dev-server ESM imports.
    const { createFieldGPU, disposeFieldGPU } = await import('/src/viz/field.ts');
    // @ts-expect-error Dev-server ESM imports.
    const { Particles } = await import('/src/viz/particles.ts');
    const renderer = new T.WebGLRenderer(); renderer.setSize(64,64);
    const n=9*9*9;
    const fields=[1,2,3,4].map(speed=>createFieldGPU({origin:[-1,-1,0],spacing:[.5,.25,.25],dims:[9,9,9],u:new Float32Array(n).fill(speed),v:new Float32Array(n),w:new Float32Array(n),p:new Float32Array(n),k:new Float32Array(n),solid:new Uint8Array(n)}));
    const particles=new Particles(renderer,{size:4,mode:0});
    particles.setField(fields[0],1);particles.setRake(new T.Vector3(0,0,1),.1,.1,0);particles.mesh.visible=true;particles.timeScale=1;particles.setLife(100);
    const camera=new T.PerspectiveCamera();
    particles.reseed();
    // Place every particle in the fluid with a positive age, avoiding randomized emission latency.
    const init=particles.gpu.createTexture();
    for(let i=0;i<init.image.data.length;i+=4){init.image.data[i]=0;init.image.data[i+1]=0;init.image.data[i+2]=1;init.image.data[i+3]=1;}
    for(const rt of particles.variable.renderTargets)particles.gpu.renderTexture(init,rt);
    const read=()=>{const rt=particles.gpu.getCurrentRenderTarget(particles.variable),p=new Float32Array(4*4*4);renderer.readRenderTargetPixels(rt,0,0,4,4,p);return Array.from(p.slice(0,4));};
    particles.step(.05,camera);const ordinary=read();
    particles.setOperatingFields(fields,[.25,.25,.25,.25],2.5);
    particles.step(.05,camera);const blended=read();
    particles.playing=false;particles.step(.05,camera);const frozen=read();
    const uniforms=particles.uniforms.uOperatingWeights.value.toArray();
    particles.setField(fields[0],1);particles.playing=true;particles.step(.05,camera);const restored=read();
    init.dispose();particles.dispose();fields.forEach(disposeFieldGPU);renderer.dispose();
    return {ordinary,blended,frozen,uniforms,restored};
  });
  expect(result.ordinary[0]).toBeCloseTo(.05,5);
  expect(result.blended[0]-result.ordinary[0]).toBeCloseTo(.125,5);
  expect(result.frozen).toEqual(result.blended);
  expect(result.restored[0]-result.blended[0]).toBeCloseTo(.05,5);
  expect(result.uniforms).toEqual([.25,.25,.25,.25]);
  expect(errors).toEqual([]);
});
