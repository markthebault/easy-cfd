import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
page.setDefaultTimeout(180000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=process.env.MX5_BASE_URL || 'http://127.0.0.1:8000';
const dataRoot=process.env.MX5_DATA_ROOT || '.easycfd/imports/mx5-nc';
const screenshotPrefix=process.env.MX5_SCREENSHOT_PREFIX || 'docs/mx5-nc';
const reuse=process.env.MX5_REUSE;
const response=reuse ? await page.request.get(base+'/api/projects/'+readFileSync(dataRoot+'/project-id','utf8')) : await page.request.post(base+'/api/projects',{data:{name:process.env.MX5_NAME || 'MX-5 NC · reconstructed exterior',sample:false}});
if(!response.ok())throw new Error(await response.text());
const project=await response.json();writeFileSync(dataRoot+'/project-id',project.id);
await page.goto(base);
await page.getByRole('heading',{name:project.name,exact:true}).waitFor();
if(!reuse){
await page.getByRole('button',{name:'Import STEP / STL',exact:true}).click();
await page.getByLabel('Geometry files').setInputFiles(['body.stl','wheel--1--1.stl','wheel--1-1.stl','wheel-1--1.stl','wheel-1-1.stl'].map(f=>resolve(dataRoot,f)));
await page.getByLabel('Nose points toward').selectOption('-Y');
await page.getByLabel('STL units').selectOption('m');
await page.getByRole('button',{name:'Import & check model'}).click();
await page.getByRole('heading',{name:'Import your design'}).waitFor({state:'hidden'});
const loaded=await (await page.request.get(base+'/api/projects/'+project.id)).json();
console.log('IMPORT',JSON.stringify({dimensions:loaded.geometry.dimensions,errors:loaded.geometry.errors,parts:loaded.geometry.parts.length}));
if(loaded.geometry.errors.length)throw new Error(loaded.geometry.errors.join('\n'));
for(const part of loaded.geometry.parts.filter(p=>p.name.includes('wheel'))){
 const done=page.waitForResponse(r=>r.url().includes('/parts/')&&r.request().method()==='PUT');
 await page.getByLabel(part.name+' role',{exact:true}).selectOption('wheel');await done;
}
}
await page.getByLabel('Reference area',{exact:true}).fill('2');
await page.getByRole('button',{name:process.env.MX5_QUALITY==='medium'?'medium Compare':'fast Explore',exact:true}).click();
await page.getByLabel('I checked size').check();
await page.getByText('Loading geometry…',{exact:true}).waitFor({state:'hidden'});
await page.screenshot({path:screenshotPrefix+'-geometry.png',fullPage:true});
const jobEvent=page.waitForResponse(r=>r.url().endsWith('/runs')&&r.request().method()==='POST');
await page.getByRole('button',{name:/^(Run|Queue) simulation$/}).click();
const job=await (await jobEvent).json();writeFileSync(dataRoot+'/run-id',job.id);console.log('RUN',job.id);
await page.waitForFunction(()=>!!document.querySelector('.run-status.completed, .run-status.failed'),{},{timeout:1200000});
const result=await (await page.request.get(base+'/api/runs/'+job.id)).json();console.log('STATUS',result.status,result.error||'');
if(result.status!=='completed')throw new Error(result.error);
await page.getByText('Loading geometry…',{exact:true}).waitFor({state:'hidden'});
await page.screenshot({path:screenshotPrefix+'-pressure.png',fullPage:true});
await page.getByLabel('View',{exact:true}).selectOption('slice');await page.getByLabel('Field',{exact:true}).selectOption('Speed');
await page.getByText('Loading geometry…',{exact:true}).waitFor({state:'hidden'});
await page.screenshot({path:screenshotPrefix+'-flow.png',fullPage:true});
console.log('BROWSER ERRORS',errors);await browser.close();if(errors.length)process.exit(1);
