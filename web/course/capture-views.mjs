// Reproducible real-app snapshots. Keep HMR off so authoring cannot reset a running solve.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..');
const server=await createServer({root,server:{host:'127.0.0.1',port:5301,strictPort:true,hmr:false,watch:null},logLevel:'error'});
let browser;
try {
  await server.listen();browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu','--enable-gpu','--ignore-gpu-blocklist',...(process.platform==='darwin'?['--use-angle=metal']:[])]});
  const page=await browser.newPage({viewport:{width:1500,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
  await page.goto('http://127.0.0.1:5301/?courseLab=teaching-car');
  await page.getByTestId('group-Flat-floor body').waitFor();
  await page.getByText('I checked size, orientation, wheels and clearance.',{exact:true}).click();
  await page.getByRole('button',{name:'Continue to conditions',exact:true}).click();
  await page.getByRole('button',{name:'Continue to run',exact:true}).click();
  await page.getByTestId('run').click();console.log('Running real app baseline, preserving the final field...');
  await page.getByTestId('card-cd').waitFor({timeout:660000});
  const doc=await page.evaluate(()=>window.__easycfd.app.get().run.doc);
  doc.courseCapture={solverBaseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),generator:'web/course/make-models.mjs',captureScript:'web/course/capture-views.mjs',qualification:'exploratory; final field snapshot, not a temporal-mean field'};
  writeFileSync(resolve(here,'evidence/viewer-run.json'),JSON.stringify(doc,null,2)+'\n');
  for(const [id,file] of [['pressure','easycfd-surface-pressure.png'],['vertical','easycfd-vertical-flow.png']]) {
    await page.getByRole('button',{name:/Explore airflow/}).click();await page.getByTestId('analysis-'+id).click();
    // Camera animation is driven by render frames even when reduced-motion is enabled.
    await page.waitForTimeout(900);
    await page.screenshot({path:resolve(root,'../docs/aerodynamics-course',file)});
  }
  console.log('Captured final-state app views.',{cd:doc.result.cd,cl:doc.result.cl,settled:doc.result.settled,cells:doc.result.cells});
} finally {await browser?.close();await server.close();}
