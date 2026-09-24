import { test, expect } from "@playwright/test";

test("selected caps preview, reset, apply and export with the real API", async ({
  page,
  request,
}) => {
  // Remove one triangle from the closed fixture.
  const fs = await import("node:fs/promises");
  const fixture = await fs.readFile("tests/fixtures/box.stl");
  const data = Buffer.from(fixture);
  const count = data.readUInt32LE(80);
  const cut = Buffer.concat([data.subarray(0, 84), data.subarray(84 + 50)]);
  cut.writeUInt32LE(count - 1, 80);
  const p = await (
    await request.post("/api/projects", {
      data: { sample: false, name: "Repair browser test" },
    })
  ).json();
  const imported = await request.post(`/api/projects/${p.id}/import`, {
    multipart: {
      files: {
        name: "open.stl",
        mimeType: "application/octet-stream",
        buffer: cut,
      },
    },
  });
  expect(imported.ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Inspect & repair openings" }).click();
  const dialog = page.getByRole("dialog", { name: "Repair openings" });
  await expect(dialog.getByText("1 opening found")).toBeVisible();
  const checkbox = dialog.getByRole("checkbox").first();
  await checkbox.check();
  await dialog
    .getByRole("button", { name: "Preview 1 cap", exact: true })
    .click();
  await expect(dialog.getByText("0 openings remaining")).toBeVisible();
  await expect(
    dialog.getByText("1 triangle added · 0 vertices moved"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Reset selection" }).click();
  await expect(checkbox).not.toBeChecked();
  await expect(dialog.getByText("1 opening found")).toBeVisible();
  await checkbox.check();
  await dialog
    .getByRole("button", { name: "Preview 1 cap", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Apply repairs" }).click();
  await expect(dialog.getByText("Repairs applied")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Download repaired STLs" }),
  ).toBeVisible();
  const after = await (await request.get(`/api/projects/${p.id}`)).json();
  expect(after.geometry.errors).toEqual([]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect & repair openings" }).click();
  await expect(
    dialog.getByRole("link", { name: "Download repaired STLs" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
