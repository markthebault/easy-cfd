import { expect, test } from "@playwright/test";

test("browser runs are steady; physical-time recording stays on the connected server", async ({page})=>{
  await page.route("**/api/health",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({ready:true,message:"Ready",presets:{fast:{cell:.8,surface:2,layers:0,max_cells:100000,iterations:300,label:"Fast"},medium:{cell:.4,surface:3,layers:6,max_cells:500000,iterations:1000,label:"Medium"},precise:{cell:.3,surface:4,layers:8,max_cells:1000000,iterations:1500,label:"Precise"}},measured:{}})}));
  await page.route("**/api/runs",route=>route.fulfill({contentType:"application/json",body:"[]"}));
  await page.goto("/");await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button",{name:"Continue to conditions"}).click();
  await page.getByRole("button",{name:"Continue to run"}).click();
  await expect(page.getByRole("switch",{name:"Record flow animation"})).toHaveCount(0);
  await expect(page.getByTestId("engine-openfoam")).toBeEnabled();
  await page.getByTestId("engine-openfoam").click();
  await page.getByRole("switch",{name:"Record flow animation"}).check();
  await expect(page.getByLabel("Recording detail")).toBeVisible();
  await page.getByTestId("engine-wasm").click();
  await expect(page.getByRole("switch",{name:"Record flow animation"})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.flow_animation)).toBe(false);
});
