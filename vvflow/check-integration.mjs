import {chromium,webkit} from '../web/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
const results=[],base=process.env.VVFLOW_URL||'http://127.0.0.1:5219';
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const b=await engine.launch({headless:true,...(name==='chromium'?{args:['--enable-webgl','--ignore-gpu-blocklist']}: {})});const context=await b.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'}),p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/?workspace=2d&animation=vortex&profile=mx5-nc-prht');await p.waitForFunction(()=>Number(document.querySelector('.flow-canvas')?.getAttribute('data-vortex-count'))>0,{},{timeout:30000});
 assert.equal(await p.getByLabel('Flow animation').inputValue(),'vortex');assert.equal(await p.getByRole('group',{name:'Flow display',exact:true}).count(),0);assert.equal(await p.getByLabel('View layer').count(),0);
 const stored=await p.evaluate(()=>localStorage.getItem('easycfd.flow2d.v2'));assert.ok(stored.includes('MX-5'));
 await p.getByLabel('Animation speed').press('End');await p.getByRole('button',{name:'Resume simulation'}).click();await p.waitForFunction(()=>Number((document.querySelector('.flow-status small')?.textContent||'').split(' steps')[0].replace(/[^0-9]/g,''))>250,{},{timeout:60000});await p.getByRole('button',{name:'Pause simulation'}).click();
 await p.screenshot({path:`vvflow/build/${name}-integrated.png`});assert.equal(await p.getByRole('alert').count(),0);
 // Editor changes restart the actual vvflow scene. Disabled geometry disappears.
 await p.getByLabel('Add shape').selectOption('rectangle');await p.waitForTimeout(400);assert.equal(await p.getByRole('listitem').count(),2);assert.equal(await p.getByRole('alert').count(),0);
 await p.getByRole('button',{name:'Duplicate',exact:true}).click();await p.waitForTimeout(400);assert.equal(await p.getByRole('listitem').count(),3);assert.equal(await p.getByRole('alert').count(),0);
 const checkbox=p.locator('.flow-shape-toggle input').last();await checkbox.uncheck();await p.waitForTimeout(300);
 await p.getByLabel('Flow animation').selectOption('trails');await p.waitForFunction(()=>document.querySelector('.flow-status')?.textContent?.includes('steps')&&!document.querySelector('.flow-status')?.textContent?.includes('vvflow'),{},{timeout:30000});assert.equal(await p.getByRole('group',{name:'Flow display',exact:true}).count(),1);
 await p.getByLabel('Flow animation').selectOption('vortex');await p.waitForFunction(()=>document.querySelector('.flow-status')?.textContent?.includes('vvflow'),{},{timeout:30000});assert.equal(await p.getByRole('alert').count(),0);
 await p.locator('input[type=file]').setInputFiles({name:'test-wing.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><polygon points="0,15 100,0 100,30"/></svg>')});
 await p.getByRole('button',{name:'Import profile',exact:false}).click();await p.waitForTimeout(600);assert.equal(await p.getByRole('listitem').count(),4);assert.equal(await p.getByRole('alert').count(),0);
 await p.setViewportSize({width:390,height:844});await p.waitForTimeout(300);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:`vvflow/build/${name}-integrated-mobile.png`});
 assert.deepEqual(errors,[]);results.push({browser:name,sceneImported:true,particlesEvolve:true,editing:true,duplicateUnion:true,enableToggle:true,svgImport:true,backendSwitch:true,mobile:true,pageErrors:errors});await b.close();console.log(name,'integrated particles passed');
}
writeFileSync('vvflow/integration-validation.json',JSON.stringify(results,null,2)+'\n');
