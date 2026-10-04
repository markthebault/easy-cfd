import { expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";

/** Exercises saved-run assessment, persistence and exports without changing the CFD snapshot. */
export async function checkTyreLoadAssessment(page: Page, engine: string, recoveredBalance?: {frontLift:number;rearLift:number}) {
  const panel = page.getByTestId("tyre-loads");
  await expect(panel).toBeVisible();
  const original = await page.evaluate(() => {
    const doc = (window as any).__easycfd.app.get().run.doc;
    return {settings: doc.settings, result: doc.result};
  });
  const details = panel.locator("details");
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open)))
    await details.locator("summary").click();
  await panel.getByRole("spinbutton", {name:"Car mass", exact:true}).fill("1300");
  const percent = panel.getByRole("spinbutton", {name:"Front weight", exact:true});
  await percent.fill("");
  await expect(page.getByTestId("tyre-loads-unavailable")).toBeVisible();
  // Completing both inputs must not collapse the editor during typing.
  await percent.pressSequentially("60");
  await expect(percent).toHaveValue("60");
  await expect(page.getByTestId("tyre-load-front")).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const s = (window as any).__easycfd.app.get();
    return s.runs.find((r:any) => r.id === s.run.doc.id)?.tyreLoadAssessment?.inputs.front_weight_percent;
  })).toBe(60);
  const assessed = await page.evaluate(() => (window as any).__easycfd.app.get().run.doc);
  expect(assessed.settings).toEqual(original.settings);
  expect(assessed.result).toEqual(original.result);
  const loads = assessed.tyreLoadAssessment.loads;
  const balance = recoveredBalance ?? original.result.balance;
  expect(loads.front.totalN).toBeCloseTo(1300 * 9.80665 * .6 - balance.frontLift, 3);
  expect(loads.rear.totalN).toBeCloseTo(1300 * 9.80665 * .4 - balance.rearLift, 3);
  await percent.fill("101");
  await expect(panel.getByRole("alert")).toContainText("between 0 and 100");
  await expect(page.getByTestId("tyre-load-front")).toHaveCount(0);
  await percent.fill("60");
  await expect(page.getByTestId("tyre-load-front")).toBeVisible();
  await details.locator("summary").click();
  await panel.scrollIntoViewIfNeeded();
  await mkdir("test-results", {recursive:true});
  await page.screenshot({path:`test-results/tyre-loads-${engine}.png`});
  for (const kind of ["JSON", "CSV"]) {
    const waiting = page.waitForEvent("download");
    await page.getByRole("button", {name:kind, exact:true}).click();
    const download = await waiting;
    const path = `test-results/tyre-loads-${engine}.${kind.toLowerCase()}`;
    await download.saveAs(path);
    const content = await readFile(path, "utf8");
    if (kind === "JSON") {
      const exported = JSON.parse(content);
      expect(exported.tyreLoadAssessment.inputs).toEqual({vehicle_mass_kg:1300, front_weight_percent:60});
      expect(exported.tyreLoadAssessment.loads).toEqual(loads);
      expect(exported.settings).toEqual(original.settings);
      expect(exported.result).toEqual(original.result);
    } else {
      const [header, ...rows] = content.split("\n");
      const keys = header.split(",");
      expect(keys).toContain("front_tyre_total_N");
      for (const row of rows) {
        const fields = Object.fromEntries(row.split(",").map((v,i) => [keys[i], v]));
        if (fields.front_lift_N) expect(Number(fields.front_tyre_total_N)).toBeCloseTo(loads.front.staticN-Number(fields.front_lift_N), 7);
        if (fields.rear_lift_N) expect(Number(fields.rear_tyre_total_N)).toBeCloseTo(loads.rear.staticN-Number(fields.rear_lift_N), 7);
      }
    }
  }
  await page.reload();
  await page.getByTestId("open-library").click();
  await page.getByTestId("run-item").first().click();
  await expect(page.getByTestId("tyre-load-front")).toBeVisible();
  const reopened = await page.evaluate(() => (window as any).__easycfd.app.get().run.doc);
  expect(reopened.tyreLoadAssessment.inputs).toEqual(assessed.tyreLoadAssessment.inputs);
  expect(reopened.tyreLoadAssessment.loads).toEqual(loads);
  expect(reopened.result).toEqual(original.result);
}
