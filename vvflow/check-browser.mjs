import { chromium, webkit } from '../web/node_modules/@playwright/test/index.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.VVFLOW_URL||'http://127.0.0.1:5218';
const report=[];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--enable-webgl','--ignore-gpu-blocklist']}: {})});
 const context=await browser.newContext({viewport:{width:1440,height:960},acceptDownloads:true});
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.goto(base+'/?workspace=vvflow');
 const run=page.getByRole('button',{name:'Run flow',exact:true});await run.waitFor();await page.waitForFunction(()=>!document.querySelector('.vv-primary')?.disabled);
 // Assets have loaded. Block the network and exercise the actual browser solver.
 await context.setOffline(true);await run.click();await page.waitForFunction(()=>Number(document.querySelector('.vv-time strong')?.textContent)>3,{},{timeout:30000});
 await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.vv-status')?.textContent?.includes('Paused'));
 const time=await page.locator('.vv-time strong').innerText();await page.waitForTimeout(200);assert.equal(await page.locator('.vv-time strong').innerText(),time);
 await page.getByRole('button',{name:'Step',exact:true}).click();await page.waitForFunction(t=>Number(document.querySelector('.vv-time strong')?.textContent)>Number(t),time);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV'}).click();assert.ok((await download).suggestedFilename().endsWith('.csv'));
 await page.screenshot({path:`vvflow/build/${name}-desktop.png`});
 await context.setOffline(false);await page.getByRole('button',{name:'Deploying spoiler',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.vv-primary')?.disabled);await page.getByRole('button',{name:'Run flow',exact:true}).click();
 await page.waitForFunction(()=>Number(document.querySelector('.vv-time strong')?.textContent)>7.1,{},{timeout:90000});await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.vv-status')?.textContent?.includes('Paused'));
 const angle=await page.locator('.vv-results').innerText();assert.match(angle,/60\.0°/);
 await page.screenshot({path:`vvflow/build/${name}-spoiler.png`});
 await page.getByRole('button',{name:'Reset',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.vv-time strong')?.textContent==='0.00');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`vvflow/build/${name}-mobile.png`});
 assert.deepEqual(errors,[]);assert.equal(await page.getByRole('alert').count(),0);
 assert.equal(requests.filter(url=>/\/api\/|wss?:/.test(url)).length,0);
 report.push({browser:name,offlineSimulation:true,pauseAndStep:true,csvDownload:true,movingSpoiler:true,mobile:true,pageErrors:errors,requests:[...new Set(requests)]});
 await browser.close();console.log(name,'passed');
}
writeFileSync('vvflow/browser-validation.json',JSON.stringify(report,null,2)+'\n');
