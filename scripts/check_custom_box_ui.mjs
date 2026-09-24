import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGE ERROR", e.message);
});
const base = "http://127.0.0.1:8000";
try {
  const r = await page.request.post(base + "/api/projects", {
    data: { name: "Custom box · 125 iteration check", sample: true },
  });
  assert.ok(r.ok());
  const project = await r.json();
  await page.goto(base);
  await page
    .getByRole("heading", { name: project.name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: /02.*Driving conditions/ }).click();
  await page.getByLabel("Simulation box size").selectOption("custom");
  for (const [label, value] of [
    ["Inlet X", "-10"],
    ["Outlet X", "20"],
    ["Side Y minimum", "-5"],
    ["Side Y maximum", "5"],
    ["Top Z", "6"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="simulation-box"]')
        ?.getAttribute("data-bounds") === "-10,20,-5,5,0,6",
  );
  await page.getByRole("button", { name: "Fit box", exact: true }).click();
  await page
    .getByRole("button", { name: "custom Configure", exact: true })
    .click();
  await page.getByLabel("Custom mesh resolution").selectOption("fast");
  await page.getByLabel("Custom iteration limit").fill("125");
  await page.getByLabel("I checked size").check();
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await page
    .getByRole("button", { name: "Setup saved", exact: false })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="simulation-box"]')
        ?.getAttribute("data-bounds") === "-10,20,-5,5,0,6",
  );
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .waitFor();
  await page.screenshot({ path: "docs/custom-box/setup.png", fullPage: true });
  const saved = await (
    await page.request.get(base + "/api/projects/" + project.id)
  ).json();
  assert.equal(saved.settings.custom_iterations, 125);
  assert.equal(saved.settings.custom_mesh, "fast");
  const event = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Run simulation$/ }).click();
  const run = await (await event).json();
  writeFileSync("docs/custom-box/run-id.txt", run.id);
  console.log("Submitted", run.id);
  await page.waitForFunction(
    () => !!document.querySelector(".run-status.completed, .run-status.failed"),
    {},
    { timeout: 60000 },
  );
  console.log("Result displayed");
  const result = await (
    await page.request.get(base + "/api/runs/" + run.id)
  ).json();
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.iteration, 125);
  assert.equal(result.result.iteration, 125);
  assert.deepEqual(result.domain, [-10, 20, -5, 5, 0, 6]);
  assert.equal(result.result.refinement, undefined);
  await page.getByLabel("Show saved simulation box").check();
  await page.getByRole("button", { name: "Fit box", exact: true }).click();
  await page
    .getByText("Loading geometry…", { exact: true })
    .waitFor({ state: "hidden" });
  await page.screenshot({ path: "docs/custom-box/result.png", fullPage: true });
  // Change the design settings and prove that the saved run's box is immutable.
  await page
    .getByRole("button", { name: "Model & setup", exact: true })
    .click();
  await page.getByLabel("Outlet X", { exact: true }).fill("21");
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await page
    .getByRole("button", { name: "Setup saved", exact: false })
    .waitFor();
  const untouched = await (
    await page.request.get(base + "/api/runs/" + run.id)
  ).json();
  assert.equal(untouched.domain[1], 20);
  await page.getByLabel("Top Z", { exact: true }).fill("0.5");
  await page.getByRole("alert").filter({ hasText: "surround" }).waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Run simulation", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("Simulation box size").selectOption("automatic");
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await page
    .getByRole("button", { name: "Setup saved", exact: false })
    .waitFor();
  assert.deepEqual(errors, []);
  writeFileSync(
    "docs/custom-box/browser-checks.json",
    JSON.stringify(
      {
        run_id: run.id,
        project_id: project.id,
        domain: result.domain,
        iterations: result.iteration,
        cells: result.result.cells,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Custom box UI and solver passed", run.id);
} catch (e) {
  console.log("BODY", (await page.locator("body").innerText()).slice(-5000));
  await page.screenshot({
    path: "docs/custom-box/failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
