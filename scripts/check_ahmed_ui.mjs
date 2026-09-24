import { chromium } from '../frontend/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const name = process.argv[2] || 'native';
const root = '.easycfd/reference/nathanrooy-comparison';
const saved = JSON.parse(readFileSync(`${root}/${name}.json`, 'utf8'));
const out = 'docs/ahmed-validation';
mkdirSync(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1440,height:1100}});
page.setDefaultTimeout(60000);
const errors=[];
page.on('pageerror', e=>errors.push(e.message));
page.on('response', r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
try {
 await page.goto('http://127.0.0.1:8000');
 await page.getByRole('button',{name:'Simulation results',exact:true}).click();
 await page.getByRole('button',{name:'All',exact:true}).click();
 await page.locator(`[data-run="${saved.id}"]`).click();
 await page.locator('.run-status.completed').waitFor();
 const run=await (await page.request.get(`http://127.0.0.1:8000/api/runs/${saved.id}`)).json();
 const result=run.result;
 assert.ok((await page.locator("body").innerText()).includes(`Fields show iteration ${result.iteration}; forces average the last ${result.averaging_iterations} iterations.`));
 const fmt=(n,d=2)=>n.toFixed(d);
 const metrics=page.locator('.metric-grid').first();
 for(const [title,value,digits] of [['Drag',result.drag,2],['Drag coefficient',result.cd,4],['Lift coefficient',result.cl,4]]) {
   const card=metrics.locator('article').filter({has:page.getByText(title,{exact:true})});
   assert.ok((await card.innerText()).includes(fmt(value,digits)),`${title}: ${await card.innerText()}`);
 }
 const vertical=metrics.getByLabel('Vertical aerodynamic load');
 assert.ok((await vertical.innerText()).includes(result.downforce<0?'Lift':'Downforce'));
 assert.ok((await vertical.innerText()).includes(fmt(Math.abs(result.downforce)/9.80665,1)));
 assert.ok((await vertical.innerText()).includes(fmt(Math.abs(result.downforce))));
 for(const warning of result.warnings)assert.ok((await page.locator('body').innerText()).includes(warning));
 for(const [mode,field,suffix] of [['surface','Pressure','pressure'],['slice','Speed','speed-slice'],['streamlines','Speed','streamlines'],['plane','Pressure','pressure-plane']]){
   await page.getByLabel('View',{exact:true}).selectOption(mode);
   await page.getByLabel('Field',{exact:true}).selectOption(field);
   await page.getByText('Loading geometry…',{exact:true}).waitFor({state:'hidden'});
   await page.waitForTimeout(1000);
   assert.equal(await page.locator('.viewport-message.error').count(),0);
   const legend=await page.locator('.legend').innerText();
   assert.ok(legend.includes(result.ranges[field][0].toPrecision(3)));
   assert.ok(legend.includes(result.ranges[field][1].toPrecision(3)));
   await page.screenshot({path:`${out}/${name}-${suffix}.png`,fullPage:true});
 }
 await page.getByLabel('View',{exact:true}).selectOption('surface');
 await page.getByLabel('Field',{exact:true}).selectOption('Pressure');
 await page.locator('#run-details').scrollIntoViewIfNeeded();
 await page.locator('.history .trace').waitFor();
 if(name === 'precise') {
   const ys=(await page.locator('.history .trace').getAttribute('points')).split(' ').map(p=>Number(p.split(',')[1]));
   assert.ok(Math.max(...ys)-Math.min(...ys)<0.01,'Converged numerical noise should appear flat');
   const labels=await page.locator('.history text').allTextContents();
   assert.notEqual(labels[0],labels[1],'History axis labels must distinguish the displayed range');
 }

 await page.screenshot({path:`${out}/${name}-diagnostics.png`,fullPage:true});
 assert.deepEqual(errors,[]);
 writeFileSync(`${out}/${name}-ui.json`,JSON.stringify({run_id:run.id,checks:['rounded Cd, Cl and drag','vertical force sign and kg conversion','warnings','pressure, speed slice, streamlines, animated pressure plane','legend ranges'],errors},null,2));
 console.log(name,'UI checks passed',run.id);
} finally {await browser.close();}
