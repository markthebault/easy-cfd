import {test,expect} from "@playwright/test";
import {readFile} from "node:fs/promises";
test.use({reducedMotion:"reduce",viewport:{width:1440,height:900}});
const saved=(page:import('@playwright/test').Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('easycfd.flow2d.v2')!));
test("MX-5 NC PRHT silhouette preserves the supplied curves, scales correctly and runs from the parts box",async({page})=>{
  test.setTimeout(120_000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?workspace=2d&profile=airfoil&flow-wasm');await expect(page.locator('.flow-status')).toContainText('Paused');
  const original=(await saved(page)).shapes[0];
  await page.getByRole('combobox',{name:'Add shape'}).selectOption({label:'MX-5 NC PRHT'});
  await expect(page.locator('.flow-project-name')).toHaveText('MX-5 NC PRHT');
  await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('large');
  await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('4000');
  const current=await saved(page),body=current.shapes[1];expect(current.shapes[0]).toEqual(original);
  expect(body.vehicle).toBe(true);expect(body.curve).toHaveLength(33);expect(body.points.length).toBeLessThan(512);
  expect(Math.min(...body.points.map((p:{y:number})=>p.y))).toBeCloseTo(.15,8);
  expect(Math.max(...body.points.map((p:{y:number})=>p.y))).toBeLessThan(1.4);
  await expect(page.getByRole('button',{name:'Size as car · 4.3 × 1.5 m'})).toHaveCount(0);
  await page.getByRole('button',{name:'Edit points',exact:true}).click();await expect(page.locator('.flow-handle')).toHaveCount(33);
  expect(await page.locator('.flow-tangent-handle').count()).toBeGreaterThan(20);
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('checkbox',{name:'Enable Airfoil section',exact:true}).uncheck();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export profile SVG'}).click();
  const exported=await readFile((await(await download).path())!,'utf8');expect(exported).toContain('<path d="M');expect(exported).toContain(' C');expect(exported).not.toContain('<rect');
  expect(Number(exported.match(/width="([\d.]+)mm"/)![1])).toBeCloseTo(4000,5);
  await page.getByRole('button',{name:'Resume simulation',exact:true}).click();
  await expect.poll(async()=>Number((await page.locator('.flow-status small').textContent())!.split(' steps')[0].replaceAll(',',''))).toBeGreaterThan(40);
  await page.getByRole('button',{name:'Pause simulation',exact:true}).click();
  await page.reload();await expect(page.locator('.flow-status')).toContainText('Paused');
  expect((await saved(page)).shapes[1].curve).toEqual(body.curve);await expect(page.getByRole('checkbox',{name:'Enable MX-5 NC PRHT',exact:true})).toBeChecked();
  await page.getByRole('combobox',{name:'Add shape'}).selectOption({label:'Inverted airfoil (rear wing)'});
  await expect(page.locator('.flow-project-name')).toHaveText('Inverted airfoil');await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('500');
  await expect(page.getByRole('checkbox',{name:'Enable Inverted airfoil',exact:true})).toBeChecked();
  const wing=(await saved(page)).shapes[2],tail=wing.points.reduce((a:{x:number;y:number},b:{x:number;y:number})=>b.x>a.x?b:a);expect(tail.y).toBeGreaterThan(wing.points[0].y);
  expect(errors).toEqual([]);await expect(page.locator('.flow-message')).toHaveCount(0);
});
test("full-size car, labelled pause, focus and safe tunnel changes",async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?workspace=2d&profile=car&flow-wasm');await expect(page.locator('.flow-status')).toContainText('Paused');
  await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('large');await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('4300');await expect(page.getByRole('spinbutton',{name:'Height',exact:true})).toHaveValue('1500');
  await expect(page.locator('.flow-canvas')).toHaveAttribute('data-domain-width','20');await expect(page.locator('.flow-canvas')).toHaveAttribute('data-domain-height','7');
  const body=page.getByRole('button',{name:'Select Car silhouette',exact:true}),before=(await body.boundingBox())!;expect(before.width).toBeCloseTo(4.3*65,0);
  await page.getByRole('button',{name:'Fit selection'}).click();expect((await body.boundingBox())!.width).toBeGreaterThan(before.width*2);await page.getByRole('button',{name:'Reset zoom'}).click();
  await page.getByRole('combobox',{name:'Simulation box'}).selectOption('small');await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('large');await expect(page.getByRole('alert')).toContainText('larger box');await page.getByRole('button',{name:'Dismiss message'}).click();
  await page.getByRole('button',{name:'Resume simulation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause simulation',exact:true})).toContainText('Pause');
  await expect.poll(async()=>Number((await page.locator('.flow-status small').textContent())!.split(' steps')[0].replaceAll(',',''))).toBeGreaterThan(8);
  await page.getByRole('button',{name:'Pause simulation',exact:true}).click();await page.waitForTimeout(200);const frozen=await page.locator('.flow-canvas').evaluate(c=>(c as HTMLCanvasElement).toDataURL());await page.waitForTimeout(150);expect(await page.locator('.flow-canvas').evaluate(c=>(c as HTMLCanvasElement).toDataURL())).toBe(frozen);
  await page.getByRole('button',{name:'New parts scene',exact:true}).click();await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('small');await page.getByRole('button',{name:'Undo profile change'}).click();await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('large');
  expect(errors).toEqual([]);
});
test("parts keep their metre dimensions across all box grids and reload",async({page})=>{
  await page.goto('/?workspace=2d&tunnel=small&profile=airfoil&flow-wasm');await expect(page.locator('.flow-status')).toContainText('Paused');const shapes=(await saved(page)).shapes;
  for(const [id,width,height,nx,ny] of [['medium','7','3','701','301'],['large','20','7','801','281'],['small','3','2','601','401']]){
    await page.getByRole('combobox',{name:'Simulation box'}).selectOption(id);await expect(page.locator('.flow-status')).toContainText('Paused');await expect(page.locator('.flow-canvas')).toHaveAttribute('data-domain-width',width);await expect(page.locator('.flow-canvas')).toHaveAttribute('data-domain-height',height);await expect(page.locator('.flow-canvas')).toHaveAttribute('data-grid-nx',nx);await expect(page.locator('.flow-canvas')).toHaveAttribute('data-grid-ny',ny);expect((await saved(page)).shapes).toEqual(shapes);
  }
  await page.reload();await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('small');expect((await saved(page)).shapes).toEqual(shapes);await expect(page.locator('.flow-message')).toHaveCount(0);
});
test("old small car can be calibrated and full-size SVGs retain millimetre dimensions",async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('easycfd.flow2d.v2',JSON.stringify({shapes:[{id:'old',name:'Car silhouette',rotation:0,points:[{x:1.2,y:.593},{x:2,y:.593},{x:2,y:.808},{x:1.2,y:.808}]}],selectedId:'old'})));
  await page.goto('/?workspace=2d&flow-wasm');await expect(page.locator('.flow-status')).toContainText('Paused');await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('medium');await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('800');
  await page.getByRole('button',{name:'Size as car · 4.3 × 1.5 m'}).click();await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('4300');await expect(page.getByRole('spinbutton',{name:'Height',exact:true})).toHaveValue('1500');
  await page.getByRole('combobox',{name:'Simulation box'}).selectOption('large');await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByRole('combobox',{name:'Simulation box'})).toHaveValue('large');
  await page.locator('input[type=file]').setInputFiles({name:'full-size.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4300 1500"><path d="M0 0H4300V1500H0Z"/></svg>')});await page.getByRole('spinbutton',{name:'SVG profile width in millimetres'}).fill('4300');await page.getByRole('button',{name:'Import profile',exact:true}).click();
  await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('4300');await expect(page.getByRole('spinbutton',{name:'Height',exact:true})).toHaveValue('1500');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export profile SVG'}).click();const text=await readFile((await (await download).path())!,'utf8');expect(Number(text.match(/width="([\d.]+)mm"/)![1])).toBeCloseTo(4300,5);expect(Number(text.match(/height="([\d.]+)mm"/)![1])).toBeCloseTo(1500,5);await expect(page.locator('.flow-message')).toHaveCount(0);
});
