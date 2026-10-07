import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('Course opens from the app, teaches from scratch, and all workbenches respond', async ({ page, context }) => {
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  const popup=context.waitForEvent('page');
  await page.getByRole('link',{name:'Car aerodynamics course',exact:true}).click();
  const course=await popup;
  await expect(course.getByRole('heading',{level:1})).toContainText('Car aerodynamics');
  await expect(course.locator('.lesson')).toHaveCount(24);
  await expect(course.locator('figure[data-diagram]')).toHaveCount(29);
  await expect(course.locator('figure[data-image] img')).toHaveCount(2);
  expect(await course.locator('figure[data-image] img').evaluateAll(async images=>{for(const image of images){const img=image as HTMLImageElement;img.loading='eager';await img.decode();}return images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth===1500);})).toBe(true);
  await expect(course.locator('[data-widget]')).toHaveCount(8);
  const force=course.locator('[data-widget="forces"]');
  await expect(force).toContainText('332.7 N');await force.getByLabel('Road speed (still air)',{exact:true}).fill('200');await expect(force).toContainText('1,330.9 N');
  await course.locator('[data-widget="wing"]').getByLabel('Downforce incidence',{exact:true}).fill('18');
  await expect(course.locator('[data-widget="wing"]')).toContainText('cannot detect stall');
  await course.locator('[data-widget="diffuser"]').getByLabel('Ramp angle',{exact:true}).fill('0');
  await expect(course.locator('[data-widget="diffuser"]')).toContainText('0.0 Pa');
  await course.locator('[data-widget="balance"]').getByLabel('Splitter downward load',{exact:true}).fill('0');
  await expect(course.locator('[data-widget="balance"]')).toContainText('Front axle is aerodynamically unloaded');
  await course.locator('[data-widget="gci"]').getByLabel('Medium-grid metric',{exact:true}).fill('0.3');
  await expect(course.locator('[data-widget="gci"]')).toContainText('Do not force GCI');
  await course.locator('[data-widget="yaw"]').getByLabel('Lateral crosswind',{exact:true}).fill('-5');await expect(course.locator('[data-widget="yaw"]')).toContainText('-10.20°');
  await course.locator('[data-widget="pareto"]').getByLabel('Added power ceiling at 200 km/h',{exact:true}).fill('0');await expect(course.locator('[data-widget="pareto"]')).toContainText('Outside constraints');
  await course.getByLabel('Captured run',{exact:true}).selectOption('package');await expect(course.locator('.evidence-result')).toContainText('Temporal settling test did not pass');
  const broken=await course.evaluate(()=>[...document.querySelectorAll('a[href^="#"]')].map(a=>a.getAttribute('href')!.slice(1)).filter(id=>!document.getElementById(id)));
  expect(broken).toEqual([]);expect(errors).toEqual([]);
});

test('Search, reading progress, and notes survive reload; download excludes personal state',async({page})=>{
  await page.goto('/course/index.html');await expect(page.locator('[data-widget="forces"] .metrics')).toBeVisible();
  await page.getByLabel('Find a concept').fill('radiator');await expect(page.getByRole('status').first()).toContainText('matching lessons');
  await expect(page.locator('[data-lesson-link="lesson-12"]')).toBeVisible();await page.getByLabel('Find a concept').fill('');
  await page.locator('#lesson-01 .complete-lesson input').check();await expect(page.locator('#progress-label')).toHaveText('1 of 24 lessons completed');
  await page.getByLabel('Course notebook').fill('Private test note; export should not include this.');await page.reload();
  await expect(page.locator('#progress-label')).toHaveText('1 of 24 lessons completed');await expect(page.getByLabel('Course notebook')).toHaveValue('Private test note; export should not include this.');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save offline HTML'}).click();const file=await download;
  const path=await file.path();const html=readFileSync(path!,'utf8');expect(html).not.toContain('Private test note; export should not include this.');expect(html).toContain('window.CourseData=');
});

test('Offline standalone HTML needs no network or storage permission',async({page})=>{
  const errors:string[]=[],requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http'))requests.push(r.url());});
  await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage disabled for this test');}});});
  await page.context().setOffline(true);
  await page.goto('file://'+resolve('public/course/index.html'));
  await expect(page.locator('[data-widget="forces"]')).toContainText('332.7 N');await page.getByLabel('Course notebook').fill('Export me');await expect(page.locator('#notes-status')).toContainText('storage is unavailable');
  const dl=page.waitForEvent('download');await page.getByRole('button',{name:'Download the STL teaching pack'}).click();const zip=await dl;expect(readFileSync((await zip.path())!).subarray(0,4).toString('hex')).toBe('504b0304');
  expect(requests).toEqual([]);expect(errors).toEqual([]);
});

test('Phone layout has no page overflow and contents menu is accessible',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:390,height:844});await page.goto('/course/index.html');
  await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await page.getByRole('button',{name:'Course contents',exact:true}).click();await expect(page.locator('#course-sidebar')).toHaveClass(/open/);
  await page.locator('[data-lesson-link="lesson-11"]').click();await expect(page.locator('#course-sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('#course-sidebar')).not.toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'../docs/aerodynamics-course/course-mobile.png'});
});

test('Lab launcher retains existing designs, creates a baseline, and consumes the query once',async({page})=>{
  await page.goto('/');await page.getByTestId('try-sample').click();await expect(page.getByLabel('Design name')).toBeVisible();await page.getByLabel('Design name').fill('Preserved personal design');await page.getByLabel('Design name').blur();
  await page.waitForFunction(()=>((window as unknown as {__easycfd:{app:{get():{designs:{name:string}[]}}}}).__easycfd.app.get().designs.some(d=>d.name==='Preserved personal design')));
  await page.goto('/?courseLab=teaching-car');await expect(page.getByLabel('Design name')).toHaveValue('Aerodynamics course · teaching car');
  await expect(page.getByTestId('group-Flat-floor body')).not.toHaveClass(/off/);
  for(const name of ['Diffuser body 7 deg','Diffuser body 14 deg','Rear wing 6 deg','Rear wing 12 deg','Front splitter','Canard pair','Side skirts'])await expect(page.getByTestId('group-'+name)).toHaveClass(/off/);
  await expect(page.getByTestId('group-Wheels')).toContainText('4 parts');expect(page.url()).not.toContain('courseLab=');
  await page.getByTestId('open-library').click();await page.getByRole('tab',{name:/Designs/}).click();await expect(page.getByText('Preserved personal design',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel('Design name')).toHaveValue('Aerodynamics course · teaching car');
});

test('Unavailable course pack leaves the existing design usable',async({page})=>{
  await page.goto('/');await page.getByTestId('try-sample').click();await expect(page.getByLabel('Design name')).toHaveValue('Sample car');
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('easycfd.lastDesign'))).toBeTruthy();
  await page.route('**/course/models/rear_wing_6.stl',route=>route.fulfill({status:404,body:'Unavailable'}));await page.goto('/?courseLab=teaching-car');
  await expect(page.getByText('Could not load course part rear_wing_6.stl.',{exact:true})).toBeVisible();await expect(page.getByLabel('Design name')).toHaveValue('Sample car');
});

test('Print expands answers and restores them afterwards, while keeping quantitative widgets',async({page})=>{
  await page.goto('/course/index.html');await page.waitForFunction(()=>Boolean((window as unknown as {course?:{ready:boolean}}).course?.ready));
  const before=await page.locator('details[open]').count();expect(before).toBe(0);
  await page.evaluate(()=>((window as unknown as {course:{preparePrint():void}}).course.preparePrint()));await expect(page.locator('details:not([open])')).toHaveCount(0);
  // Printing hooks may fire after the exporter has already prepared the document.
  await page.evaluate(()=>((window as unknown as {course:{preparePrint():void}}).course.preparePrint()));
  await page.emulateMedia({media:'print'});await expect(page.locator('.toolbar')).not.toBeVisible();await expect(page.locator('[data-widget="gci"]')).toContainText('2.00%');
  await expect(page.locator('.printed-contents li')).toHaveCount(24);
  await page.evaluate(()=>((window as unknown as {course:{restorePrint():void}}).course.restorePrint()));expect(await page.locator('details[open]').count()).toBe(before);
});
