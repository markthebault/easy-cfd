import { expect, test, type Route } from "@playwright/test";

// The OpenFOAM engine against a mocked server (the real one needs Docker and minutes per run; it
// is exercised by hand, see SPEC.md). Checks the UI flow and the frame offset sent to the server.

const P = "p".repeat(32);
const R = "a".repeat(32);
const OFFSET_X = 0.05; // the mocked server recentres the car 5 cm further aft

const preset = (max_cells: number, iterations: number, layers: number, label: string) => ({ cell: 0.5, surface: 3, wake: 2, layers, max_cells, iterations, residual: 1e-4, label, memory_gb: 5 });
const health = { ready: true, message: "Solver ready", cpus: 8, memory_gb: 8, presets: { fast: preset(350000, 300, 0, "Exploratory"), medium: preset(1400000, 1000, 6, "Design comparison"), precise: preset(2400000, 1800, 8, "Refinement check") } };

// Sample car: body, then four wheels; the body's lowest corner in the UI frame.
const bodyLow = [-2.1, -0.81, 0.32];
const serverParts = ["Body", "Front right wheel", "Front left wheel", "Rear right wheel", "Rear left wheel"].map((name, i) => ({
  id: `part${i}`, name: `${String(i).padStart(2, "0")}-${name.replace(/ /g, "_")} 1`, role: "body", enabled: true, source: i,
  bounds: i === 0 ? [[bodyLow[0] + OFFSET_X, bodyLow[1], bodyLow[2]], [2.15, 0.81, 1.32]] : [[0, 0, 0.01], [0.6, 0.3, 0.65]],
}));

const record = (status: string) => ({
  id: R, project_id: P, name: "Sample car · from EasyCFD Web", created: "2026-09-29T10:00:00Z", status, stage: status === "completed" ? "Complete" : "fast: Solving airflow",
  iteration: 300, started: "2026-09-29T10:00:00Z", finished: "2026-09-29T10:02:00Z",
  settings: { speed_kmh: 100, yaw_deg: 0, quality: "fast", reference_area: 2.2, density: 1.225, moving_ground: true, wheels: true },
  domain: [-12.6 + OFFSET_X, 27.3 + OFFSET_X, -9.57, 9.57, 0, 9.72],
  geometry: { parts: serverParts },
  result: status !== "completed" ? undefined : {
    cd: 0.5169, cl: 0.6064, drag: 537, downforce: -630, force_settled: true, cd_span: 0.002, cl_span: 0.004, averaging_iterations: 50,
    history: Array.from({ length: 300 }, (_, i) => ({ iteration: i + 1, cd: 0.52 + 0.3 * Math.exp(-i / 30), cl: 0.6 })),
    breakdown: { body: { pressure_drag: 319, viscous_drag: 9, pressure_downforce: -400, viscous_downforce: 0 }, wheels: { pressure_drag: 207, viscous_drag: 2, pressure_downforce: -230, viscous_downforce: 0 } },
    blockage_ratio: 0.011, cells: 340000, iteration: 300, warnings: ["This run uses a coarse mesh without prism layers."], residuals: { p: 1e-3 }, residual_converged: false,
  },
});

for (const moving_ground of [false, true]) for (const wheels of [false, true]) test(`OpenFOAM motion: road ${moving_ground}, wheels ${wheels}, run and reopen result`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let polls = 0;
  let fieldRequest: { origin: number[]; spacing: number[]; dims: number[] } | null = null;
  let settingsRequest: Record<string, unknown> | null = null;
  const runRecord = (status: string) => ({ ...record(status), settings: { ...record(status).settings, moving_ground, wheels } });
  const boundaries = `Road ${moving_ground ? "moving" : "fixed"} · Wheels ${wheels ? "rotating" : "fixed"}`;
  const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    if (path === "/health") return json(route, health);
    if (path === "/runs" && method === "GET") return json(route, polls > 3 ? [runRecord("completed")] : []);
    if (path === "/projects" && method === "POST") return json(route, { id: P });
    if (path === `/projects/${P}/import`) return json(route, { id: P, geometry: { parts: serverParts, errors: [] } });
    if (path === `/projects/${P}`) return json(route, { id: P, geometry: { parts: serverParts } });
    if (path === `/projects/${P}/settings` && method === "PUT") {
      settingsRequest = route.request().postDataJSON();
      return json(route, {});
    }
    if (path.startsWith(`/projects/${P}/`) && method === "PUT") return json(route, {});
    if (path === `/projects/${P}/runs`) {
      expect(settingsRequest).toMatchObject({ moving_ground, wheels });
      return json(route, runRecord("queued"));
    }
    if (path === `/runs/${R}/live`) {
      polls++;
      const done = polls > 3;
      return json(route, { status: done ? "completed" : "running", stage: done ? "Complete" : "fast: Solving airflow", iteration: done ? 300 : 120, history: [{ iteration: 1, cd: 0.9, cl: 0.4 }, { iteration: 120, cd: 0.55, cl: 0.6 }] });
    }
    if (path === `/runs/${R}`) return json(route, runRecord("completed"));
    if (path === `/runs/${R}/viz-field`) {
      fieldRequest = JSON.parse(route.request().postData() ?? "{}");
      const [nx, ny, nz] = fieldRequest!.dims;
      const n = nx * ny * nz;
      const buf = Buffer.alloc(21 * n);
      for (let i = 0; i < n; i++) buf.writeFloatLE(27.78, 4 * i);
      buf.fill(1, 20 * n);
      return route.fulfill({ contentType: "application/octet-stream", body: buf });
    }
    if (path === `/runs/${R}/surface-samples`) {
      const nv = (route.request().postDataBuffer()?.length ?? 0) / 12;
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.alloc(16 * nv) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: `unmocked ${method} ${path}` }) });
  });

  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page.getByRole("checkbox", { name: "Moving road", exact: true }).setChecked(moving_ground);
  await page.getByRole("checkbox", { name: "Rotating wheels", exact: true }).setChecked(wheels);
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__easycfd.app.get();
    return s.designs.find((d: any) => d.id === s.design.id)?.settings;
  })).toMatchObject({ moving_ground, wheels });
  await page.reload();
  await expect(page.getByText("536 triangles", { exact: true })).toBeVisible();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await expect(page.getByRole("checkbox", { name: "Moving road", exact: true })).toBeChecked({ checked: moving_ground });
  await expect(page.getByRole("checkbox", { name: "Rotating wheels", exact: true })).toBeChecked({ checked: wheels });
  await page.getByRole("button", { name: "Continue to run" }).click();
  await expect(page.getByTestId("run-boundaries")).toHaveText(boundaries);
  await expect(page.getByTestId("engine-openfoam")).toBeEnabled();
  await page.getByTestId("engine-openfoam").click();
  await expect(page.getByLabel("Analysis level")).toHaveValue("advanced1");
  await expect(page.locator("#elapsed-limit")).toHaveValue("10800");
  await page.getByLabel("Analysis level").selectOption("advanced2");
  await expect(page.locator("#elapsed-limit")).toHaveValue("43200");
  await page.getByLabel("Analysis level").selectOption("legacy");
  await page.getByRole("radio", { name: /^Fast/ }).click();
  await expect(page.getByTestId("run")).toHaveText(/Run on OpenFOAM/);
  await page.getByTestId("run").click();

  await expect(page.locator(".live-head h2")).toHaveText(/Solving airflow \(fast\)/, { timeout: 20_000 });
  await expect(page.locator(".live-stats")).toContainText("120");
  await expect(page.getByTestId("run-boundaries")).toHaveText(boundaries);
  await expect(page.getByTestId("card-cd")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("card-cd").locator(".card-value")).toHaveText("0.5169");
  await expect(page.getByTestId("result-engine")).toHaveText("OpenFOAM");
  await expect(page.getByTestId("run-boundaries")).toHaveText(boundaries);
  expect(settingsRequest).toMatchObject({ moving_ground, wheels });
  await expect(page.locator(".chart-legend")).toContainText("x: iterations");

  // The flow grid was requested in the server's frame: the UI's window shifted by the offset.
  expect(fieldRequest).not.toBeNull();
  const uiX0 = Math.max(-12.6, bodyLow[0] - 0.6 * 4.2);
  expect(Math.abs(fieldRequest!.origin[0] - (uiX0 + OFFSET_X))).toBeLessThan(1e-6);

  // The saved run is listed with its engine; the server tab marks it as already here.
  await page.getByRole("button", { name: "Designs & runs" }).click();
  await expect(page.getByTestId("run-item").first()).toContainText("OpenFOAM");
  await page.getByTestId("tab-server").click();
  await expect(page.getByTestId("server-run").first()).toContainText("already in this browser");
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("run-boundaries")).toHaveText(boundaries);
  expect(errors).toEqual([]);
});

test("without an OpenFOAM server the engine choice explains how to get one", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page.getByRole("button", { name: "Continue to run" }).click();
  await expect(page.getByTestId("engine-openfoam")).toBeDisabled();
  await expect(page.getByTestId("openfoam-availability")).toContainText("just run-openfoam");
  await expect(page.getByTestId("run")).toHaveText(/Run simulation/);
});
