import { test, expect } from "@playwright/test";

test("live dimensions, exact target size, rotation, reset and apply", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const p = await (
    await request.post("/api/projects", {
      data: { sample: true, name: "Live dimensions test" },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Rotate & scale", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Rotate and scale" });
  const length = dialog.getByLabel("Length · X", { exact: true });
  await expect(length).toBeEnabled();
  await dialog.getByLabel("Object to transform").selectOption("part0");
  await expect(length).toHaveValue("4.2");
  const canvas = dialog.locator('[data-testid="vtk-viewer"] canvas');
  await expect(dialog.getByText("Loading geometry…")).toHaveCount(0);
  const beforeCanvas = await canvas.screenshot();
  let checks = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/transform/preview")) checks++;
  });
  await length.fill("5");
  await length.blur();
  await expect(length).toHaveValue("5");
  expect(
    Number(await dialog.getByLabel("Width · Y", { exact: true }).inputValue()),
  ).toBeCloseTo((1.62 * 5) / 4.2, 5);
  await expect(dialog.getByLabel("Live object dimensions")).toContainText(
    "5 ×",
  );
  await page.waitForTimeout(150);
  expect((await canvas.screenshot()).equals(beforeCanvas)).toBe(false);
  expect(checks).toBe(0);
  await dialog.getByLabel("Dimension units").selectOption("mm");
  await expect(length).toHaveValue("5000");
  await dialog.getByLabel("Rotate Z", { exact: true }).fill("90");
  await expect(dialog.getByLabel("Width · Y", { exact: true })).toHaveValue(
    "5000",
  );
  await dialog.getByRole("button", { name: "Reset changes" }).click();
  await expect(length).toHaveValue("4200");
  await dialog.getByLabel("Dimension units").selectOption("m");
  // Non-orthogonal rotation exercises bounds measured from vertices rather than box corners.
  await dialog.getByLabel("Rotate Y", { exact: true }).fill("35");
  await dialog.getByLabel("Rotate Z", { exact: true }).fill("25");
  await length.fill("5.123");
  await length.blur();
  const displayed = await Promise.all(
    ["Length · X", "Width · Y", "Height · Z"].map(async (label) =>
      Number(await dialog.getByLabel(label, { exact: true }).inputValue()),
    ),
  );
  const before = await (await request.get(`/api/projects/${p.id}`)).json();
  expect(before.geometry.fingerprint).toBe(p.geometry.fingerprint);
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    dialog.getByText("Changes applied", { exact: true }),
  ).toBeVisible();
  const after = await (await request.get(`/api/projects/${p.id}`)).json();
  const bounds = after.geometry.parts[0].bounds;
  displayed.forEach((v, i) =>
    expect(bounds[1][i] - bounds[0][i]).toBeCloseTo(v, 5),
  );
  expect(after.geometry.parts[1].bounds).toEqual(
    before.geometry.parts[1].bounds,
  );
  expect(after.geometry.transformed).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
