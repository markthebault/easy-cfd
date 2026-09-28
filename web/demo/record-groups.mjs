// Records the part-groups walkthrough with real runs on the Fast preset.
// Needs the dev server (npx vite --host 127.0.0.1 --port 5173). Output: /tmp/groups-video/*.webm
// plus segments.json (solver waits, sped up afterwards by demo/edit-video.sh).
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const d = "demo/groups/";
const outDir = "/tmp/groups-video";
mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", recordVideo: { dir: outDir, size: { width: 1440, height: 900 } } });
const t0 = Date.now();
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const waits = [];
const now = () => (Date.now() - t0) / 1000;
const pause = (ms) => p.waitForTimeout(ms);

// Caption overlay for the viewer (injected into the page; not part of the app).
async function caption(text) {
  await p.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText =
        "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:12px;background:rgba(10,14,22,.88);color:#fff;font:600 17px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.15);max-width:900px;text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

const group = (name) => p.getByTestId(`group-${name}`);
const cont = p.getByRole("button", { name: "Continue to conditions" });

async function confirmAndRun(label) {
  for (let i = 0; i < 10 && !(await cont.isEnabled()); i++) {
    await p.getByText("I checked size, orientation, wheels and clearance.").click();
    await pause(600);
  }
  await cont.click();
  await pause(900);
  await p.getByRole("button", { name: "Continue to run" }).click();
  await pause(900);
  await p.getByRole("radio", { name: /Fast/ }).click();
  await pause(700);
  await caption(label);
  await p.getByTestId("run").click();
  await pause(8000);
  const s = now();
  await p.getByTestId("card-cd").waitFor({ timeout: 400000 });
  waits.push([s, now()]);
  await pause(3500);
}

async function backToCar() {
  await p.getByRole("button", { name: /Change the setup and run again/ }).click();
  await pause(1200);
  await p.getByTestId("step-car").click();
  await pause(1500);
  await p.locator(".group-list").scrollIntoViewIfNeeded();
  await pause(800);
}

await p.goto("http://127.0.0.1:5173/");
await caption("EasyCFD Web: part groups. Import once, switch groups on and off, compare runs.");
await pause(3500);
await caption("Import the car: body and wheels are grouped automatically");
await p.locator('input[type="file"]').first().setInputFiles(["body.stl", "wheel_front_left.stl", "wheel_front_right.stl", "wheel_rear_left.stl", "wheel_rear_right.stl"].map((f) => d + f));
await p.getByLabel("Road clearance").waitFor();
await pause(3000);
await caption("Add parts: three rear-wing versions, each file becomes its own group");
await p.locator('input[type="file"]').first().setInputFiles(["rear_wing_A_12deg.stl", "rear_wing_B_flat_high.stl", "rear_wing_C_20deg_long.stl"].map((f) => d + f));
await pause(2500);
await p.locator(".group-list").scrollIntoViewIfNeeded();
await pause(2500);
await caption("Rename groups by clicking their name");
for (const [from, to] of [["rear_wing_A_12deg", "Wing A · 12°"], ["rear_wing_B_flat_high", "Wing B · flat, high"], ["rear_wing_C_20deg_long", "Wing C · 20°, long"]]) {
  await group(from).locator(".group-name").click();
  await pause(400);
  const input = p.locator(".group-name-input");
  await input.fill("");
  await input.type(to, { delay: 45 });
  await input.press("Enter");
  await pause(900);
}
await pause(1200);

await caption("Run 1 · baseline: switch the three wing groups off");
for (const g of ["Wing A · 12°", "Wing B · flat, high", "Wing C · 20°, long"]) {
  await group(g).locator("label.toggle").click();
  await pause(900);
}
await pause(1500);
await confirmAndRun("Run 1 · baseline without a wing (Fast preset, solved on this GPU)");
await caption("The groups that were simulated are recorded with each run");
await pause(4000);

await caption("Run 2 · 'Only this' switches Wing A on and the other wings off");
await backToCar();
await group("Wing A · 12°").getByRole("button", { name: "Only this" }).click();
await pause(2200);
await confirmAndRun("Run 2 · Wing A only");
await pause(1500);

await caption("Run 3 · Wing C only");
await backToCar();
await group("Wing C · 20°, long").getByRole("button", { name: "Only this" }).click();
await pause(2200);
await confirmAndRun("Run 3 · Wing C only");
await pause(1500);

await caption("Compare Wing C with Wing A: the group difference is named, forces side by side");
let sel = p.getByLabel("Run to compare with");
let opts = await sel.locator("option").allTextContents();
console.log("compare options", JSON.stringify(opts));
await p.screenshot({ path: `${outDir}/before-compare.png` });
await sel.selectOption({ index: opts.findIndex((o) => o.includes("Wing A")) });
await pause(1200);
await p.getByRole("button", { name: "Compare", exact: true }).click();
await pause(10000);

await caption("Compare Wing C with the baseline");
await p.getByRole("button", { name: /close comparison|close/i }).first().click().catch(() => {});
await pause(1500);
sel = p.getByLabel("Run to compare with");
if (await sel.count()) {
  opts = await sel.locator("option").allTextContents();
  await sel.selectOption({ index: opts.findIndex((o) => o.includes("no optional groups")) });
  await pause(1000);
  await p.getByRole("button", { name: "Compare", exact: true }).click();
  await pause(9000);
}
await caption("Import every variant once, then run and compare them in a few clicks");
await pause(3500);
writeFileSync(`${outDir}/segments.json`, JSON.stringify({ waits, total: now(), errors }));
await ctx.close();
await b.close();
console.log(JSON.stringify({ waits, total: now(), errors }));
