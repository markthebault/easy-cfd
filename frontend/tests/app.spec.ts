import { test, expect } from "@playwright/test";

test("sample, geometry view, saved conditions, and duplicate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByTitle("New sample project").click();
  await expect(
    page.getByRole("heading", { name: "Sample car · baseline", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  await expect(page.locator('[data-testid="vtk-viewer"] canvas')).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Run|Queue) simulation$/ }),
  ).toBeDisabled();
  await page.getByLabel("Road speed", { exact: true }).fill("120");
  await page.getByLabel("I checked size").check();
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Setup saved" })).toBeVisible();
  await page.screenshot({ path: "../docs/interface.png", fullPage: true });
  await page.getByRole("button", { name: "Duplicate design" }).click();
  await expect(
    page.getByRole("heading", { name: "Sample car · baseline · variant" }),
  ).toBeVisible();
  await expect(page.getByLabel("Road speed", { exact: true })).toHaveValue(
    "120",
  );
  await page.getByRole("button", { name: "Add rear wing" }).click();
  await expect(page.getByRole("button", { name: "Remove wing" })).toBeVisible();
  await expect(page.getByLabel("I checked size")).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("real results, slices and flow lines render without browser errors", async ({
  page,
  request,
}) => {
  const runs = await (await request.get("/api/runs")).json();
  const run = runs.find((r: { status: string }) => r.status === "completed");
  test.skip(!run, "Requires the measured sample run from scripts/smoke.py.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Simulation results" }).click();
  await page.getByLabel("Saved run").selectOption(run.id);
  await expect(page.getByText("Pressure · calculated result")).toBeVisible();
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  await expect(
    page.getByText("Could not load visualization data."),
  ).toHaveCount(0);
  await page.getByLabel("View", { exact: true }).selectOption("slice");
  await page.getByLabel("Field", { exact: true }).selectOption("Speed");
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  await page.screenshot({ path: "../docs/results.png", fullPage: true });
  await page.getByLabel("View", { exact: true }).selectOption("streamlines");
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  await page.getByLabel("Field", { exact: true }).selectOption("Turbulence");
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("force history recovers after a failed request", async ({
  page,
  request,
}) => {
  const runs = await (await request.get("/api/runs")).json();
  const run = runs.find((r: { status: string }) => r.status === "completed");
  test.skip(!run, "Requires the measured sample run from scripts/smoke.py.");
  let failures = 0;
  await page.route(`**/api/runs/${run.id}`, (route) =>
    failures++ ? route.continue() : route.abort("connectionreset"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Simulation results" }).click();
  await page.getByLabel("Saved run").selectOption(run.id);
  await expect(
    page.getByText("Could not load force history. Retrying…"),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Drag coefficient convergence history" }),
  ).toBeVisible();
  await expect(page.getByText("Could not load force history")).toHaveCount(0);
  expect(failures).toBeGreaterThan(1);
});

test("run two actual simulations from the UI, compare, reopen, and cancel", async ({
  page,
}) => {
  test.setTimeout(1800000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByTitle("New sample project").click();
  await page.getByRole("button", { name: "fast Explore", exact: true }).click();
  await page.getByLabel("I checked size").check();
  await page.getByRole("button", { name: /^(Run|Queue) simulation$/ }).click();
  await page.waitForFunction(
    () => !!document.querySelector(".run-status.completed, .run-status.failed"),
    {},
    { timeout: 900000 },
  );
  await expect(page.locator(".run-status.completed")).toBeVisible();
  const baseline = await page.getByLabel("Saved run").inputValue();
  await page.getByRole("button", { name: "Duplicate design" }).click();
  await page.getByRole("button", { name: "Add rear wing" }).click();
  await expect(page.getByRole("button", { name: "Remove wing" })).toBeVisible();
  await page.getByLabel("I checked size").check();
  await page.getByRole("button", { name: /^(Run|Queue) simulation$/ }).click();
  await page.waitForFunction(
    () => !!document.querySelector(".run-status.completed, .run-status.failed"),
    {},
    { timeout: 900000 },
  );
  await expect(page.locator(".run-status.completed")).toBeVisible();
  const variant = await page.getByLabel("Saved run").inputValue();
  await page
    .getByRole("button", { name: "Compare designs", exact: true })
    .click();
  await page.getByLabel("Baseline run").selectOption(baseline);
  await page.getByLabel("Variant run").selectOption(variant);
  await expect(page.locator(".compare-viewers canvas")).toHaveCount(2);
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  const viewer = page.locator(".compare-viewers").first();
  const before = await viewer.screenshot();
  const beforeRight = await page
    .locator(".compare-viewers canvas")
    .nth(1)
    .screenshot();
  const bounds = await page
    .locator(".compare-viewers canvas")
    .first()
    .boundingBox();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2 + 80,
    bounds!.y + bounds!.height / 2 + 35,
    { steps: 12 },
  );
  await page.mouse.up();
  expect(before.equals(await viewer.screenshot())).toBe(false);
  expect(
    beforeRight.equals(
      await page.locator(".compare-viewers canvas").nth(1).screenshot(),
    ),
  ).toBe(false);
  await page.screenshot({ path: "../docs/comparison.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Simulation results" }).click();
  await page.getByLabel("Saved run").selectOption(variant);
  await expect(page.locator(".run-status.completed")).toBeVisible();
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await page.getByRole("button", { name: "Model & setup" }).click();
  await page
    .getByRole("button", { name: "medium Compare", exact: true })
    .click();
  await page.getByLabel("I checked size").check();
  await page.getByRole("button", { name: /^(Run|Queue) simulation$/ }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-status.running")).toContainText(
    "Meshing car",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".run-status.cancelled")).toBeVisible();
  expect(errors).toEqual([]);
});

test("import an STL through the UI and review its dimensions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTitle("New sample project").click();
  await page.getByRole("button", { name: "Import STEP / STL" }).click();
  await page
    .getByLabel("Geometry files")
    .setInputFiles("tests/fixtures/box.stl");
  await page.getByRole("button", { name: "Import & check model" }).click();
  await expect(
    page.getByRole("heading", { name: "Import your design" }),
  ).toHaveCount(0);
  await expect(page.locator(".dimensions")).toContainText("4.00");
  await expect(page.locator(".dimensions")).toContainText("2.00");
  await expect(page.getByLabel("I checked size")).not.toBeChecked();
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
});

test("rename persists and completed results export from the UI", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByTitle("New sample project").click();
  await page.getByTitle("Rename design").click();
  await page
    .getByLabel("Design name", { exact: true })
    .fill("Browser verified design");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Browser verified design", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Browser verified design", exact: true }),
  ).toBeVisible();
  const runs = await (await request.get("/api/runs")).json();
  const run = runs.find((r: { status: string }) => r.status === "completed");
  expect(run).toBeTruthy();
  await page.getByRole("button", { name: "Simulation results" }).click();
  await page.getByLabel("Saved run").selectOption(run.id);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export run" }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});

test("Precise result displays its two-mesh sensitivity", async ({
  page,
  request,
}) => {
  test.setTimeout(900000);
  const runs = await (await request.get("/api/runs")).json();
  const run = runs.find(
    (r: { status: string; settings: { quality: string } }) =>
      r.settings.quality === "precise" &&
      ["completed", "running", "queued"].includes(r.status),
  );
  test.skip(
    !run,
    "Requires scripts/benchmark.py --quality precise or a saved Precise run.",
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 850000, intervals: [2000] },
    )
    .toBe("completed");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Simulation results" }).click();
  await page.getByLabel("Saved run").selectOption(run.id);
  await expect(page.getByText(/Mesh sensitivity: ΔCd/)).toBeVisible();
  await expect(page.getByText("Loading geometry…")).toHaveCount(0);
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
  await page.screenshot({ path: "../docs/precise.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("changing a part while geometry loads preserves the initial camera", async ({
  page,
}) => {
  await page.route("**/geometry/*.vtp", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  await page.getByTitle("Highlight part", { exact: true }).first().click();
  await expect(
    page.getByText("Loading geometry…", { exact: true }),
  ).toHaveCount(0);
  const canvas = page.locator('[data-testid="vtk-viewer"] canvas');
  const initial = await canvas.screenshot();
  await page.getByTitle("Reset camera", { exact: true }).click();
  // The view buttons overlay the canvas; clear their hover state.
  await page.mouse.move(0, 0);
  expect(initial.equals(await canvas.screenshot())).toBe(true);
});

test("Blender guide opens from header and import, closes without losing setup", async ({
  page,
}) => {
  await page.goto("/");
  const speed = await page
    .getByLabel("Road speed", { exact: true })
    .inputValue();
  await page
    .getByRole("button", { name: "Blender export guide", exact: true })
    .click();
  const guide = page.getByRole("dialog", { name: "Blender → Easy CFD" });
  await expect(guide).toBeVisible();
  await expect(guide.getByText(/For Blender 5.2.2 LTS/)).toBeVisible();
  await expect(guide.locator(".guide-steps > li")).toHaveCount(6);
  await expect(
    guide.getByRole("heading", { name: "Keep the four wheels separate" }),
  ).toBeVisible();
  await expect(
    guide.getByRole("link", { name: "STL export", exact: true }),
  ).toHaveAttribute("href", /\/5\.2\/files\/import_export\/stl.html$/);
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);
  await expect(page.getByLabel("Road speed", { exact: true })).toHaveValue(
    speed,
  );
  await page
    .getByRole("button", { name: "Import STEP / STL", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Preparing a model in Blender/ })
    .click();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "Close Blender guide" }).click();
  await expect(
    page.getByRole("heading", { name: "Import your design" }),
  ).toBeVisible();
});

test("Blender guide fits a phone viewport and traps keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Blender export guide", exact: true })
    .click();
  const guide = page.getByRole("dialog", { name: "Blender → Easy CFD" });
  await expect(guide).toBeVisible();
  expect(await guide.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press("Shift+Tab");
  expect(
    await guide.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.screenshot({
    path: "../docs/blender-guide-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);
});

test("re-orient an import, add a part, and switch it off", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New sample project").click();
  await page.getByRole("button", { name: "Import STEP / STL" }).click();
  await page
    .getByLabel("Geometry files")
    .setInputFiles("tests/fixtures/box.stl");
  await page.getByRole("button", { name: "Import & check model" }).click();
  await expect(page.locator(".dimensions")).toContainText("4.00");

  // Rebuilt from the stored original: length and width swap, and a hint appears.
  await page.getByRole("button", { name: "Turn 90°" }).click();
  await expect(page.locator(".dimensions span").first()).toContainText("2.00");
  await expect(page.locator(".geometry-hint")).toContainText(
    "wider than it is long",
  );
  await page
    .locator(".geometry-hint")
    .getByRole("button", { name: "Turn 90°" })
    .click();
  await expect(page.locator(".dimensions span").first()).toContainText("4.00");
  await expect(page.locator(".geometry-hint")).toHaveCount(0);

  await page.getByRole("button", { name: /Add parts/ }).click();
  await page
    .getByLabel("Geometry files")
    .setInputFiles("tests/fixtures/wing.stl");
  await page.getByRole("button", { name: "Add & check parts" }).click();
  await expect(page.locator(".part-group")).toHaveCount(2);
  await expect(page.locator(".part-group").nth(1)).toContainText("Added");
  // Placed where it was exported, above the roof, not dropped onto the road.
  const height = page.locator(".dimensions span").nth(2);
  await expect(height).toContainText("1.3");

  // Switched off: out of the simulated assembly and its dimensions.
  // Controlled by the saved project, so the box changes once the server replies.
  await page.getByLabel("wing.stl enabled").click();
  await expect(page.getByLabel("wing.stl enabled")).not.toBeChecked();
  await expect(height).toContainText("1.00");
  await expect(page.getByLabel("I checked size")).not.toBeChecked();

  for (const view of ["Front", "Side", "Top"])
    await page.getByRole("button", { name: view, exact: true }).click();
  await page.getByTitle("Reset camera").click();
  await expect(page.locator(".viewport-message.error")).toHaveCount(0);
});

test("wheel radius follows the selected design", async ({ page }) => {
  await page.goto("/");
  // Two samples share identical geometry, so only the design tells their rows apart.
  await page.getByTitle("New sample project").click();
  await expect(page.locator(".project-item.selected")).toHaveCount(1);
  const first = await page.locator(".project-item").count();
  await page.getByTitle("New sample project").click();
  await expect(page.locator(".project-item")).toHaveCount(first + 1);
  const radius = page.getByLabel("Front left wheel radius");
  await expect(radius).toHaveValue("0.32");
  await radius.fill("0.48");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && /\/parts\/part\d+$/.test(r.url()),
  );
  await radius.blur();
  await saved;
  // Newest first: the edited design, then the untouched one.
  await page.locator(".project-item").nth(1).click();
  await expect(radius).toHaveValue("0.32");
  await page.locator(".project-item").first().click();
  await expect(radius).toHaveValue("0.48");
});
