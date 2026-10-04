import { test, expect } from "@playwright/test";
import { checkTyreLoadAssessment } from "./tyreLoads";

const backend = process.env.EASYCFD_AUTO_AXLE_BACKEND;
const runId = process.env.EASYCFD_AUTO_AXLE_RUN;
test("actual saved car without confirmed axles recovers wheel positions, moment reference and tyre loads", async ({page,request}) => {
  test.skip(!backend || !runId, "Requires a real saved native run with four wheels and moments but no axles.");
  const original = await (await request.get(`${backend}/api/runs/${runId}`)).json();
  expect(original.settings.axles).toBeNull();
  expect(original.result.aero).toBeTruthy();
  const wheels = original.geometry.parts.filter((p:any)=>p.role === "wheel" && p.enabled).map((p:any)=>p.wheel).sort((a:any,b:any)=>a.center[0]-b.center[0]);
  expect(wheels).toHaveLength(4);
  const frontX=(wheels[0].center[0]+wheels[1].center[0])/2, rearX=(wheels[2].center[0]+wheels[3].center[0])/2;
  const aero = original.result.aero;
  const pitch = aero.moment[1] + aero.origin[2]*aero.force[0] - (aero.origin[0]-frontX)*aero.force[2];
  const rearLift = -pitch/(rearX-frontX), frontLift=aero.force[2]-rearLift;
  await page.route("**/api/**", async route => {
    const req=route.request(),u=new URL(req.url());
    const response=await request.fetch(`${backend}${u.pathname}${u.search}`,{method:req.method(),data:req.postDataBuffer()??undefined,headers:req.headers(),timeout:120000});
    if (u.pathname === "/api/runs") {
      const records=await response.json();
      await route.fulfill({contentType:"application/json",body:JSON.stringify(records.filter((r:any)=>r.id===runId))});
    } else await route.fulfill({response});
  });
  await page.goto("/");
  await page.getByTestId("open-library").click();
  await page.getByTestId("tab-server").click();
  await page.getByTestId("server-run").first().click();
  await expect(page.getByTestId("aero-balance")).toBeVisible({timeout:120000});
  await expect(page.getByTestId("detected-wheel-axles")).toContainText("2.330 m");
  const doc=await page.evaluate(()=>(window as any).__easycfd.app.get().run.doc);
  expect(doc.settings.axles).toBeUndefined();
  expect(doc.result.balance).toBeUndefined();
  expect(doc.axleLoadAssessment.axles.source).toBe("wheels");
  expect(doc.axleLoadAssessment.axles.rearX-doc.axleLoadAssessment.axles.frontX).toBeCloseTo(rearX-frontX,4);
  await page.getByRole("button", {name:"Pause animation"}).click();
  await checkTyreLoadAssessment(page,"detected-openfoam",{frontLift,rearLift});
  const panel=page.getByTestId("tyre-loads");
  await panel.locator("summary").click();
  await panel.getByRole("spinbutton",{name:"Car mass",exact:true}).fill("1100");
  await panel.getByRole("spinbutton",{name:"Front weight",exact:true}).fill("50");
  const loads=await page.evaluate(()=>(window as any).__easycfd.app.get().run.doc.tyreLoadAssessment.loads);
  expect(loads.front.totalN).toBeCloseTo(1100*9.80665*.5-frontLift,3);
  expect(loads.rear.totalN).toBeCloseTo(1100*9.80665*.5-rearLift,3);
  await panel.locator("summary").click();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({path:"test-results/wheel-axles-real-car.png"});
  expect(await (await request.get(`${backend}/api/runs/${runId}`)).json()).toEqual(original);
});
