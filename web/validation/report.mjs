// Builds the results table for VALIDATION.md from a validation JSON file.
// Usage: node validation/report.mjs validation/results/<file>.json [more files...]
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node validation/report.mjs <results.json> [...]");
  process.exit(1);
}
const models = JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8")).models;

for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  console.log(`\n### ${data.quality} preset · ${basename(file)}\n`);
  console.log("| Model | OpenFOAM Cd (level) | Browser Cd | ΔCd | OpenFOAM Cl | Browser Cl | ΔCl | Cells | Time |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  let inTol = 0, total = 0;
  for (const r of data.results) {
    const m = models.find((x) => x.id === r.id);
    const ref = m.references.find((x) => x.quality === "medium") ?? m.references[0];
    if (r.error) {
      console.log(`| ${m.name} | ${ref.cd.toFixed(3)} (${ref.quality}) | failed | | ${ref.cl.toFixed(3)} | | | | |`);
      total++;
      continue;
    }
    const res = r.result;
    const dcd = (res.cd - ref.cd) / ref.cd;
    const dcl = res.cl - ref.cl;
    const ok = Math.abs(dcd) <= 0.1;
    total++;
    if (ok) inTol++;
    console.log(
      `| ${m.name} | ${ref.cd.toFixed(3)} (${ref.quality}) | ${res.cd.toFixed(3)} | ${(dcd * 100).toFixed(1)} %${ok ? "" : " ✗"} | ${ref.cl.toFixed(3)} | ${res.cl.toFixed(3)} | ${dcl >= 0 ? "+" : ""}${dcl.toFixed(3)} | ${(res.cells / 1e6).toFixed(2)} M | ${Math.round(res.wallSeconds)} s |`,
    );
  }
  console.log(`\nDrag within ±10 %: ${inTol} of ${total}.`);
}
