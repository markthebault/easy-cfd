import { test, expect } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import type VerticalLoadType from "../src/VerticalLoad";

let VerticalLoad: typeof VerticalLoadType;
test.beforeAll(async () => {
  const server = await createServer({ server: { middlewareMode: true } });
  try {
    VerticalLoad = (await server.ssrLoadModule("/src/VerticalLoad.tsx")).default;
  } finally {
    await server.close();
  }
});

// Synthetic forces test presentation and units, not aerodynamic accuracy.
for (const [force, label, value, description] of [
  [7845.32, "Downforce", "800.0", "Pushes the car onto the road"],
  [-7845.32, "Lift", "800.0", "Lifts the car away from the road"],
  [0, "No net vertical force", "0.0", "No upward or downward load"],
  [-0.01, "Lift", "<0.1", "Lifts the car away from the road"],
] as const) {
  test(`vertical load: ${force} N`, async ({ page }) => {
    await page.setContent(
      renderToStaticMarkup(
        createElement(VerticalLoad, {
          downforce: force,
          speed: 270,
        }),
      ),
    );
    await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
    const card = page.getByRole("article", {
      name: "Vertical aerodynamic load",
    });
    await expect(card.getByText(label, { exact: true })).toBeVisible();
    await expect(card.locator("strong")).toHaveText(`${value} kg`);
    await expect(
      card.getByText(`At 270 km/h · ${Math.abs(force).toFixed(2)} N`),
    ).toBeVisible();
    await expect(card.getByText(description)).toBeVisible();
    await expect(
      card.getByText("Equivalent weight · force in N ÷ 9.80665"),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 700 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(375);
  });
}
