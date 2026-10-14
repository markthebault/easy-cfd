import { expect, test } from "@playwright/test";

test("the static edition offers remote connection and makes no automatic backend requests", async ({ page }) => {
  test.setTimeout(30_000);
  test.skip(process.env.VITE_ENABLE_OPENFOAM !== "false", "Requires the static build flag.");
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page.getByRole("button", { name: "Continue to run" }).click();
  await expect(page.getByTestId("engine-openfoam")).toBeDisabled();
  await expect(page.getByTestId("openfoam-availability")).toHaveText("Connect a remote OpenFOAM server below to enable this engine.");
  await expect(page.getByText("OpenFOAM server connection", {exact:true})).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Solver engine" })).toHaveCount(1);
  await expect(page.locator("#advanced-profile")).toHaveCount(0);

  // A local-server design saved earlier must reopen with runnable browser OpenFOAM settings.
  await page.evaluate(async () => {
    const app = (window as any).__easycfd.app;
    const design = structuredClone(app.get().design);
    design.settings = { ...design.settings, engine: "openfoam", profile: "advanced2", max_seconds: 43200, flow_detail: "fine" };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("easycfd-web");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("designs", "readwrite");
      tx.objectStore("designs").put(design);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem("easycfd.lastDesign", design.id);
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__easycfd.app.get().design?.settings.engine)).toBe("wasm");
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.flow_detail)).toBe("standard");
  await page.getByRole("button", { name: "Designs & runs" }).click();
  await expect(page.getByTestId("tab-server")).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});


test("unsupported saved results are excluded without deleting their design or stored data", async ({page}) => {
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  const counts = await page.evaluate(async () => {
    const {put, getAll} = await import("/src/store/db.ts" as string);
    const {app, refreshLists} = await import("/src/store/app.ts" as string);
    const design = app.get().design;
    await put("runs", {id:"unsupported-result",designId:design.id,designName:design.name,createdAt:Date.now(),
      settings:design.settings,source:design.source,result:{engine:"retired"}});
    await refreshLists();
    return {visible:app.get().runs.length,stored:(await getAll("runs")).length,design:app.get().design.id};
  });
  expect(counts.visible).toBe(0);
  expect(counts.stored).toBe(1);
  expect(counts.design).toBeTruthy();
  await page.evaluate(async () => {
    const {openRun} = await import("/src/store/runs.ts" as string);
    await openRun("unsupported-result");
  });
  await expect(page.getByText("This result uses a retired solver. Open its design and run it again with OpenFOAM.", {exact:true})).toBeVisible();
});
