import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("sample car, short run, results, layers, reopen after reload", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");

  // ① Car
  await page.getByTestId("try-sample").click();
  await expect(page.getByText("Built-in sample car")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to conditions" })).toBeDisabled();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();

  // ② Conditions
  await expect(page.getByRole("slider", { name: "Wind speed" })).toHaveAttribute("aria-valuenow", "100");
  await page.getByRole("checkbox", { name: "Moving road", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Rotating wheels", exact: true }).uncheck();
  await page.getByRole("button", { name: "Continue to run" }).click();
  await expect(page.getByTestId("run-boundaries")).toHaveText("Road fixed · Wheels fixed");

  // ③ Run: custom, 45 cells, 2 passes
  await page.getByText("Expert WebGPU settings",{exact:true}).click();
  await page.getByRole("radio", { name: /Custom/ }).click();
  const sliders = page.locator(".step.open input[type=range]");
  await sliders.nth(0).fill("45");
  await sliders.nth(1).fill("2");
  await expect(page.getByText("2 × car length")).toBeVisible();
  const gpu = await page.locator(".gpu-line").innerText();
  test.skip(/not available|No WebGPU/i.test(gpu), `WebGPU unavailable: ${gpu}`);
  await page.getByTestId("run").click();

  // Live view, then results
  await expect(page.getByText("Solving the flow").or(page.getByText("Preparing the grid"))).toBeVisible();
  await expect(page.getByTestId("card-cd")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId("run-boundaries")).toHaveText("Road fixed · Wheels fixed");
  const motion = await page.evaluate(() => {
    const { app } = (window as any).__easycfd;
    const s = app.get().run.doc.settings;
    return { road: s.moving_ground, wheels: s.wheels };
  });
  expect(motion.road).toBe(false);
  expect(motion.wheels).toBe(false);
  const cd = (await page.getByTestId("card-cd").locator(".card-value").innerText()).trim();
  const cl = (await page.getByTestId("card-cl").locator(".card-value").innerText()).trim();
  expect(cd).toMatch(/^-?\d+\.\d{4}$/);
  await expect(page.getByTestId("window-stats").locator("tbody tr")).toHaveCount(2);
  expect(cl).toMatch(/^-?\d+\.\d{4}$/);
  expect(Number(cd)).toBeGreaterThan(0);
  await expect(page.getByTestId("card-drag").locator(".card-value")).toContainText(/\d/);
  await expect(page.getByTestId("card-vertical").locator(".card-label")).toHaveText(/Downforce|Lift/);

  // Every visualisation layer on and off
  for (const layer of ["smoke", "streamlines", "slice", "wake", "surface"]) {
    const btn = page.getByTestId(`layer-${layer}`);
    await btn.click();
    await page.waitForTimeout(700);
    await btn.click();
    await page.waitForTimeout(300);
  }
  await page.getByTestId("layer-slice").click();
  for (const field of ["Pressure", "Cp0", "k", "Speed"]) {
    await page.getByRole("radio", { name: field, exact: true }).click();
    await page.waitForTimeout(250);
  }
  expect(errors).toEqual([]);

  // Guided analysis presets use the computed field and measured forces.
  const choose = async (mode: string) => {
    await page.getByRole("button", { name: "Explore airflow" }).click();
    await page.getByTestId(`analysis-${mode}`).click();
    await expect(page.getByRole("button", { name: "Explore airflow" })).toHaveAttribute("aria-expanded", "false");
  };
  await page.getByRole("button", { name: "Pause animation" }).click();
  for (const mode of ["overview", "pressure", "vertical", "horizontal", "surfaceFlow", "wake", "turbulence", "forces", "clouds"]) {
    await choose(mode);
    await expect(page.locator(".analysis-current")).not.toHaveText("Custom layers");
    const stats = await page.evaluate(() => {
      const { app, stages } = (window as any).__easycfd;
      const s = stages.main;
      return {
        viz: app.get().viz,
        cloudTriangles: s.clouds.children.map((m: any) => m.geometry.index.count),
        streamVertices: s.streamMesh?.geometry.getAttribute("position").count,
        oilVisible: s.oilMesh?.visible,
        forceVisible: s.forceGroup.visible,
        forceLabels: s.forceGroup.children.filter((o: any) => o.isSprite).length,
      };
    });
    if (mode === "vertical" || mode === "horizontal") {
      expect(stats.viz.stream.orientation).toBe(mode);
      expect(stats.streamVertices).toBeGreaterThan(0);
    }
    if (mode === "overview") {
      expect(stats.viz.surface).toBe(true);
      expect(stats.streamVertices).toBeGreaterThan(0);
      await expect(page.locator(".legend-title")).toHaveCount(2);
      await expect(page.locator(".legend-stack")).toContainText("Surface pressure");
      await expect(page.locator(".legend-stack")).toContainText("Air speed · steady flow");
      await page.getByText("Local wake seeds", { exact: true }).click();
      const withoutWake = await page.evaluate(() => (window as any).__easycfd.stages.main.streamMesh.geometry.getAttribute("position").count);
      expect(withoutWake).toBeLessThan(stats.streamVertices);
      await page.getByText("Local wake seeds", { exact: true }).click();
      await page.getByRole("button", { name: "Close options" }).click();
      await page.screenshot({ path: "test-results/analysis-overview.png" });
      const exported = page.waitForEvent("download");
      await page.getByRole("button", { name: "PNG", exact: true }).click();
      await (await exported).saveAs("test-results/analysis-overview-export.png");
    }
    if (mode === "surfaceFlow") expect(stats.oilVisible).toBe(true);
    if (mode === "forces") {
      expect(stats.forceVisible).toBe(true);
      expect(stats.forceLabels).toBeGreaterThanOrEqual(2);
      await expect(page.locator(".force-readouts")).toContainText("Drag");
      await page.getByRole("button", { name: "Close options" }).click();
      await page.screenshot({ path: "test-results/analysis-forces.png" });
    }
    if (mode === "clouds") {
      expect(stats.cloudTriangles.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0);
      await page.getByRole("radio", { name: "Suction", exact: true }).click();
      await expect(page.locator(".cloud-legend")).not.toContainText("Positive");
      await page.getByRole("radio", { name: "Both", exact: true }).click();
      await page.getByRole("slider", { name: "Pressure threshold" }).fill("0.25");
      await expect(page.locator(".cloud-legend")).toContainText("0.25");
      await page.getByRole("button", { name: "Close options" }).click();
      await page.screenshot({ path: "test-results/analysis-clouds.png" });
    }
  }
  await choose("horizontal");
  await page.getByRole("button", { name: "Close options" }).click();
  await page.screenshot({ path: "test-results/analysis-horizontal.png" });
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.screenshot({ path: "test-results/analysis-picker.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Explore airflow" })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await expect(page.getByTestId("analysis-clouds")).toBeVisible();
  await page.getByTestId("analysis-overview").click();
  await expect(page.getByRole("region", { name: "streamlines options" })).not.toBeVisible();
  await page.getByRole("button", { name: "View settings" }).click();
  await expect(page.getByRole("switch", { name: "Local wake seeds" })).toBeVisible();
  await page.getByRole("button", { name: "Close options" }).click();
  await page.screenshot({ path: "test-results/analysis-overview-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.getByTestId("analysis-forces").click();
  await expect(page.getByRole("region", { name: "forces options" })).not.toBeVisible();
  await page.getByRole("button", { name: "View settings" }).click();
  await expect(page.getByRole("switch", { name: "Show force arrows" })).toBeVisible();
  await page.getByRole("button", { name: "Close options" }).click();
  await page.screenshot({ path: "test-results/analysis-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(errors).toEqual([]);

  // Reload and reopen the saved run
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("card-cd").locator(".card-value")).toHaveText(cd);
  await expect(page.getByTestId("card-cl").locator(".card-value")).toHaveText(cl);
  await expect(page.getByTestId("run-boundaries")).toHaveText("Road fixed · Wheels fixed");
  await page.getByTestId("layer-smoke").click();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);

  // A controlled comparison fixture checks opposite vertical force signs and shared arrow lengths.
  await page.evaluate(() => {
    const { app } = (window as any).__easycfd;
    const a = app.get().run;
    const r = a.doc.result;
    const b = { ...a, doc: { ...a.doc, id: "force-direction-fixture", designName: "Force direction fixture", result: { ...r, drag: r.drag * 2, lift: -r.lift, downforce: r.lift, side: 0 } } };
    app.set({ compare: { a, b }, view: "compare" });
  });
  await choose("forces");
  const arrows = await page.evaluate(() => {
    const { stages, app } = (window as any).__easycfd;
    return ["cmpA", "cmpB"].map(id => {
      const s = stages[id];
      s.scene.updateMatrixWorld(true);
      const arrows = s.forceGroup.children.filter((o: any) => o.type === "ArrowHelper");
      return { dragLength: arrows[0].cone.position.y, verticalDirection: arrows[1].matrixWorld.elements[6], expectedLift: app.get().compare[id === "cmpA" ? "a" : "b"].doc.result.lift };
    });
  });
  expect(arrows[1].dragLength / arrows[0].dragLength).toBeCloseTo(2, 5);
  for (const a of arrows) expect(a.verticalDirection).toBeCloseTo(Math.sign(a.expectedLift), 5);
  await expect(page.getByText("Values below are for run A.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close options" }).click();
  await page.screenshot({ path: "test-results/analysis-comparison.png" });
  await page.getByRole("button", { name: "Close comparison" }).click();
  await page.evaluate(() => (window as any).__easycfd.app.set({ dark: true }));
  await page.getByRole("button", { name: "Explore airflow" }).click();
  await page.screenshot({ path: "test-results/analysis-picker-dark.png" });
  expect(errors).toEqual([]);
});
