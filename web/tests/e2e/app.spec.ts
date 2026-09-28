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
  await expect(page.getByRole("slider", { name: "Road speed" })).toHaveAttribute("aria-valuenow", "100");
  await page.getByRole("button", { name: "Continue to run" }).click();

  // ③ Run: custom, 45 cells, 2 passes
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
  const cd = (await page.getByTestId("card-cd").locator(".card-value").innerText()).trim();
  const cl = (await page.getByTestId("card-cl").locator(".card-value").innerText()).trim();
  expect(cd).toMatch(/^-?\d+\.\d{4}$/);
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

  // Reload and reopen the saved run
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("card-cd").locator(".card-value")).toHaveText(cd);
  await expect(page.getByTestId("card-cl").locator(".card-value")).toHaveText(cl);
  await page.getByTestId("layer-smoke").click();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
