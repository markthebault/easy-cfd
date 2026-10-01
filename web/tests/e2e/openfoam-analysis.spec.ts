import { test, expect } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

const backend = process.env.EASYCFD_AERO_BACKEND;
const runId = process.env.EASYCFD_AERO_RUN;
test("real OpenFOAM patch stress, saved balance, shared scales and reopening", async ({
  page,
  request,
}) => {
  test.skip(
    !backend || !runId,
    "Requires a completed native run with saved physical wall stress.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    const response = await request.fetch(`${backend}${u.pathname}${u.search}`, {
      method: req.method(),
      data: req.postDataBuffer() ?? undefined,
      headers: req.headers(),
      timeout: 120000,
    });
    if(u.pathname === '/api/runs' && req.method() === 'GET') {
      const records=await response.json();
      await route.fulfill({contentType:'application/json',body:JSON.stringify(records.filter((r:{id:string})=>r.id === runId))});return;
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  await page.getByTestId("open-library").click();
  await page.getByTestId("tab-server").click();
  await page
    .getByTestId("server-run")
    .filter({ hasText: "click to open" })
    .first()
    .click();
  await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM", {
    timeout: 120000,
  });
  await expect(page.getByTestId("aero-balance")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const r = (window as any).__easycfd.app.get().run;
    return {
      server: r.doc.result.openfoam.run,
      settings: r.doc.settings,
      balance: r.doc.result.balance,
      aero: r.doc.result.aero,
      reconciliation: r.doc.result.reconciliation,
      parts: r.parts.map((p: any, i: number) => ({
        key: p.file + "::" + p.name,
        group: p.group,
        valid: r.surface[i]?.stressValid?.filter((v: number) => v === 1).length,
      })),
      partForces: r.doc.result.partForces,
    };
  });
  expect(metrics.server).toBe(runId);
  expect(metrics.settings.axles.confirmed).toBe(true);
  expect(metrics.balance.frontLift + metrics.balance.rearLift).toBeCloseTo(
    metrics.aero.force[2],
    7,
  );
  expect(metrics.parts.every((p: any) => p.valid > 0)).toBe(true);
  expect(
    metrics.partForces.every((f: any) =>
      metrics.parts.some((p: any) => p.key === f.id && p.group === f.group),
    ),
  ).toBe(true);
  expect(metrics.reconciliation.complete).toBe(true);
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.getByTestId("analysis-friction").click();
  await expect(page.locator(".legend-title")).toContainText("Pa");
  await page.screenshot({ path: "test-results/aero-friction-openfoam.png" });
  const pngPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  const png = await pngPromise;
  await png.saveAs("test-results/aero-friction-openfoam-export.png");
  await page.getByRole("radio", { name: "Cf", exact: true }).click();
  await expect(page.locator(".legend-title")).toContainText("Cf");
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("aero-balance")).toBeVisible();
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.getByTestId("analysis-friction").click();
  // Same real run on both sides isolates the Compare shared-unit/range behaviour.
  await page.evaluate(async () => {
    const { app } = (window as any).__easycfd,
      s = app.get(),
      r = s.run;
    app.set({
      view: "compare",
      compare: { a: r, b: r },
      viz: { ...s.viz, friction: true, frictionUnit: "Cf", frictionMax: 0.01 },
    });
  });
  await expect(page.locator(".legend-title")).toContainText("Cf");
  await page.screenshot({ path: "test-results/aero-compare-openfoam.png" });
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/aero-openfoam-metrics.json",
    JSON.stringify(metrics, null, 2),
  );
  expect(errors).toEqual([]);
});
