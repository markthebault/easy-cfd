import { expect, test } from "@playwright/test";
test.setTimeout(60_000);

test("orbit and pan can pass below the road, with an unobstructed underbody preset", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.getByRole("button", { name: "Expand view" }).click();
  const camera = () => page.evaluate(() => {
    const s = (window as any).__easycfd.stages.main;
    return { z: s.camera.position.z, targetZ: s.controls.target.z, road: s.road.visible, shadow: s.shadowCatcher.visible };
  });
  await page.evaluate(() => (window as any).__easycfd.stages.main.applyCamera({ position: [0, -6, 2], target: [0, 0, 0.5] }));
  await page.mouse.move(1000, 650);
  await page.mouse.down();
  await page.mouse.move(1000, 300, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await camera()).z).toBeLessThan(0);
  await expect.poll(async () => (await camera()).road).toBe(false);
  expect((await camera()).shadow).toBe(false);
  await page.evaluate(() => (window as any).__easycfd.stages.main.applyCamera({ position: [5, -4, -3], target: [0, 0, -0.25] }));
  expect((await camera()).targetZ).toBeCloseTo(-0.25, 5);
  expect((await camera()).z).toBeLessThan(0);
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect.poll(async () => (await camera()).road).toBe(true);
  await page.getByRole("button", { name: "Underbody", exact: true }).click();
  await expect.poll(async () => (await camera()).z).toBeLessThan(0);
  await expect.poll(async () => (await camera()).road).toBe(false);
  await page.waitForTimeout(650);
  await page.screenshot({ path: "test-results/underbody.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
