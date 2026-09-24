import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function manyBoxes() {
  const fixture = await readFile("tests/fixtures/box.stl");
  const count = fixture.readUInt32LE(80);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < count; f++)
    for (let v = 0; v < 3; v++)
      for (let a = 0; a < 3; a++) {
        const value = fixture.readFloatLE(84 + f * 50 + 12 + v * 12 + a * 4);
        min[a] = Math.min(min[a], value);
        max[a] = Math.max(max[a], value);
      }
  const output = Buffer.alloc(84 + count * 110 * 50);
  output.writeUInt32LE(count * 110, 80);
  for (let i = 0; i < 110; i++) {
    fixture.copy(output, 84 + i * count * 50, 84);
    for (let f = 0; f < count; f++)
      for (let v = 0; v < 3; v++)
        for (let a = 0; a < 3; a++) {
          const at = 84 + (i * count + f) * 50 + 12 + v * 12 + a * 4;
          const value = output.readFloatLE(at);
          output.writeFloatLE(
            ((value - (max[a] + min[a]) / 2) / (max[a] - min[a])) *
              [0.095, 0.095, 0.15][a] +
              [Math.floor(i / 10) * 0.1, (i % 10) * 0.1, 0.2][a],
            at,
          );
        }
  }
  return output;
}

test("over-limit STL can be grouped, previewed, compared, sealed and downloaded", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const p = await (
    await request.post("/api/projects", {
      data: { sample: true, name: "Merge browser test" },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Import STEP / STL", exact: true })
    .click();
  await page
    .getByLabel("Geometry files")
    .setInputFiles({
      name: "fragmented-body.stl",
      mimeType: "application/octet-stream",
      buffer: await manyBoxes(),
    });
  await page
    .getByLabel("Lowest point above road · m", { exact: true })
    .fill("0.1");
  await page
    .getByRole("button", { name: "Import & check model", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("100 connected");
  await page.getByLabel("STL components").selectOption("group");
  await page
    .getByRole("button", { name: "Import & check model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Import your design" }),
  ).toHaveCount(0);
  const before = await (await request.get(`/api/projects/${p.id}`)).json();
  expect(before.geometry.parts).toHaveLength(1);
  expect(before.geometry.parts[0].grouped_components).toBe(110);
  await page.getByRole("button", { name: "Merge & seal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Merge and seal" });
  await dialog.getByLabel("Seal resolution").fill("10");
  await dialog.getByLabel("Seal gap target").fill("20");
  await dialog
    .getByRole("button", { name: "Preview merged body", exact: true })
    .click();
  await expect(
    dialog.getByText("110 → 1 solid", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Original", exact: true }).click();
  await expect(
    dialog.getByText("Original components", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Sealed preview", exact: true })
    .click();
  await expect(dialog.locator(".viewport-message.error")).toHaveCount(0);
  const unchanged = await (await request.get(`/api/projects/${p.id}`)).json();
  expect(unchanged.geometry.fingerprint).toBe(before.geometry.fingerprint);
  await dialog.getByRole("button", { name: "Discard preview" }).click();
  await expect(dialog.getByText("110 → 1 solid", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "Preview merged body", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Apply sealed body", exact: true })
    .click();
  await expect(
    dialog.getByText("Sealed body applied", { exact: true }),
  ).toBeVisible();
  const after = await (await request.get(`/api/projects/${p.id}`)).json();
  expect(after.geometry.errors).toEqual([]);
  expect(after.geometry.seal_summary.result_components).toBe(1);
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download sealed STLs" }).click();
  expect((await download).suggestedFilename()).toBe("repaired-model.zip");
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
