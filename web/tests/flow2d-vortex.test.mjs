import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'vite';
let server,encode;
before(async()=>{server=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});({vortexOutlines:encode}=await server.ssrLoadModule('/src/flow2d/vortexGeometry.ts'));});
after(()=>server?.close());
const rectangle=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
function rings(data){let at=0,r=[];while(at<data.length){let n=data[at++],p=[];for(let i=0;i<n;i++)p.push([data[at++],data[at++]]);r.push(p);}return r;}
const area=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0];},0)/2);
test('overlapping editor bodies become one exposed boundary in reference units',()=>{const r=rings(encode([rectangle(0,0,2,1),rectangle(1,0,2,1)],2));assert.equal(r.length,1);assert.equal(area(r[0]),.75);});
test('duplicate shapes do not add a second boundary; separate shapes remain separate',()=>{const a=rectangle(0,0,1,1);assert.equal(rings(encode([a,a],1)).length,1);assert.equal(rings(encode([a,rectangle(2,0,1,1)],1)).length,2);assert.deepEqual(encode([],1),[]);});
test('closed fluid cavities are explicitly rejected instead of silently filled',()=>{assert.throws(()=>encode([rectangle(0,0,3,.5),rectangle(0,2.5,3,.5),rectangle(0,.5,.5,2),rectangle(2.5,.5,.5,2)],1),/enclosed holes/);});
