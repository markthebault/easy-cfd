import { test, expect } from "@playwright/test";
import { checkTyreLoadAssessment } from "./tyreLoads";

test("wall-integrated balance, physical friction, units, reopen and old-run fallback", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByText("536 triangles")).toBeVisible();
  await page.locator("label.toggle").filter({ hasText: "Rear wing" }).click();
  await expect(page.getByText("536 triangles")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to conditions" }),
  ).toBeDisabled();
  await page
    .getByText("I checked size, orientation, wheels and clearance.")
    .click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page
    .getByRole("button", { name: "Suggest from marked wheels" })
    .click();
  await page.getByRole("checkbox", { name: "Confirm axle positions" }).check();
  await expect(page.getByTestId("axle-setup")).toContainText("wheelbase");
  await page.getByRole("spinbutton", {name:"Car mass", exact:true}).fill("1200");
  await page.getByRole("spinbutton", {name:"Front weight", exact:true}).fill("101");
  await expect(page.getByRole("button", {name:"Continue to run"})).toBeDisabled();
  await page.getByTestId("step-run").click();
  await expect(page.getByTestId("run")).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("weight inputs in Conditions");
  await page.getByTestId("step-conditions").click();
  await page.getByRole("spinbutton", {name:"Front weight", exact:true}).fill("55");
  await page.getByRole("button", { name: "Continue to run" }).click();
  await page.getByText("Expert WebGPU settings", { exact: true }).click();
  await page.getByRole("radio", { name: /Custom/ }).click();
  const sliders = page.locator(".step.open input[type=range]");
  await sliders.nth(0).fill("45");
  await sliders.nth(1).fill("2");
  await page.getByTestId("run").click();
  await expect(page.getByTestId("card-cd")).toBeVisible({ timeout: 240000 });
  await expect(page.getByTestId("aero-balance")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const r = (window as any).__easycfd.app.get().run;
    return {
      balance: r.doc.result.balance,
      lift: r.doc.result.lift,
      cl: r.doc.result.cl,
      wallIntegration: r.doc.result.wallIntegration,
      tyreLoads: r.doc.result.tyreLoads,
      reconciliation: r.doc.result.reconciliation,
      stress: r.surface.map((s: any) => ({
        valid: s?.stressValid?.filter((v: number) => v === 1).length,
        iteration: s?.snapshot?.iteration,
      })),
    };
  });
  expect(metrics.balance.frontLift + metrics.balance.rearLift).toBeCloseTo(
    metrics.lift,
    7,
  );
  expect(metrics.balance.frontCl + metrics.balance.rearCl).toBeCloseTo(
    metrics.cl,
    7,
  );
  expect(metrics.reconciliation.complete).toBe(true);
  expect(metrics.wallIntegration.passed).toBe(true);
  expect(metrics.stress.every((s: any) => s.valid > 0)).toBe(true);
  expect(metrics.tyreLoads.front.totalN).toBeCloseTo(1200 * 9.80665 * .55 - metrics.balance.frontLift, 7);
  expect(metrics.tyreLoads.rear.totalN).toBeCloseTo(1200 * 9.80665 * .45 - metrics.balance.rearLift, 7);
  await page.getByRole("button", { name: "Pause animation" }).click();
  await checkTyreLoadAssessment(page, "webgpu");
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.getByTestId("analysis-friction").click();
  await expect(page.locator(".legend-title")).toContainText("Surface friction");
  await expect(page.locator(".legend-title")).toContainText("Pa");
  await page.screenshot({ path: "test-results/aero-friction-webgpu.png" });
  await page.getByRole("radio", { name: "Cf", exact: true }).click();
  await expect(page.locator(".legend-title")).toContainText("Cf");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await expect(await download).toBeTruthy();
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("aero-balance")).toBeVisible();
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await expect(page.getByTestId("analysis-friction")).toBeEnabled();
  await page.getByTestId("analysis-friction").click();
  await page.screenshot({ path: "test-results/aero-balance-reopened.png" });
  await page.evaluate(() => {
    const { app } = (window as any).__easycfd,
      s = app.get(),
      run = {
        ...s.run,
        doc: {
          ...s.run.doc,
          result: { ...s.run.doc.result, aero: undefined, balance: undefined },
        },
        surface: s.run.surface.map((x: any) => ({ cp: x.cp, shear: x.shear })),
      };
    app.set({ run, viz: { ...s.viz, friction: false, surface: true } });
  });
  await expect(page.getByTestId("aero-balance-unavailable")).toBeVisible();
  await expect(page.getByTestId("tyre-loads-unavailable")).toContainText("saved axle positions");
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await expect(page.getByTestId("analysis-friction")).toBeDisabled();
  expect(errors).toEqual([]);
});
