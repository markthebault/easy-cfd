import { expect, test } from "@playwright/test";

const health = {ready:true,message:"Solver ready",cpus:4,memory_gb:8,presets:Object.fromEntries(["fast","medium","precise"].map(q=>[q,{cell:.3,surface:.08,layers:2,max_cells:1000000,iterations:400,label:q}]))};
const remote = "https://remote-cfd.example/api";
test.setTimeout(90_000);
async function runStep(page: import("@playwright/test").Page) {
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button",{name:"Continue to conditions"}).click();
  await page.getByRole("button",{name:"Continue to run"}).click();
}

test("a remote server works with native discovery disabled, survives reload and disconnects", async ({page}) => {
  test.skip(process.env.VITE_ENABLE_OPENFOAM !== "false", "Test the static edition.");
  const requests: string[] = [];
  await page.route(`${remote}/**`, async route => {
    const req=route.request();requests.push(req.url());
    expect(req.headers().authorization).toBe("Bearer remote-test-secret");
    expect(new URL(req.url()).searchParams.has("token")).toBe(false);
    await route.fulfill({contentType:"application/json",body:JSON.stringify(req.url().endsWith("/health")?health:[])});
  });
  await page.goto("/");await runStep(page);
  expect(requests).toEqual([]);
  await page.getByText("OpenFOAM server connection",{exact:true}).click();
  await page.getByLabel("Remote backend URL with token").fill("https://remote-cfd.example?token=remote-test-secret");
  await page.getByRole("button",{name:"Connect remote server"}).click();
  await expect(page.getByTestId("engine-openfoam")).toBeEnabled();
  await page.getByTestId("engine-openfoam").click();
  await expect(page.getByTestId("run")).toHaveText(/Run on OpenFOAM/);
  await expect(page.getByLabel("Remote backend URL with token")).toHaveValue("");
  await expect.poll(()=>page.evaluate(()=>{
    const state=(window as any).__easycfd.app.get();
    return state.designs.find((d:any)=>d.id===state.design.id)?.settings.engine;
  })).toBe("openfoam");
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).__easycfd.app.get().server.status)).toBe("ready");
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByTestId("step-run").click();
  await expect(page.getByTestId("engine-openfoam")).toBeChecked();
  await page.getByRole("button",{name:"Designs & runs"}).click();
  await expect(page.getByTestId("tab-server")).toBeVisible();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await page.getByRole("button",{name:"Disconnect",exact:true}).click();
  await expect(page.getByTestId("engine-openfoam")).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.engine)).toBe("wasm");
});

test("Docker startup command can be copied without connecting a backend", async ({page,context}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");await runStep(page);
  await page.getByText("OpenFOAM server connection",{exact:true}).click();
  await expect(page.getByLabel("Docker startup command")).toBeVisible();
  await page.getByTestId("copy-docker-command").click();
  await expect(page.getByTestId("copy-docker-command")).toHaveText("Copied");
  const command=await page.evaluate(()=>navigator.clipboard.readText());
  await expect(page.getByLabel("Docker startup command")).toHaveText(command);
  expect(command).toContain("markthebault/easy-cfd-backend:latest");
  expect(command).toContain('-v "$HOME/easycfd-data:/data"');
  expect(command).not.toContain("docker.sock");
  expect(command).not.toContain("EASYCFD_HOST_DATA");
  expect(command).toContain("docker run -it --rm");
  expect(command).toContain("-p 8000:8000");
  expect(command).not.toContain("127.0.0.1:");
  expect(command).not.toContain("mkdir");
  expect(command).not.toContain("docker pull");
  expect(command).not.toContain("--restart");
  expect(command.split("\n")).toHaveLength(4);
});

test("a rejected remote token is visible and leaves the engine disabled", async ({page}) => {
  await page.route(`${remote}/**`, route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({detail:"Invalid or missing OpenFOAM API token."})}));
  await page.goto("/");await runStep(page);
  await page.getByText("OpenFOAM server connection",{exact:true}).click();
  await page.getByLabel("Remote backend URL with token").fill("https://remote-cfd.example?token=wrong");
  await page.getByRole("button",{name:"Connect remote server"}).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid or missing OpenFOAM API token.");
  await expect(page.getByTestId("engine-openfoam")).toBeDisabled();
});

test("native and remote servers can be selected independently", async ({page}) => {
  test.skip(process.env.VITE_ENABLE_OPENFOAM === "false", "Test native-enabled edition.");
  await page.route("**/api/health", route=>route.fulfill({contentType:"application/json",body:JSON.stringify(health)}));
  await page.route("**/api/runs", route=>route.fulfill({contentType:"application/json",body:"[]"}));
  await page.goto("/");await runStep(page);
  await page.getByText("OpenFOAM server connection",{exact:true}).click();
  await page.getByLabel("Remote backend URL with token").fill("https://remote-cfd.example?token=secret");
  await page.getByRole("button",{name:"Connect remote server"}).click();
  await expect(page.getByTestId("engine-openfoam")).toContainText("On your remote server");
  await page.getByRole("button",{name:"Use native server"}).click();
  await expect(page.getByTestId("engine-openfoam")).toBeEnabled();
  await expect(page.getByTestId("engine-openfoam")).toContainText("On your native server");
});
