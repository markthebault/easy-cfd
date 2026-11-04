/**
 * Focused browser adaptation of AeroJAX's D2Q9 equilibrium / BGK / streaming.
 * Copyright (c) 2026 Arno Meijer and EasyCFD contributors.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * See docs/flow2d/README.md for upstream, changes and scope.
 */
import { init, defaultDevice, jit, numpy as np, type Device } from "@jax-js/jax";

import { CX, CY, WEIGHTS, OPPOSITE, INLET, TAU } from "./lattice";
import { forceLinks } from "./boundary";
export { CX, CY, WEIGHTS, INLET, TAU } from "./lattice";

export class BrowserLBM {
  private f: np.Array;
  private solid: np.Array;
  private pull: np.Array;
  private walls: np.Array;
  private edge: np.Array;
  private boundary: np.Array;
  private linkIndices: np.Array;
  private linkX: np.Array;
  private linkY: np.Array;
  private forceSum: np.Array;
  forceSteps = 0;
  steps = 0;

  static async backend(forceWasm = false): Promise<Device> {
    if (!forceWasm) {
      try { if ((await init("webgpu")).includes("webgpu")) { defaultDevice("webgpu"); return "webgpu"; } } catch { /* CPU fallback */ }
    }
    await init("wasm"); defaultDevice("wasm"); return "wasm";
  }

  constructor(readonly nx: number, readonly ny: number, mask: Float32Array, readonly tau = TAU, readonly smagorinsky = 0) {
    const n = nx * ny;
    const indices = new Int32Array(9 * n), wall = new Float32Array(9 * n), edge = new Float32Array(n), eq = new Float32Array(9 * n);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const cell = y * nx + x;
      // Equilibrium inlet/top/moving ground; zero-gradient outlet via pull indices.
      edge[cell] = x === 0 || y === 0 || y === ny - 1 ? 1 : 0;
      for (let i = 0; i < 9; i++) {
        const sx = Math.max(0, Math.min(nx - 2, x - CX[i])), sy = Math.max(0, Math.min(ny - 1, y - CY[i]));
        indices[i * n + cell] = i * n + sy * nx + sx;
        wall[i * n + cell] = mask[sy * nx + sx];
        const cu = CX[i] * INLET;
        eq[i * n + cell] = WEIGHTS[i] * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * INLET * INLET);
      }
    }
    this.f = np.array(eq).reshape([9, n]);
    this.solid = np.array(mask); this.pull = np.array(indices, { dtype: np.int32 }).reshape([9, n]);
    this.walls = np.array(wall).reshape([9, n]); this.edge = np.array(edge);
    this.boundary = np.array(eq).reshape([9, n]);
    const links = forceLinks(nx, ny, mask);
    this.linkIndices = np.array(links.indices, { dtype: np.int32 }); this.linkX = np.array(links.x); this.linkY = np.array(links.y); this.forceSum = np.zeros([2]);
  }

  private step = jit((f: np.Array, solid: np.Array, pull: np.Array, walls: np.Array, edge: np.Array, boundary: np.Array, forceSum: np.Array, linkIndices: np.Array, linkX: np.Array, linkY: np.Array) => {
    const incident = np.take(f.ref.reshape([-1]), linkIndices);
    const force = np.stack([incident.ref.mul(linkX).sum(), incident.mul(linkY).sum()]);
    const reflected = np.take(f.ref, np.array(OPPOSITE, { dtype: np.int32 }), 0);
    const streamed = np.where(np.greater(walls, .5), reflected, np.take(f.reshape([-1]), pull));
    const rho = streamed.ref.sum(0);
    const cx = np.array(CX).reshape([9, 1]), cy = np.array(CY).reshape([9, 1]);
    const ux = streamed.ref.mul(cx.ref).sum(0).div(rho.ref);
    const uy = streamed.ref.mul(cy.ref).sum(0).div(rho.ref);
    const usq = ux.ref.mul(ux.ref).add(uy.ref.mul(uy.ref));
    const cu = cx.mul(ux).add(cy.mul(uy));
    const feq = np.array(WEIGHTS).reshape([9, 1]).mul(this.smagorinsky > 0 ? rho.ref : rho).mul(cu.ref.mul(3).add(1).add(cu.ref.mul(cu).mul(4.5)).sub(usq.mul(1.5)));
    let omega: number | np.Array = 1 / this.tau;
    if (this.smagorinsky > 0) {
      const neq = streamed.ref.sub(feq.ref);
      const xx = neq.ref.mul(np.array(CX.map(x => x * x)).reshape([9, 1])).sum(0);
      const yy = neq.ref.mul(np.array(CY.map(y => y * y)).reshape([9, 1])).sum(0);
      const xy = neq.mul(np.array(CX.map((x, i) => x * CY[i])).reshape([9, 1])).sum(0);
      const norm = np.sqrt(xx.ref.mul(xx).add(yy.ref.mul(yy)).add(xy.ref.mul(xy).mul(2)));
      const tauEff = np.sqrt(norm.mul(18 * Math.SQRT2 * this.smagorinsky ** 2).div(rho).add(this.tau ** 2)).add(this.tau).mul(.5);
      omega = np.divide(1, tauEff);
    }
    const collided = streamed.ref.add(feq.sub(streamed).mul(omega));
    return [np.where(np.greater(np.maximum(solid, edge), .5), boundary, collided), forceSum.add(force)];
  });

  private extract = jit((f: np.Array, solid: np.Array) => {
    const rho = f.ref.sum(0);
    const ux = f.ref.mul(np.array(CX).reshape([9, 1])).sum(0).div(rho.ref).div(INLET);
    const uy = f.mul(np.array(CY).reshape([9, 1])).sum(0).div(rho.ref).div(INLET);
    // cp = (rho - rho0) cs² / (0.5 rho0 U²), dimensionless gauge pressure.
    const cp = rho.sub(1).mul(2 / (3 * INLET * INLET));
    return np.stack([ux.mul(np.subtract(1, solid.ref)), uy.mul(np.subtract(1, solid)), cp]);
  });

  advance(count: number) {
    this.forceSum.dispose(); this.forceSum = np.zeros([2]); this.forceSteps = count;
    for (let i = 0; i < count; i++) [this.f, this.forceSum] = this.step(this.f, this.solid.ref, this.pull.ref, this.walls.ref, this.edge.ref, this.boundary.ref, this.forceSum, this.linkIndices.ref, this.linkX.ref, this.linkY.ref);
    this.steps += count;
  }

  async field() {
    const field = this.extract(this.f.ref, this.solid.ref);
    return new Float32Array(await field.data());
  }
  async forces() { const values = await this.forceSum.ref.data(); return { x: Number(values[0]), y: Number(values[1]), steps: this.forceSteps }; }

  dispose() {
    [this.f, this.solid, this.pull, this.walls, this.edge, this.boundary, this.linkIndices, this.linkX, this.linkY, this.forceSum].forEach(a => a.dispose());
    this.step.dispose(); this.extract.dispose();
  }
}
