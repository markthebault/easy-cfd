import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
test.setTimeout(120_000);
const scene = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("easycfd.flow2d.v2")!));
async function start(page: Page) { await page.goto("/?workspace=2d&profile=car&flow-wasm"); await expect(page.locator(".flow-status")).toContainText("Paused"); }
async function stroke(page: Page, a: number[], b: number[]) { await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 8 }); await page.mouse.up(); }

test("point deletion is deliberate and the small close target still closes", async ({ page }) => {
  await start(page); await page.getByRole("button", { name: "Draw", exact: true }).click();
  const area = page.locator(".flow-edit-overlay"), points = page.locator(".flow-drawing-point");
  for (const [x, y] of [[430,440],[600,440],[600,500],[430,500]]) await area.click({position:{x,y}});
  await points.nth(1).click(); await expect(points).toHaveCount(4);
  await points.nth(1).click({button:"right"}); await expect(points).toHaveCount(3);
  await page.keyboard.press("Control+z"); await expect(points).toHaveCount(2);
  await area.click({position:{x:600,y:440}});
  await points.nth(2).dblclick(); await expect(points).toHaveCount(2);
  await points.nth(1).click({button:"right"});
  await area.click({position:{x:600,y:440}}); await area.click({position:{x:600,y:500}}); await area.click({position:{x:430,y:500}});
  await expect(page.locator(".flow-close-zone")).toHaveAttribute("r","4.5");
  await points.first().click();
  await expect(page.locator(".flow-project-name")).toHaveText("Custom profile");
  const anchors = page.locator(".flow-handle"); await expect(anchors).toHaveCount(4);
  await anchors.nth(1).click(); await expect(anchors).toHaveCount(4);
  await anchors.nth(1).click({button:"right"}); await expect(anchors).toHaveCount(3);
  await page.keyboard.press("Control+z"); await expect(anchors).toHaveCount(4);
  await anchors.nth(1).dblclick(); await expect(anchors).toHaveCount(3);
  await expect(page.locator(".flow-message")).toHaveCount(0);
});

test("Bézier handles survive resizing, group transforms, SVG export and reload", async ({page}) => {
  await start(page); await page.getByRole("button",{name:"Draw",exact:true}).click();
  await page.getByRole("button",{name:"Bézier drawing tool"}).click();
  for (const [a,b] of [[[430,470],[430,450]],[[560,430],[600,430]],[[690,470],[690,490]],[[560,510],[520,510]]]) await stroke(page,a,b);
  await page.getByRole("button",{name:"Close shape",exact:true}).click();
  await expect(page.locator(".flow-project-name")).toHaveText("Bézier profile");
  await expect(page.locator(".flow-handle")).toHaveCount(4);
  await expect(page.locator(".flow-tangent-handle")).toHaveCount(8);
  const first = (await scene(page)).shapes[1].curve;
  const handle = page.getByRole("button",{name:"Bézier outgoing handle 2"}), h = (await handle.boundingBox())!;
  await stroke(page,[h.x+h.width/2,h.y+h.height/2],[h.x+h.width/2+12,h.y+h.height/2-8]);
  await expect.poll(async()=>JSON.stringify((await scene(page)).shapes[1].curve)).not.toBe(JSON.stringify(first));
  await page.getByRole("button",{name:"Done",exact:true}).click();
  const width = page.getByRole("spinbutton",{name:"Width",exact:true}), height = page.getByRole("spinbutton",{name:"Height",exact:true});
  await width.fill("900"); await width.press("Enter"); await height.fill("250"); await height.press("Enter");
  await expect(width).toHaveValue("900"); await expect(height).toHaveValue("250");
  await page.getByRole("checkbox",{name:"Lock proportions"}).check(); await width.fill("1000"); await width.press("Enter");
  await expect.poll(async()=>Number(await height.inputValue())).toBeCloseTo(277.78,1);
  const right = (await page.getByRole("button",{name:"Resize right",exact:true}).boundingBox())!;
  await stroke(page,[right.x+4,right.y+4],[right.x+34,right.y+4]);
  await expect.poll(async()=>Number(await width.inputValue())).toBeGreaterThan(1050);
  await page.keyboard.press("Control+z"); await expect(width).toHaveValue("1000");
  await page.mouse.click(700,300); await page.keyboard.press("Control+a");
  await expect(page.getByRole("list",{name:"Scene shapes"}).getByRole("button",{pressed:true})).toHaveCount(2);
  const before = await scene(page), body = (await page.getByRole("button",{name:"Select Car silhouette",exact:true}).boundingBox())!;
  await stroke(page,[body.x+body.width/2,body.y+body.height/2],[body.x+body.width/2+20,body.y+body.height/2-35]);
  const after = await scene(page);
  for(let i=0;i<2;i++) { expect(after.shapes[i].points[0].x-before.shapes[i].points[0].x).toBeCloseTo(20/65,5); expect(after.shapes[i].points[0].y-before.shapes[i].points[0].y).toBeCloseTo(35/65,5); }
  const rotation = page.getByRole("spinbutton",{name:"Rotation",exact:true}); await rotation.fill("5"); await rotation.press("Enter");
  await expect(rotation).toHaveValue("5"); expect((await scene(page)).shapes.every((s:{rotation:number})=>s.rotation===5)).toBe(true);
  const download = page.waitForEvent("download"); await page.getByRole("button",{name:"Export profile SVG"}).click();
  const path = await (await download).path(); expect(await readFile(path!,"utf8")).toMatch(/<path d="M.* C/);
  const saved = (await scene(page)).shapes;
  await page.reload(); await expect(page.locator(".flow-status")).toContainText("Paused");
  expect((await scene(page)).shapes).toEqual(saved); await expect(page.locator(".flow-message")).toHaveCount(0);
});

test("drawing tools add rectangles, ellipses and a freehand outline", async ({page}) => {
  await start(page);
  for(const tool of ["Rectangle","Ellipse","Freehand"]) {
    await page.getByRole("button",{name:"Draw",exact:true}).click(); await page.getByRole("button",{name:`${tool} drawing tool`}).click();
    if(tool!=="Freehand") await stroke(page,[850,410],[980,470]);
    else { await page.mouse.move(700,410); await page.mouse.down(); for(const [x,y] of [[740,400],[800,415],[815,450],[750,470],[700,450]]) await page.mouse.move(x,y,{steps:4}); await page.mouse.up(); }
    await page.getByRole("button",{name:"Add shape",exact:true}).click();
    await expect(page.locator(".flow-project-name")).toHaveText(tool==="Freehand"?"Freehand profile":tool);
  }
  const stored = await scene(page); expect(stored.shapes).toHaveLength(4); expect(stored.shapes[2].curve).toHaveLength(4);
  await expect(page.locator(".flow-message")).toHaveCount(0);
});

test("zoom, pan, speed limits and mobile tools remain usable", async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await start(page);
  const speed = page.getByRole("slider",{name:"Animation speed"}); await speed.focus(); await speed.press("Home"); await expect(speed).toHaveValue("0.1"); await expect(page.locator(".flow-speed-slider output")).toHaveText("0.1×");
  await speed.press("End"); await expect(speed).toHaveValue("3"); await expect(page.locator(".flow-speed-slider output")).toHaveText("3.0×");
  const before = (await scene(page)).shapes;
  await page.getByRole("button",{name:"Zoom in",exact:true}).click(); await expect(page.getByRole("button",{name:"Reset zoom"})).toHaveText("125%");
  await page.mouse.move(190,420); await page.mouse.wheel(0,-150); await expect.poll(async()=>page.getByRole("button",{name:"Reset zoom"}).textContent()).not.toBe("125%");
  await page.getByRole("button",{name:"Pan view"}).click(); const shape=page.getByRole("button",{name:"Select Car silhouette",exact:true}), b=(await shape.boundingBox())!;
  await stroke(page,[200,390],[230,410]); const a=(await shape.boundingBox())!; expect(a.x-b.x).toBeCloseTo(30,0); expect(a.y-b.y).toBeCloseTo(20,0);
  expect((await scene(page)).shapes).toEqual(before);
  await page.getByRole("button",{name:"Pan view"}).click(); await page.getByRole("button",{name:"Reset zoom"}).click();
  await page.getByRole("button",{name:"Draw",exact:true}).click(); await expect(page.getByRole("toolbar",{name:"Drawing tools"})).toBeVisible();
  for(const name of ["Lines","Bézier","Rectangle","Ellipse","Freehand"]) await expect(page.getByRole("button",{name:`${name} drawing tool`})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();
  await page.getByRole("button",{name:"Rectangle drawing tool"}).click(); await stroke(page,[110,500],[220,540]); await page.getByRole("button",{name:"Add shape",exact:true}).click();
  const points=(await scene(page)).shapes[1].points as {x:number;y:number}[];
  expect(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))).toBeCloseTo(110/((390-24)/20*1.25),5);
  expect(Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))).toBeCloseTo(40/((390-24)/20*1.25),5);
  await page.getByRole("button",{name:"About 2D flow"}).click(); await expect(page.getByRole("dialog")).toContainText("801 × 281");
});

test("dragging a selection box groups shapes for movement, supports Shift, cancel and zoom", async ({page}) => {
  const rectangle=(id:string,name:string,x:number,y:number,w:number,h:number)=>({id,name,rotation:0,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
  const initial={tunnel:"legacy",shapes:[rectangle("a","Part A",1,.35,.25,.2),rectangle("b","Part B",1.5,.35,.25,.2),rectangle("c","Part C",2.5,.65,.25,.15)],selectedId:"c",selectedIds:["c"]};
  await page.addInitScript(value=>localStorage.setItem("easycfd.flow2d.v2",JSON.stringify(value)),initial);
  await page.goto("/?workspace=2d&flow-wasm"); await expect(page.locator(".flow-status")).toContainText("Paused");
  const selected=page.getByRole("list",{name:"Scene shapes"}).getByRole("button",{pressed:true});
  await page.mouse.move(330,520);await page.mouse.down();await page.mouse.move(630,620,{steps:8});
  await expect(page.getByLabel("Selection box",{exact:true})).toBeVisible();await expect(selected).toHaveCount(2);
  await page.mouse.up();await expect(page.locator(".flow-marquee")).toHaveCount(0);
  const before=(await scene(page)).shapes, body=(await page.getByRole("button",{name:"Select Part A",exact:true}).boundingBox())!;
  await stroke(page,[body.x+body.width/2,body.y+body.height/2],[body.x+body.width/2+30,body.y+body.height/2-20]);
  await expect.poll(async()=>(await scene(page)).shapes[0].points[0].x).not.toBe(before[0].points[0].x);
  const moved=(await scene(page)).shapes;
  for(let i=0;i<2;i++){expect(moved[i].points[0].x-before[i].points[0].x).toBeCloseTo(30/(1360/4.2),5);expect(moved[i].points[0].y-before[i].points[0].y).toBeCloseTo(20/(1360/4.2),5);}expect(moved[2]).toEqual(before[2]);
  await page.keyboard.press("Control+z");await expect.poll(async()=>(await scene(page)).shapes).toEqual(before);
  const border=await page.getByRole("button",{name:"Move selected shapes",exact:true}).evaluate(el=>({x:Number(el.getAttribute("x")),y:Number(el.getAttribute("y")),width:Number(el.getAttribute("width"))}));
  await stroke(page,[border.x+border.width*.3,border.y],[border.x+border.width*.3+20,border.y-10]);
  await expect.poll(async()=>(await scene(page)).shapes[1].points[0].x).not.toBe(before[1].points[0].x);
  await page.keyboard.press("Control+z");await expect.poll(async()=>(await scene(page)).shapes).toEqual(before);
  await page.keyboard.down("Shift");await stroke(page,[970,530],[800,430]);await page.keyboard.up("Shift");await expect(selected).toHaveCount(3);
  await page.keyboard.down("Shift");await stroke(page,[1050,380],[1100,410]);await page.keyboard.up("Shift");await expect(selected).toHaveCount(3);
  await page.mouse.move(1076,407);await page.mouse.down();await page.mouse.move(330,520,{steps:8});await expect(selected).toHaveCount(1);
  await page.keyboard.press("Escape");await expect(page.locator(".flow-marquee")).toHaveCount(0);await expect(selected).toHaveCount(3);await page.mouse.up();
  await stroke(page,[1050,380],[1100,410]);await expect(selected).toHaveCount(0);
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();await page.getByRole("button",{name:"Pan view"}).click();await stroke(page,[720,350],[760,370]);await page.getByRole("button",{name:"Pan view"}).click();
  const a=(await page.getByRole("button",{name:"Select Part A",exact:true}).boundingBox())!,b=(await page.getByRole("button",{name:"Select Part B",exact:true}).boundingBox())!;
  await stroke(page,[Math.min(a.x,b.x)-20,Math.min(a.y,b.y)-20],[Math.max(a.x+a.width,b.x+b.width)+20,Math.max(a.y+a.height,b.y+b.height)+20]);
  await expect(selected).toHaveCount(2);expect((await scene(page)).shapes).toEqual(before);await expect(page.locator(".flow-message")).toHaveCount(0);
});
