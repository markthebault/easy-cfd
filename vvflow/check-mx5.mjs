import { chromium, webkit } from '../web/node_modules/@playwright/test/index.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.VVFLOW_URL||'http://127.0.0.1:5218';
const results=[];
for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
 const b=await engine.launch({headless:true,...(name==='chromium'?{args:['--enable-webgl','--ignore-gpu-blocklist']}: {})});
 const context=await b.newContext({viewport:{width:1440,height:960}}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/?workspace=vvflow');await p.getByRole('button',{name:'MX-5 NC',exact:true}).click();
 await p.waitForFunction(()=>!document.querySelector('.vv-primary')?.disabled);
 assert.equal(await p.getByLabel('Angle of attack').count(),0);
 assert.equal(await p.getByRole('alert').count(),0);
 const bounds=await p.locator('.vv-geometry polygon').evaluateAll(polygons=>{
   const p=polygons[0].getAttribute('points').trim().split(/\s+/).map(s=>s.split(',').map(Number));
   return {bodies:polygons.length,points:p.length,width:Math.max(...p.map(v=>v[0]))-Math.min(...p.map(v=>v[0])),height:Math.max(...p.map(v=>v[1]))-Math.min(...p.map(v=>v[1]))};
 });
 assert.equal(bounds.bodies,1);assert.equal(bounds.points,240);assert.ok(bounds.width>.99&&bounds.width<1.01);assert.ok(bounds.height>.27&&bounds.height<.3);
 await context.setOffline(true);await p.getByRole('button',{name:'Run flow',exact:true}).click();
 await p.waitForFunction(()=>Number(document.querySelector('.vv-time strong')?.textContent)>4,{},{timeout:30000});
 await p.getByRole('button',{name:'Pause',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.vv-status')?.textContent?.includes('Paused'));
 await p.screenshot({path:`vvflow/build/${name}-mx5.png`});
 assert.equal(await p.getByRole('alert').count(),0);assert.deepEqual(errors,[]);
 const status=await p.locator('.vv-status').innerText();
 await context.setOffline(false);await p.goto(base+'/?workspace=vvflow&profile=mx5-nc');await p.waitForFunction(()=>!document.querySelector('.vv-primary')?.disabled);
 assert.equal(await p.getByRole('button',{name:'MX-5 NC',exact:true}).getAttribute('class'),'selected');
 await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.screenshot({path:`vvflow/build/${name}-mx5-mobile.png`});
 results.push({browser:name,button:true,directLink:true,bounds,offlineRun:true,status,pageErrors:errors});await b.close();console.log(name,'MX-5 passed');
}
writeFileSync('vvflow/mx5-validation.json',JSON.stringify(results,null,2)+'\n');
