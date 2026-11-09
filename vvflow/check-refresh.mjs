import { chromium, webkit } from '../web/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
const reports=[];
for(const [name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const b=await engine.launch({headless:true,...(name==='chromium'?{args:['--enable-webgl','--ignore-gpu-blocklist']}: {})});const p=await b.newPage({viewport:{width:1440,height:1040}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto((process.env.VVFLOW_URL||'http://127.0.0.1:5219')+'/?workspace=vvflow&profile=mx5-nc');await p.waitForFunction(()=>!document.querySelector('.vv-primary')?.disabled);
 assert.equal(await p.getByLabel('Vortex density').inputValue(),'6');await p.getByRole('button',{name:'Run flow',exact:true}).click();await p.waitForFunction(()=>Number(document.querySelector('.vv-time strong')?.textContent)>1.5,{},{timeout:60000});await p.getByRole('button',{name:'Pause',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.vv-status')?.textContent?.includes('Paused'));
 await p.getByLabel('View layer').selectOption('both');await p.waitForFunction(()=>document.querySelector('.vv-pressure')?.getAttribute('data-time'));
 // Allow the adaptive pressure grid to settle before measuring steady refresh.
 await p.getByRole('button',{name:'Run flow',exact:true}).click();await p.waitForTimeout(800);
 await p.evaluate(()=>{window.pressureUpdates=[];const observer=new MutationObserver(()=>window.pressureUpdates.push(performance.now()));observer.observe(document.querySelector('.vv-pressure'),{attributes:true,attributeFilter:['data-time']});window.stopPressureMeasure=()=>observer.disconnect();});
 await p.waitForTimeout(5000);const timestamps=await p.evaluate(()=>{window.stopPressureMeasure();return window.pressureUpdates;});await p.getByRole('button',{name:'Pause',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.vv-status')?.textContent?.includes('Paused'));
 const intervals=timestamps.slice(1).map((t,i)=>t-timestamps[i]);
 const fps=1000/ (intervals.reduce((a,b)=>a+b,0)/intervals.length);console.log('measured',name,fps,timestamps.length);assert.ok(fps>9,'Pressure should reach approximately 10 FPS in this bounded MX-5 case');
 assert.deepEqual(errors,[]);assert.equal(await p.getByRole('alert').count(),0);const report={browser:name,defaultDensity:6,samples:timestamps.length,fps,status:await p.locator('.vv-status').innerText(),intervals};reports.push(report);console.log(JSON.stringify(report));await b.close();
}
writeFileSync('vvflow/refresh-validation.json',JSON.stringify(reports,null,2)+'\n');
