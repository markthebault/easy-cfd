import { expect, test } from "@playwright/test";
test.setTimeout(60_000);

test("ground placement, lift and custom height persist while preserving the assembled car", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByRole("button", { name: "Place wheels on ground" })).toBeEnabled();
  await page.getByRole("button", { name: "Pause animation" }).click();
  const geometry = () => page.evaluate(() => {
    const s = (window as any).__easycfd.app.get();
    return { busy: s.busy, confirmed: s.confirmed, options: s.design.importOptions,
      errors: s.report.errors, parts: s.parts.map((p: any) => ({ role: p.role, positions: Array.from(p.positions), center: p.wheel?.center })) };
  });
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  const original = await geometry();
  await page.getByRole("button", { name: "Place wheels on ground" }).click();
  await expect(page.getByLabel("Height above road")).toHaveValue("5");
  const grounded = await geometry();
  expect(grounded.confirmed).toBe(false);
  expect(grounded.errors).toEqual([]);
  await expect(page.locator(".issue.error")).toHaveCount(0);
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await expect(page.getByRole("button", { name: "Continue to conditions" })).toBeEnabled();
  for (let p = 0; p < original.parts.length; p++) for (let i = 0; i < original.parts[p].positions.length; i++) {
    expect(grounded.parts[p].positions[i]).toBeCloseTo(original.parts[p].positions[i] - (i % 3 === 2 ? 0.005 : 0), 6);
  }
  expect(Math.min(...grounded.parts.filter((p: any) => p.role === "wheel").flatMap((p: any) => p.positions.filter((_: number, i: number) => i % 3 === 2)))).toBeCloseTo(0.005, 7);
  // Exact contact remains an intentional preview state with an inline, actionable note.
  await page.getByLabel("Height above road").fill("0");
  await page.getByLabel("Height above road").press("Enter");
  await expect.poll(async () => (await geometry()).busy).toBeNull();
  await expect(page.locator(".issue.error")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Ground contact is set");
  await expect(page.getByRole("button", { name: "Continue to conditions" })).toBeDisabled();
  await page.getByRole("button", { name: "Place wheels on ground" }).click();
  await expect(page.getByLabel("Height above road")).toHaveValue("5");
  expect((await geometry()).errors).toEqual([]);
  await page.getByRole("button", { name: "Lift car", exact: true }).click();
  await expect(page.getByLabel("Height above road")).toHaveValue("150");
  const custom = page.getByLabel("Height above road");
  await custom.fill("300");
  await custom.press("Enter");
  await expect.poll(async () => (await geometry()).busy).toBeNull();
  expect((await geometry()).errors).toEqual([]);
  await page.waitForTimeout(550);
  await page.reload();
  await expect(page.getByLabel("Height above road")).toHaveValue("300");
  await page.getByRole("button", { name: "Simulation gap" }).click();
  await expect(page.getByLabel("Height above road")).toHaveValue("5");
  expect((await geometry()).errors).toEqual([]);
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await expect(page.getByRole("button", { name: "Continue to conditions" })).toBeEnabled();
  // Keep the corrected ground placement and its controls visible together.
  await page.getByRole("button", { name: "Side", exact: true }).click();
  await page.locator(".road-position").scrollIntoViewIfNeeded();
  await page.waitForTimeout(650);
  await page.screenshot({ path: "test-results/ground-placement.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".road-position").scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Place wheels on ground" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
