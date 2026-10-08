import { expect, test } from "@playwright/test";

test("the public edition disables OpenFOAM and makes no backend requests", async ({ page }) => {
  test.setTimeout(30_000);
  test.skip(process.env.VITE_ENABLE_OPENFOAM !== "false", "Requires the WebGPU-only build flag.");
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
  await expect(page.getByTestId("openfoam-availability")).toHaveText("Coming soon: OpenFOAM runs on demand.");
  await expect(page.getByRole("radiogroup", { name: "Solver engine" })).toHaveCount(1);
  await expect(page.locator("#advanced-profile")).toHaveCount(0);

  // A local-server design saved earlier must reopen with runnable WebGPU settings.
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
  await expect.poll(() => page.evaluate(() => (window as any).__easycfd.app.get().design?.settings.engine)).toBe("webgpu");
  expect(await page.evaluate(()=>(window as any).__easycfd.app.get().design.settings.flow_detail)).toBe("standard");
  await page.getByRole("button", { name: "Designs & runs" }).click();
  await expect(page.getByTestId("tab-server")).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});
