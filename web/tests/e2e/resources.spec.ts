import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("M1 preparation/solver cancellation and UI response under a real GPU workload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByText("536 triangles")).toBeVisible();
  await page
    .getByText("I checked size, orientation, wheels and clearance.")
    .click();
  await page.getByRole("button", { name: "Continue to conditions" }).click();
  await page.getByRole("button", { name: "Continue to run" }).click();
  const stopTimes = [];
  for (const phase of ["preparing", "solving"]) {
    await page.getByTestId("run").click();
    if (phase === "solving")
      await page.waitForFunction(
        () => (window as any).__easycfd.app.get().live?.stage === "solving",
        null,
        { timeout: 30000 },
      );
    const frameTimes =
      phase === "solving"
        ? await page.evaluate(async () => {
            const samples = [];
            for (let i = 0; i < 12; i++) {
              const start = performance.now();
              const button = Array.from(
                document.querySelectorAll("button"),
              ).find((b) => b.textContent === "Side")!;
              button.click();
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              samples.push(performance.now() - start);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return samples;
          })
        : [];
    const t = Date.now();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("run")).toBeVisible({ timeout: 5000 });
    const elapsed = Date.now() - t;
    expect(elapsed).toBeLessThan(5000);
    expect(
      await page.evaluate(() => (window as any).__easycfd.app.get().live),
    ).toBe(null);
    stopTimes.push({
      phase,
      stopMilliseconds: elapsed,
      inputToFrameMilliseconds: frameTimes,
    });
  }
  await writeFile(
    "test-results/aero-responsiveness.json",
    JSON.stringify(
      {
        scope:
          "Browser input to next animation frame; does not measure other applications",
        measurements: stopTimes,
      },
      null,
      2,
    ),
  );
});
