import { expect, test } from "@playwright/test";

// Part groups: automatic groups on import, renaming, "Only this", and the groups recorded with a run.
test("part groups: import, rename, solo, run", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dir = "demo/groups/";
  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles(["body.stl", "wheel_front_left.stl", "wheel_front_right.stl", "wheel_rear_left.stl", "wheel_rear_right.stl"].map((f) => dir + f));
  await expect(page.getByLabel("Road clearance")).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(["rear_wing_A_12deg.stl", "rear_wing_B_flat_high.stl"].map((f) => dir + f));
  await expect(page.getByTestId("group-Body")).toBeVisible();
  await expect(page.getByTestId("group-Wheels")).toContainText("4 parts");
  await expect(page.getByTestId("group-rear_wing_A_12deg")).toBeVisible();

  await page.getByTestId("group-rear_wing_B_flat_high").locator(".group-name").click();
  await page.locator(".group-name-input").fill("Wing B");
  await page.locator(".group-name-input").press("Enter");
  await expect(page.getByTestId("group-Wing B")).toBeVisible();

  await page.getByTestId("group-Wing B").getByRole("button", { name: "Only this" }).click();
  await expect(page.getByTestId("group-rear_wing_A_12deg")).toHaveClass(/off/);
  await expect(page.locator(".group-title", { hasText: "Parts and groups" })).toContainText("6 parts simulated");
  await expect(page.getByLabel("Detail cells for group Wing B")).toHaveValue("auto");

  const cont = page.getByRole("button", { name: "Continue to conditions" });
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await cont.click();
  await page.getByRole("button", { name: "Continue to run" }).click();
  await page.getByRole("radio", { name: /Custom/ }).click();
  const sliders = page.locator(".step.open input[type=range]");
  await sliders.nth(0).fill("40");
  await sliders.nth(1).fill("2");
  await sliders.nth(2).fill("2");
  // Both wing versions shape the grid (same cells for every variant), so both get detail cells.
  await expect(page.getByTestId("detail-line")).toContainText("2× finer around 2 parts");
  await page.getByTestId("run").click();
  await expect(page.getByTestId("card-cd")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId("run-groups")).toHaveText("Groups: Wing B");
  const forces = page.getByTestId("group-forces");
  await expect(forces).toContainText("Body");
  await expect(forces).toContainText("Wheels");
  await expect(forces).toContainText("Wing B");
  await expect(forces).not.toContainText("rear_wing_A_12deg");
  expect(errors).toEqual([]);
});
