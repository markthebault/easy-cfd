import { expect, test, type Route } from "@playwright/test";

// The OpenFOAM engine against a mocked server (the real one needs Docker and minutes per run; it
// is exercised by hand, see SPEC.md). Checks the UI flow and the frame offset sent to the server.

const P = "p".repeat(32);
const R = "a".repeat(32);
const OFFSET_X = 0.05; // the mocked server recentres the car 5 cm further aft

const preset = (max_cells: number, iterations: number, layers: number, label: string) => ({ cell: 0.5, surface: 3, wake: 2, layers, max_cells, iterations, residual: 1e-4, label, memory_gb: 5 });
const health = { ready: true, message: "Solver ready", cpus: 8, memory_gb: 8, presets: { fast: preset(350000, 300, 0, "Exploratory"), medium: preset(700000, 600, 3, "Design comparison"), precise: preset(2400000, 1800, 8, "Refinement check") } };

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

test("OpenFOAM recording has a visible preset budget and retains a lower custom limit", async ({page}) => {
  await page.route("**/api/health", route=>route.fulfill({contentType:"application/json",body:JSON.stringify(health)}));
  await page.route("**/api/runs", route=>route.fulfill({contentType:"application/json",body:"[]"}));
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", {name:"Continue to conditions"}).click();
  await page.getByRole("button", {name:"Continue to run"}).click();
  await page.getByTestId("engine-openfoam").click();
  await page.getByRole("radio", {name:/^Fast/}).click();
  // A saved Basic server design keeps its explicit five-minute profile budget.
  await page.evaluate(async()=>{const {setSettings}=await import("/src/store/app.ts");setSettings({profile:"basic",quality:"fast",max_seconds:300});});
  const recording=page.getByRole("switch", {name:"Record flow animation"});
  await recording.check();
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.max_seconds)).toBe(600);
  await expect(page.getByText(/Whole-job limit including recording: 10 min/)).toBeVisible();
  await recording.uncheck();
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.max_seconds)).toBe(300);
  await page.evaluate(async()=>{const {setSettings}=await import("/src/store/app.ts");setSettings({max_seconds:120});});
  await recording.check();
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.max_seconds)).toBe(120);
  await expect(page.getByText(/Whole-job limit including recording: 2 min/)).toBeVisible();
});

test("detailed wake selects its dedicated mesh and time budget, and switching engines clears it", async ({page}) => {
  await page.route("**/api/health",route=>route.fulfill({contentType:"application/json",body:JSON.stringify(health)}));
  await page.route("**/api/runs",route=>route.fulfill({contentType:"application/json",body:"[]"}));
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button",{name:"Continue to conditions"}).click();
  await page.getByRole("button",{name:"Continue to run"}).click();
  await page.getByTestId("engine-openfoam").click();
  await page.getByRole("switch",{name:"Record flow animation"}).check();
  await page.getByLabel("Recording detail").selectOption("fine");
  await expect(page.getByText(/Detailed wake mesh/)).toBeVisible();
  await expect(page.getByRole("radiogroup",{name:"Analysis level"}).getByRole("radio")).toHaveCount(4);
  await expect(page.locator("#elapsed-limit")).toHaveValue("43200");
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings)).toMatchObject({engine:"openfoam",quality:"medium",flow_animation:true,flow_detail:"fine",max_seconds:43200});
  await page.getByTestId("engine-webgpu").click();
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.flow_detail)).toBe("standard");
  await expect(page.getByLabel("Recording detail")).toHaveCount(0);
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
  await expect(page.getByRole("radio",{name:/^Medium/})).toHaveAttribute("aria-checked","true");
  await page.getByRole("radio",{name:/^Precise/}).click();
  await expect(page.locator("#elapsed-limit")).toHaveValue("10800");
  await page.getByRole("radio",{name:/^Very Precise/}).click();
  await expect(page.locator("#elapsed-limit")).toHaveValue("43200");
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


test("four compact levels select the right solver budgets and Medium remains bounded with recording",async({page})=>{
  await page.route("**/api/health",r=>r.fulfill({contentType:"application/json",body:JSON.stringify(health)}));
  await page.route("**/api/runs",r=>r.fulfill({contentType:"application/json",body:"[]"}));
  await page.goto("/");await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button",{name:"Continue to conditions"}).click();
  await page.getByRole("button",{name:"Continue to run"}).click();
  await page.getByTestId("engine-openfoam").click();
  const levels=page.getByRole("radiogroup",{name:"Analysis level"});
  await expect(levels.getByRole("radio")).toHaveCount(4);
  await expect(page.locator("#advanced-profile")).toHaveCount(0);
  for(const [name,profile,seconds] of [["Fast","basic",300],["Medium","regular",1200],["Precise","advanced1",10800],["Very Precise","advanced2",43200]] as const){
    const card=levels.getByRole("radio",{name:new RegExp(`^${name} `)});
    await card.click();await expect(card).toHaveAttribute("aria-checked","true");
    expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings)).toMatchObject({profile,max_seconds:seconds});
  }
  await levels.getByRole("radio",{name:/^Medium /}).click();
  await page.getByRole("switch",{name:"Record flow animation"}).check();
  await expect(page.locator("#elapsed-limit")).toHaveValue("1200");
  await page.getByRole("switch",{name:"Record flow animation"}).uncheck();
  await expect(page.locator("#elapsed-limit")).toHaveValue("1200");
  await page.screenshot({path:"test-results/analysis-levels-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"test-results/analysis-levels-mobile.png"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect.poll(()=>page.evaluate(async()=>{
    const {get}=await import("/src/store/db.ts");
    const id=localStorage.getItem("easycfd.lastDesign");
    const saved=id ? await get("designs",id) : undefined;
    return saved?.settings;
  })).toMatchObject({profile:"regular",max_seconds:1200,flow_animation:false});
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.app.get().design?.settings.profile)).toBe("regular");
});


for(const status of ["running","queued"] as const)test(`server ${status} run reopens progress, resumes elapsed time and keeps cancellation attached`,async({page})=>{
  const rec={...record(status),started:status==="running"?new Date(Date.now()-300000).toISOString():undefined,created:new Date(Date.now()-300000).toISOString(),iteration:status==="running"?120:0};
  let polls=0,cancelled=false,queuedJobs=0;
  await page.route("**/api/**",async route=>{
    const u=new URL(route.request().url()),path=u.pathname;
    const json=(body:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/health")return json(health);
    if(path==="/api/runs")return json([rec]);
    if(path===`/api/runs/${R}`)return json({...rec,status:cancelled?"cancelled":status});
    if(path===`/api/runs/${R}/live`){polls++;return json({status:cancelled?"cancelled":status,stage:status==="running"?"fast: Solving airflow":"Queued",iteration:status==="running"?120+polls:0,history:[{iteration:120,cd:.35,cl:.1}]});}
    if(path===`/api/runs/${R}/cancel`){cancelled=true;return json({...rec,status:"cancelled"});}
    if(path.startsWith(`/api/runs/${R}/geometry/`))return route.fulfill({contentType:"model/stl",body:"solid car\nfacet normal 0 0 1\nouter loop\nvertex -2 -1 1\nvertex 2 -1 1\nvertex 2 1 1\nendloop\nendfacet\nendsolid car"});
    if(path.endsWith('/runs')&&route.request().method()==="POST")queuedJobs++;
    return route.fulfill({status:404});
  });
  await page.goto("/");await page.getByTestId("open-library").click();await page.getByTestId("tab-server").click();
  const entry=page.getByTestId("server-run");await expect(entry).toBeEnabled();await expect(entry).toContainText("click to view progress");
  await entry.click();await expect(page.locator('.live')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.app.get().live?.elapsed)).toBeGreaterThanOrEqual(300);
  await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.app.get().live?.parts.length)).toBe(serverParts.length);
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().live.parts.every((p:any)=>p.positions.length===9))).toBe(true);
  await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.stages.main.carGroup.children.length)).toBe(serverParts.length);
  await expect.poll(()=>polls).toBeGreaterThan(0);
  if(status==="running")await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.app.get().live?.iteration)).toBeGreaterThan(120);
  else await expect(page.locator('.live-head h2')).toContainText('Waiting for the solver');
  await page.getByTestId("open-library").click();await page.getByTestId("tab-server").click();await page.getByTestId("server-run").click();
  await expect(page.locator('.live')).toBeVisible();
  await page.screenshot({path:`test-results/server-${status}-reopened.png`});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect.poll(()=>cancelled).toBe(true);await expect(page.locator('.live')).toHaveCount(0);
  expect(queuedJobs).toBe(0);
});


test("switching runs while old geometry downloads preserves the new progress session", async ({page}) => {
  const nextId = "b".repeat(32);
  const next = {...record("running"),id:nextId,name:"Second active car"};
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let geometryStarted = false, oldFieldRequests = 0, cancelledId = "";
  await page.route("**/api/**",async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body:unknown) => route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
    if(path === "/api/health") return json(health);
    if(path === "/api/runs") return json([record("completed"),next]);
    if(path === `/api/runs/${R}`) return json(record("completed"));
    if(path === `/api/runs/${nextId}`) return json(next);
    if(path === `/api/runs/${nextId}/live`) return json({...next,history:[]});
    if(path === `/api/runs/${nextId}/cancel`) { cancelledId=nextId;return json(next); }
    if(path.startsWith(`/api/runs/${R}/geometry/`)) { geometryStarted=true;await blocked; }
    if(path.includes("/geometry/")) return route.fulfill({contentType:"model/stl",body:"solid car\nfacet normal 0 0 1\nouter loop\nvertex -2 -1 1\nvertex 2 -1 1\nvertex 2 1 1\nendloop\nendfacet\nendsolid car"});
    if(path.startsWith(`/api/runs/${R}/`)) oldFieldRequests++;
    return route.fulfill({status:404});
  });
  await page.goto("/");
  await page.evaluate(async id => {const {importServerRun}=await import("/src/store/openfoamRuns.ts");void importServerRun(id);},R);
  await expect.poll(()=>geometryStarted).toBe(true);
  await page.evaluate(async id => {const {importServerRun}=await import("/src/store/openfoamRuns.ts");void importServerRun(id);},nextId);
  await expect(page.locator('.live')).toContainText("Second active car");
  release();
  await page.waitForTimeout(1800);
  await expect(page.locator('.live')).toContainText("Second active car");
  expect(oldFieldRequests).toBe(0);
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect.poll(()=>cancelledId).toBe(nextId);
});
