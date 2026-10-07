// Print the delivered HTML so the review PDF and the in-app course cannot diverge.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import './build.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..'),out=resolve(root,'../output/pdf');
mkdirSync(out,{recursive:true});
const server=await createServer({root,server:{host:'127.0.0.1',port:5298,strictPort:true,hmr:false},logLevel:'error'});
let browser;
try {
  await server.listen();browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5298/course/index.html',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.course?.ready);
  // Embedded field screenshots must also be decoded before printing, including offscreen ones.
  await page.evaluate(async()=>{for(const image of document.images){image.loading='eager';await image.decode();}});
  if(errors.length)throw new Error(errors.join('\n'));
  await page.evaluate(()=>{
    window.course.preparePrint();
    // Review PDFs must not retain links to the ephemeral export server.
    for(const link of document.querySelectorAll('[data-app-doc]'))link.href=`https://github.com/markthebault/easy-cfd/blob/${window.CourseData.evidence.commit}/web/VALIDATION.md`;
  });await page.emulateMedia({media:'print'});
  const path=resolve(out,'easycfd-car-aerodynamics.pdf');
  await page.pdf({path,format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<div style="width:100%;font-size:8px;color:#647671;padding:0 60px;font-family:Arial;">EasyCFD · Car aerodynamics · Edition 1</div>',footerTemplate:'<div style="width:100%;font-size:8px;color:#647671;padding:0 60px;font-family:Arial;display:flex;justify-content:space-between;"><span>Original course · exploratory CFD examples</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',tagged:true,outline:true});
  copyFileSync(path,resolve(root,'public/course/easycfd-car-aerodynamics.pdf'));
  writeFileSync(resolve(root,'../docs/aerodynamics-course/pdf-build.json'),JSON.stringify({source:'web/course/content.html',html:'web/public/course/index.html',pdf:'output/pdf/easycfd-car-aerodynamics.pdf',lessonCount:24,staticDiagrams:await page.locator('figure[data-diagram]').count(),actualFieldViews:await page.locator('figure[data-image]').count(),interactiveWorkbenches:await page.locator('[data-widget]').count(),paper:'10.3390/app12083763',format:'A4, print CSS, expanded answers, default widget values',generator:'web/course/export-pdf.mjs'},null,2)+'\n');
  console.log(`Saved ${path}`);
} finally {await browser?.close();await server.close();}
