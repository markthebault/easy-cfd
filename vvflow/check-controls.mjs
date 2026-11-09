import {chromium,webkit} from '../web/node_modules/@playwright/test/index.mjs';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
const base=process.env.VVFLOW_URL||'http://127.0.0.1:5219',reports=[];
for(const [name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const b=await engine.launch({headless:true}),p=await b.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.vortexFrames=[];const Original=window.Worker;window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.type==='vortices'){let minY=Infinity;for(let i=1;i<e.data.particles.length;i+=4)minY=Math.min(minY,e.data.particles[i]);window.vortexFrames.push({wall:performance.now(),steps:e.data.steps,version:e.data.version,metrics:e.data.metrics,minY,count:e.data.particles.length/4});}});}};});
 await p.goto(base+'/?workspace=2d&animation=vortex&profile=mx5-nc-prht');await p.waitForFunction(()=>window.vortexFrames?.length>0,{},{timeout:30000});
 assert.equal(await p.locator('.flow-metrics').count(),1);assert.notEqual(await p.getByTestId('drag-coefficient').innerText(),'—');assert.notEqual(await p.getByTestId('lift-coefficient').innerText(),'—');assert.ok((await p.locator('.flow-metrics').innerText()).includes('Instantaneous forces during warmup'));
 const rates=[];
 for(const setting of[.1,1,3]){
   const old=await p.evaluate(()=>window.vortexFrames.at(-1).version);await p.getByRole('button',{name:'Reset flow',exact:true}).click();await p.waitForFunction(old=>window.vortexFrames.at(-1)?.version>old,old,{timeout:30000});
   const slider=p.getByLabel('Animation speed');await slider.press('Home');if(setting===3)await slider.press('End');if(setting===1)for(let i=0;i<9;i++)await slider.press('ArrowRight');
   assert.ok(Math.abs(Number(await slider.inputValue())-setting)<1e-9);
   const first=await p.evaluate(()=>window.vortexFrames.at(-1).steps);const start=performance.now();await p.getByRole('button',{name:'Resume simulation'}).click();await p.waitForTimeout(2300);await p.getByRole('button',{name:'Pause simulation'}).click();await p.waitForTimeout(200);
   const last=await p.evaluate(()=>window.vortexFrames.at(-1));assert.ok(last.minY>=0,`Particles crossed ground at ${last.minY}`);assert.equal(last.metrics.backend,'vvflow');assert.ok(last.metrics.key.includes('slip-ground'));assert.ok(Number.isFinite(last.metrics.instantaneousCd)&&Number.isFinite(last.metrics.instantaneousCl));
   rates.push({setting,steps:last.steps-first,elapsedMs:performance.now()-start});
 }
 assert.ok(rates[1].steps>rates[0].steps*4);assert.ok(rates[2].steps>rates[1].steps*1.5,JSON.stringify(rates));
 const paused=await p.evaluate(()=>window.vortexFrames.at(-1).metrics.steps);await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>window.vortexFrames.at(-1).metrics.steps),paused);
 await p.screenshot({path:`vvflow/build/${name}-ground-metrics.png`});await p.getByLabel('Flow animation').selectOption('trails');await p.waitForFunction(()=>document.querySelector('.flow-status')?.textContent?.includes('steps')&&!document.querySelector('.flow-status')?.textContent?.includes('vvflow'),{},{timeout:30000});assert.equal(await p.locator('.flow-metrics').count(),1);
 assert.deepEqual(errors,[]);assert.equal(await p.getByRole('alert').count(),0);reports.push({browser:name,rates,metricsVisible:true,metricsFromVvflow:true,instantaneousLabel:true,ground:true,pause:true,switchBackend:true,pageErrors:errors});await b.close();console.log(name,JSON.stringify(rates));
}
writeFileSync('vvflow/controls-validation.json',JSON.stringify(reports,null,2)+'\n');
