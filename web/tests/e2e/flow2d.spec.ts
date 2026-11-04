import { expect, test } from "@playwright/test";

test.use({ colorScheme: "dark" });

test("2D animates locally, pauses, edits, imports and preserves the profile", async ({ page }) => {
  const errors: string[] = [], api: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
  await page.goto("/?workspace=2d&flow-wasm");
  await expect(page.locator(".flow-status")).toContainText("Flow is evolving");
  const canvas = page.locator(".flow-canvas");
  const image = () => canvas.evaluate(c => (c as HTMLCanvasElement).toDataURL());
  const first = await image();
  await expect.poll(image).not.toEqual(first);
  await page.getByRole("button", { name: "Pause simulation", exact: true }).click();
  await expect(page.locator(".flow-status")).toContainText("Paused");
  // Allow an already submitted worker readback to finish, then verify animation freezes.
  await page.waitForTimeout(300);
  const stopped = await image();
  await page.waitForTimeout(200);
  expect(await image()).toBe(stopped);
  await page.getByRole("button", { name: "Pressure", exact: true }).click();
  await expect(page.getByText("Cp −2.5 to +2.5")).toBeVisible();
  await page.getByRole("button", { name: "Edit points", exact: true }).click();
  await expect(page.getByRole("button", { name: "Profile point 1", exact: true })).toBeVisible();
  const before = await page.evaluate(() => localStorage.getItem("easycfd.flow2d.v2"));
  await page.getByRole("button", { name: "Profile point 1", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("easycfd.flow2d.v2"))).not.toEqual(before);
  await page.getByRole("button", { name: "Undo profile change" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("easycfd.flow2d.v2"))).toEqual(before);
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.locator('input[type="file"]').setInputFiles({ name: "my-splitter.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10"><path d="M0 0 L100 0 L100 10 L0 10 Z"/></svg>') });
  await page.getByRole("spinbutton", { name: "SVG profile width in millimetres" }).fill("800");
  await page.getByRole("button", { name: "Import profile", exact: true }).click();
  await expect(page.locator(".flow-dimensions")).toContainText("800");
  await expect(page.locator(".flow-project-name")).toHaveText("my-splitter");
  await expect(page.getByRole("list", { name: "Scene shapes" }).getByRole("button")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".flow-dimensions")).toContainText("800");
  await expect(page.locator(".flow-status")).toContainText("Flow is evolving");
  expect(api).toEqual([]);
  expect(errors).toEqual([]);

  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("menuitemradio", { name: /3D wind tunnel/ }).click();
  await expect(page.getByTestId("flow-workspace")).toHaveCount(0);
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("menuitemradio", { name: /2D profiles/ }).click();
  await expect(page.locator(".flow-project-name")).toHaveText("my-splitter");
});

test("mobile drawing and reduced-motion playback remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/?workspace=2d&tunnel=small&flow-wasm");
  await expect(page.locator(".flow-status")).toContainText("Paused");
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  for (const [x, y] of [[100, 440], [255, 455], [255, 480], [100, 465]]) await page.locator(".flow-edit-overlay").click({ position: { x, y } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".flow-drawing-point")).toHaveCount(3);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".flow-drawing-point")).toHaveCount(2);
  await page.locator(".flow-edit-overlay").click({ position: { x: 255, y: 480 } });
  await page.locator(".flow-edit-overlay").click({ position: { x: 100, y: 440 }, button: "right" });
  await expect(page.locator(".flow-drawing-point")).toHaveCount(2);
  await page.locator(".flow-edit-overlay").click({ position: { x: 100, y: 440 } });
  await page.locator(".flow-edit-overlay").click({ position: { x: 248, y: 455 } });
  await expect(page.locator(".flow-project-name")).toHaveText("Custom profile");
  await expect(page.getByRole("button", { name: "Profile point 1", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const buttons = ["Resume simulation", "Reset flow", "Export profile SVG"];
  for (const name of buttons) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
});

test("multiple shapes move, rotate, duplicate and survive reload", async ({ page }) => {
  await page.goto("/?workspace=2d&profile=car&flow-wasm");
  await expect(page.locator(".flow-status")).toContainText("Flow is evolving");
  const shapes = page.getByRole("list", { name: "Scene shapes" }).getByRole("button");
  await page.getByRole("combobox", { name: "Add shape" }).selectOption("rectangle");
  await expect(shapes).toHaveCount(2);
  const rotation = page.getByRole("spinbutton", { name: "Rotation", exact: true });
  await rotation.fill("15"); await rotation.press("Enter");
  await expect(page.getByRole("spinbutton", { name: "Rotation", exact: true })).toHaveValue("15");
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("easycfd.flow2d.v2")!).shapes[1].points);
  const body = page.getByRole("button", { name: "Select Rectangle", exact: true }), box = await body.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 45, box!.y + box!.height / 2 - 15, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("easycfd.flow2d.v2")!).shapes[1].points)).not.toEqual(before);
  const handle = page.getByRole("button", { name: "Rotate selected shape" }), handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox!.x + handleBox!.width/2, handleBox!.y + handleBox!.height/2); await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width/2 + 20, handleBox!.y + handleBox!.height/2, { steps: 8 }); await page.mouse.up();
  await expect(page.getByRole("spinbutton", { name: "Rotation", exact: true })).not.toHaveValue("15");
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("spinbutton", { name: "Rotation", exact: true })).toHaveValue("15");
  await page.getByRole("button", { name: "Duplicate", exact: true }).click(); await expect(shapes).toHaveCount(3);
  await page.keyboard.press("Control+z"); await expect(shapes).toHaveCount(2);
  await page.reload(); await expect(shapes).toHaveCount(2);
  await expect(page.getByRole("spinbutton", { name: "Rotation", exact: true })).toHaveValue("15");
  await expect(page.locator(".flow-message")).toHaveCount(0);
  await expect(page.getByText("Runs in your browser", { exact: true })).toHaveCount(0);
  await expect(page.locator(".flow-direction")).toHaveCount(0);
});
