import { expect, test } from "@playwright/test";

for (const planar of [false,true]) test(`continuous smoke transports dye at the supplied velocity and masks solids (${planar ? "native section" : "volume"})`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  const result = await page.evaluate(async (planar) => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const { FlowSmoke } = await import("/src/viz/flowSmoke.ts");
    const { createFieldGPU, disposeFieldGPU } = await import("/src/viz/field.ts");
    const renderer = new THREE.WebGLRenderer();
    const dims: [number,number,number] = [65,planar ? 1 : 5,17], n=dims[0]*dims[1]*dims[2];
    const field:any = { dims, origin:[0,0,0], spacing:[1/16,1/4,1/16],
      u:new Float32Array(n).fill(1), v:new Float32Array(n), w:new Float32Array(n),
      p:new Float32Array(n), k:new Float32Array(n), solid:new Uint8Array(n) };
    // An obstacle in the lower half; check transport in the clear upper half.
    for(let k=0;k<7;k++) for(let j=0;j<dims[1];j++) for(let i=30;i<35;i++) {
      const idx=i+65*(j+dims[1]*k); field.solid[idx]=1; field.u[idx]=0;
    }
    const gpu=createFieldGPU(field), smoke=new FlowSmoke(renderer);
    smoke.configure(1,planar ? 0 : 0.5,new THREE.Vector3(0,0,0),new THREE.Vector3(4,1,1),1,1);
    smoke.setField(gpu,null,0);
    renderer.setViewport(3,4,20,30); renderer.setScissor(1,2,10,12); renderer.setScissorTest(true);
    smoke.step(0);
    const read = () => {
      const target=(smoke as any).dye, pixels=new Uint16Array(target.width*target.height*4);
      renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
      return {w:target.width,h:target.height,pixels};
    };
    const first=read();
    // Six exact dye pixels, transported by uniform u=1 m/s.
    smoke.step(6*4/first.w);
    const moved=read();
    let translatedError=0, stationaryError=0, samples=0;
    const decode=THREE.DataUtils.fromHalfFloat;
    for(let y=Math.floor(first.h*.65);y<first.h-2;y++) for(let x=12;x<first.w-12;x++) {
      const i=4*(x+y*first.w), a=decode(moved.pixels[i]);
      translatedError+=Math.abs(a-decode(first.pixels[i-24]));
      stationaryError+=Math.abs(a-decode(first.pixels[i])); samples++;
    }
    smoke.step(0); const paused=read();
    const stopped=paused.pixels.every((v:number,i:number)=>v===moved.pixels[i]);
    const solid=moved.pixels[4*(Math.floor(first.w*.5)+first.w*Math.floor(first.h*.15))];
    const viewport=renderer.getViewport(new THREE.Vector4()).toArray();
    const scissor=renderer.getScissor(new THREE.Vector4()).toArray();
    const scissorTest=renderer.getScissorTest();
    smoke.reset(); smoke.step(0); const reset=read();
    const deterministic=reset.pixels.every((v:number,i:number)=>v===first.pixels[i]);
    smoke.dispose(); disposeFieldGPU(gpu); renderer.dispose();
    return {translatedError:translatedError/samples,stationaryError:stationaryError/samples,stopped,solid,viewport,scissor,scissorTest,deterministic};
  },planar);
  expect(result.translatedError).toBeLessThan(.01);
  expect(result.translatedError).toBeLessThan(result.stationaryError/4);
  expect(result.stationaryError).toBeGreaterThan(.03);
  expect(result.stopped).toBe(true);
  expect(result.solid).toBe(0);
  expect(result.viewport).toEqual([3,4,20,30]);
  expect(result.scissor).toEqual([1,2,10,12]);
  expect(result.scissorTest).toBe(true);
  expect(result.deterministic).toBe(true);
  expect(errors).toEqual([]);
});
