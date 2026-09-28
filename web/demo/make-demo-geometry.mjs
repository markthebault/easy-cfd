// Writes the demo geometry used by the groups walkthrough: the built-in sample car as separate
// STL files plus three synthetic rear-wing versions. Run: node demo/make-demo-geometry.mjs
import { createServer } from "vite";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root: resolve(here, ".."), server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
const sample = await server.ssrLoadModule("/src/geometry/sample.ts");
const stl = await server.ssrLoadModule("/src/geometry/stl.ts");
const out = resolve(here, "groups");
const save = (name, positions) => writeFileSync(resolve(out, name), Buffer.from(stl.writeSTL(positions, name)));

const files = { Body: "body.stl", "Front left wheel": "wheel_front_left.stl", "Front right wheel": "wheel_front_right.stl", "Rear left wheel": "wheel_rear_left.stl", "Rear right wheel": "wheel_rear_right.stl" };
for (const p of sample.sampleCar(false)) save(files[p.name], p.positions);

// Wing profiles (x, z) extruded across y = ±0.975 m; nose toward −X, metres.
const rot = (pts, deg, cx, cz) => {
  const a = (deg * Math.PI) / 180;
  return pts.map(([x, z]) => [cx + (x - cx) * Math.cos(a) + (z - cz) * Math.sin(a), cz - (x - cx) * Math.sin(a) + (z - cz) * Math.cos(a)]);
};
const plate = (x0, z0, chord, t) => [[x0, z0], [x0 + 0.01, z0 + t], [x0 + chord, z0 + t * 0.6], [x0 + chord + 0.02, z0]];
save("rear_wing_A_12deg.stl", sample.extrude([[1.48, 1.48], [1.49, 1.52], [1.88, 1.59], [1.9, 1.57]], -0.975, 0.975));
save("rear_wing_B_flat_high.stl", sample.extrude(plate(1.45, 1.66, 0.42, 0.04), -0.975, 0.975));
save("rear_wing_C_20deg_long.stl", sample.extrude(rot(plate(1.38, 1.5, 0.55, 0.045), -20, 1.38, 1.5), -0.975, 0.975));
await server.close();
console.log("wrote", out);
