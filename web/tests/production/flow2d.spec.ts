import { expect, test } from "@playwright/test";

// Three cold solver initializations at the larger grids also run on portable WASM.
test.setTimeout(120_000);

for (const forceWasm of [false, true]) {
  test(`cold solver startup, reset and geometry change (${forceWasm ? "WASM" : "automatic backend"})`, async ({ page }) => {
    const errors: string[] = [], apiCalls: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url()); });
    const status = page.locator(".flow-status");
    const steps = () => page.locator(".flow-status small").textContent().then(s => Number(s?.split(" steps")[0].replaceAll(",", "")));
    await page.goto(`/?workspace=2d&profile=car${forceWasm ? "&flow-wasm" : ""}`);
    await expect(status).toContainText("Flow is evolving");
    await expect.poll(steps).toBeGreaterThanOrEqual(40);
    if (forceWasm) await expect(status).toContainText("WASM");
    await expect(page.locator(".flow-message")).toHaveCount(0);

    const image = () => page.locator(".flow-canvas").evaluate(c => (c as HTMLCanvasElement).toDataURL());
    const first = await image();
    await expect.poll(image).not.toEqual(first);
    await page.getByRole("button", { name: "Pause simulation", exact: true }).click();
    await page.getByRole("button", { name: "Reset flow", exact: true }).click();
    await expect(status).toContainText("Paused");
    await expect.poll(steps).toBe(8);
    await page.getByRole("button", { name: "Resume simulation", exact: true }).click();
    await expect.poll(steps).toBeGreaterThanOrEqual(40);

    await page.getByRole("combobox", { name: "Add shape" }).selectOption("cylinder");
    await expect(page.locator(".flow-project-name")).toHaveText("Cylinder wake");
    await expect(status).toContainText("Flow is evolving");
    await expect.poll(steps).toBeGreaterThanOrEqual(40);
    await expect(page.locator(".flow-message")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(apiCalls).toEqual([]);
  });
}
