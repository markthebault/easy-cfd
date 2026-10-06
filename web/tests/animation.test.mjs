import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let server, animation, codec;
before(async () => {
  server = await createServer({root:resolve(dirname(fileURLToPath(import.meta.url)),".."),server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  animation = await server.ssrLoadModule("/src/solver/animation.ts");
  codec = await server.ssrLoadModule("/src/store/codec.ts");
});
after(async () => server?.close());

test("playback brackets physical timestamps and never blends the loop seam", () => {
  const mid = animation.frameAt([0,.01,.04,.1],.025);
  assert.equal(mid.index, 1);
  assert.ok(Math.abs(mid.mix - .5) < 1e-12);
  assert.deepEqual(animation.frameAt([0,.01,.04,.1],1),{index:2,mix:1});
  assert.deepEqual(animation.frameAt([0,.01,.04,.1],-1),{index:0,mix:0});
});

test("physical frames survive compact storage including missing fluid samples", () => {
  const field = {origin:[0,0,0],spacing:[1,1,1],dims:[2,2,2],freestream:10,inlet:[10,0,0],length:4,solid:new Uint8Array(8),u:new Float32Array(8).fill(10),v:new Float32Array(8),w:new Float32Array(8),p:new Float32Array(8),k:new Float32Array(8)};
  field.p[3]=NaN;field.solid[3]=1;
  const original={version:1,engine:"webgpu",timeUnit:"s",model:"URANS · k–ω SST",frames:[{time:0,field},{time:.17,field:{...field,u:new Float32Array(8).fill(12)}}]};
  const decoded=codec.decodeAnimation(codec.encodeAnimation(original));
  assert.equal(decoded.frames[1].time,.17);
  assert.equal(decoded.frames[1].field.u[0],12);
  assert.ok(Number.isNaN(decoded.frames[0].field.p[3]));
  assert.equal(original.frames[0].field.u[0],10);
});

test("capture advances the solver rather than manufacturing repeated frames and obeys cancellation", async () => {
  let t=99,transient=false;
  const solver={c:{length:4,freestream:20},beginTransient(){t=0;transient=true;},run(n){t+=n*.001;},async readState(){return [.001,t];}};
  const sample=async()=>({solid:new Uint8Array(1),u:new Float32Array([t]),v:new Float32Array(1),w:new Float32Array(1),p:new Float32Array(1),k:new Float32Array(1)});
  const a=await animation.recordFlowAnimation(solver,sample);
  assert.ok(transient);
  assert.equal(a.frames.length,48);
  assert.equal(a.frames[0].time,0);
  assert.ok(a.frames.at(-1).time>=2.4);
  assert.ok(a.frames.every((f,i)=>i===0 || f.time>a.frames[i-1].time));
  const c=new AbortController();c.abort();
  await assert.rejects(animation.recordFlowAnimation(solver,sample,{signal:c.signal}),{name:"AbortError"});
});
