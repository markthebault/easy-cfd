import { expect, test } from "@playwright/test";
test.setTimeout(60_000);

test("driving preview follows road, tyre and wind settings without changing imported coordinates", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByRole("region", { name: "Driving preview" })).toBeVisible();
  const motion = () => page.evaluate(() => {
    const { app, stages } = (window as any).__easycfd;
    const s = stages.main;
    return { road: s.roadDistance, wind: s.windDistance, yaw: s.wind.material.uniforms.uYaw.value, wheels: s.wheelMotion.map((w: any) => ({ distance: w.distance, radius: w.radius, angle: w.mesh.rotation.y })), positions: app.get().parts.map((p: any) => Array.from(p.positions)), windVisible: s.wind.group.visible };
  });
  await expect.poll(async () => (await motion()).wheels.length).toBe(4);
  const smoke = await page.evaluate(() => {
    const s = (window as any).__easycfd.stages.main;
    return { lanes: s.wind.material.uniforms.uPaths.value.image.height, points: s.wind.group.children[0].isPoints,
      label: s.helperGroup.getObjectByName("airLabel") };
  });
  expect(smoke.lanes).toBe(5);
  expect(smoke.points).toBe(true);
  expect(smoke.label).toBeUndefined();
  const originalWheels = await page.evaluate(() => {
    const { app, stages } = (window as any).__easycfd;
    return stages.main.wheelMotion.map((w: any) => {
      const p = app.get().parts.find((p: any) => p.id === w.id);
      w.mesh.updateMatrixWorld(true);
      const pivot = w.center.clone().applyMatrix4(w.mesh.matrixWorld);
      const point = w.center.clone().fromArray(p.positions, 0).applyMatrix4(w.mesh.matrixWorld);
      return { sameSource: w.mesh.geometry.getAttribute("position").array === p.positions,
        vertexCount: w.mesh.geometry.getAttribute("position").count, sourceCount: p.positions.length / 3,
        center: w.center.toArray(), pivot: pivot.toArray(), point: point.toArray(),
        sourcePoint: Array.from(p.positions.slice(0, 3)), angle: w.mesh.rotation.y };
    });
  });
  for (const w of originalWheels) {
    expect(w.sameSource).toBe(true);
    expect(w.vertexCount).toBe(w.sourceCount);
    w.center.forEach((v: number, i: number) => expect(w.pivot[i]).toBeCloseTo(v, 7));
    const [x, y, z] = w.sourcePoint.map((v: number, i: number) => v - w.center[i]);
    const expected = [w.center[0] + x * Math.cos(w.angle) + z * Math.sin(w.angle),
      w.center[1] + y, w.center[2] - x * Math.sin(w.angle) + z * Math.cos(w.angle)];
    expected.forEach((v: number, i: number) => expect(w.point[i]).toBeCloseTo(v, 7));
  }
  const before = await motion();
  expect(before.wheels).toHaveLength(4);
  await page.waitForTimeout(350);
  const moving = await motion();
  expect(moving.road).toBeGreaterThan(before.road);
  expect(moving.wind).toBeGreaterThan(before.wind);
  for (let i = 0; i < 4; i++) {
    const w = moving.wheels[i];
    expect(w.distance).toBeGreaterThan(before.wheels[i].distance);
    expect(w.angle).toBeCloseTo((-w.distance / w.radius) % (Math.PI * 2), 5);
  }
  expect(moving.positions).toEqual(before.positions);
  await page.getByRole("button", { name: "Pause animation" }).click();
  await expect(page.getByRole("button", { name: "Play animation" })).toBeVisible();
  const frozen = await motion();
  await page.waitForTimeout(250);
  expect(await motion()).toEqual(frozen);
  // Surface analyses use the saved geometry pose, then restore original-mesh rotation afterwards.
  await page.evaluate(() => (window as any).__easycfd.app.set({ viz: { ...(window as any).__easycfd.app.get().viz, surfaceFlow: true } }));
  expect((await motion()).wheels.every((w: any) => w.angle === 0)).toBe(true);
  await page.evaluate(() => (window as any).__easycfd.app.set({ viz: { ...(window as any).__easycfd.app.get().viz, surfaceFlow: false } }));
  expect((await motion()).wheels).toEqual(frozen.wheels);
  await page.getByText("I checked size, orientation, wheels and clearance.").click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page.getByRole("slider", { name: "Yaw (crosswind)" }).fill("12");
  expect((await motion()).yaw).toBeCloseTo(12 * Math.PI / 180);
  await expect(page.locator(".driving-heading")).toContainText("+12° crosswind");
  await page.getByRole("checkbox", { name: "Moving road", exact: true }).uncheck();
  await page.getByRole("button", { name: "Play animation" }).click();
  const roadFixed = await motion();
  await page.waitForTimeout(250);
  const wheelsRolling = await motion();
  expect(wheelsRolling.road).toBe(roadFixed.road);
  expect(wheelsRolling.wheels[0].distance).toBeGreaterThan(roadFixed.wheels[0].distance);
  await page.getByRole("checkbox", { name: "Rotating wheels", exact: true }).uncheck();
  const wheelsFixed = await motion();
  await page.waitForTimeout(250);
  const windOnly = await motion();
  expect(windOnly.wheels).toEqual(wheelsFixed.wheels);
  expect(windOnly.wind).toBeGreaterThan(wheelsFixed.wind);
  await expect(page.getByText("Static wind tunnel", { exact: true })).toBeVisible();
  // The opposite mixed state moves only the road.
  await page.getByRole("checkbox", { name: "Moving road", exact: true }).check();
  const roadOnly = await motion();
  await page.waitForTimeout(250);
  const roadRolling = await motion();
  expect(roadRolling.road).toBeGreaterThan(roadOnly.road);
  expect(roadRolling.wheels).toEqual(roadOnly.wheels);
  await page.getByRole("button", { name: "Smoke", exact: true }).click();
  expect((await motion()).windVisible).toBe(false);
  await page.getByRole("button", { name: "Expand view" }).click();
  await expect(page.getByTestId("panel")).not.toBeVisible();
  await page.getByRole("button", { name: "Show setup" }).click();
  await expect(page.getByTestId("panel")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Expand view" }).click();
  await expect(page.getByRole("region", { name: "Driving preview" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/driving-mobile.png" });
  expect(errors).toEqual([]);
});

test("reduced motion starts with the driving preview paused", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByRole("button", { name: "Play animation" })).toBeVisible();
  await expect(page.getByText("Preview paused", { exact: false })).toBeVisible();
});
