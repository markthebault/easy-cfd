// Share the exact existing EasyCFD Bézier preset with the native/WASM port.
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const server=await createServer({root:resolve(root,'web'),configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
 const { MX5_NC_PRHT }=await server.ssrLoadModule('/src/flow2d/presets/mx5NcPrht.ts');
 const points=MX5_NC_PRHT.points;
 const minX=points.reduce((v,p)=>Math.min(v,p.x),Infinity),maxX=points.reduce((v,p)=>Math.max(v,p.x),-Infinity),length=maxX-minX;
 const normalised=points.map(p=>[(p.x-minX)/length,p.y/length]);
 const header='// Generated from web/src/flow2d/presets/mx5NcPrht.ts; Lref=4 m, U=1.\nstatic const std::vector<TVec> mx5_outline = {\n'+normalised.map(p=>`  {${p[0].toPrecision(17)},${p[1].toPrecision(17)}}`).join(',\n')+'\n};\n';
 writeFileSync(resolve(root,'vvflow/mx5-outline.inc'),header);
 console.log(`MX-5 NC: ${points.length} curve samples, ${length} m long`);
} finally {await server.close();}
