import { INLET } from "./lattice";
import { cellSize, liveTau, type Grid } from "./grid";

export type ForceSum = { x: number; y: number; steps: number };
export type ForcePoint = { travel: number; cd: number; cl: number };
export type ForceReport = {
  key: string; signature: string; steps: number; referenceLength: number; status: "warming" | "sampling" | "settling" | "ready" | "empty";
  progress: number; cd: number | null; cl: number | null; cdVariation: number; clVariation: number;
  cdDrift: number | null; clDrift: number | null; cdTolerance: number; clTolerance: number;
  sampledSteps: number; windowSteps: number; warmupSteps: number; blockSteps: number; blocks: number;
  stableChecks: number; requiredStableChecks: number; averagingTravel: number; travel: number; history: ForcePoint[];
};
type Sample = { steps: number; cd: number; cl: number };
const MIN_BLOCKS = 10, REQUIRED_CHECKS = 3;
export function forceSampling(grid: Grid, reference: number) {
  const stepDistance = INLET * cellSize(grid);
  return {
    warmupSteps: Math.ceil(Math.max(4 * reference, grid.width) / stepDistance),
    blockSteps: Math.ceil(Math.max(2 * reference, grid.width / 5) / stepDistance),
  };
}
export const forceConditions = (grid: Grid, reference: number, backend: string) => JSON.stringify(["section-mean-2", grid.id, grid.width, grid.height, grid.nx, grid.ny, liveTau(grid), .1, INLET, reference, backend, MIN_BLOCKS, REQUIRED_CHECKS]);

/** Accumulate all post-startup momentum, rather than following individual wake
 * cycles with a short rolling average. Independent-of-playback block boundaries
 * are used for a conservative mean-drift diagnostic, not an accuracy bound or
 * statistical confidence interval. Readiness can be withdrawn as the mean drifts. */
export class ForceMonitor {
  readonly warmupSteps: number;
  readonly blockSteps: number;
  readonly windowSteps: number;
  private count = 0;
  private totals = { cd: 0, cl: 0, cd2: 0, cl2: 0 };
  private partial: Sample = { steps: 0, cd: 0, cl: 0 };
  private blocks: Sample[] = [];
  private completed = 0;
  private stableChecks = 0;
  private drift: { cd: number; cl: number } | null = null;
  private history: ForcePoint[] = [];
  private lastHistoryTravel = -Infinity;
  constructor(private grid: Grid, readonly referenceLength: number, private backend: string, private hasSolids: boolean, private signature = "") {
    const policy = forceSampling(grid, referenceLength);
    this.warmupSteps = policy.warmupSteps; this.blockSteps = policy.blockSteps; this.windowSteps = MIN_BLOCKS * this.blockSteps;
  }
  /** Stop exactly at startup/block boundaries, so changing the playback batch
   * size does not mix startup loads into the mean or alter diagnostic windows. */
  batchSize(maximum: number, steps: number) {
    if (!this.hasSolids) return maximum;
    return Math.max(1, Math.min(maximum, steps < this.warmupSteps ? this.warmupSteps - steps : this.blockSteps - this.partial.steps));
  }
  private tolerance(cd: number, cl: number) { return { cd: Math.max(.015, .03 * Math.abs(cd)), cl: Math.max(.025, .03 * Math.abs(cl)) }; }
  private finishBlock() {
    this.blocks.push({ steps: this.partial.steps, cd: this.partial.cd / this.partial.steps, cl: this.partial.cl / this.partial.steps });
    this.partial = { steps: 0, cd: 0, cl: 0 }; this.completed++;
    // Expand the diagnostic windows as evidence accumulates. A fixed short
    // stationarity window would continue following slow vortex cycles forever.
    if (this.blocks.length > 256) this.blocks.shift();
    if (this.blocks.length < MIN_BLOCKS) return;
    const mean = (items: Sample[], key: "cd" | "cl") => items.reduce((sum, s) => sum + s[key], 0) / items.length;
    const half = Math.floor(this.blocks.length / 2), first = this.blocks.slice(0, half), last = this.blocks.slice(-half), recent = this.blocks.slice(-Math.max(1, Math.floor(this.blocks.length / 4)));
    const cd = this.totals.cd / this.count, cl = this.totals.cl / this.count;
    this.drift = {
      cd: Math.max(Math.abs(mean(first, "cd") - mean(last, "cd")), Math.abs(mean(recent, "cd") - cd)),
      cl: Math.max(Math.abs(mean(first, "cl") - mean(last, "cl")), Math.abs(mean(recent, "cl") - cl)),
    };
    const tolerance = this.tolerance(cd, cl);
    this.stableChecks = this.drift.cd <= tolerance.cd && this.drift.cl <= tolerance.cl ? Math.min(REQUIRED_CHECKS, this.stableChecks + 1) : 0;
  }
  push(force: ForceSum, steps: number): ForceReport {
    if (![force.x, force.y, force.steps, steps].every(Number.isFinite) || force.steps <= 0) throw new Error("Invalid boundary force sample.");
    const travel = steps * INLET * cellSize(this.grid) / this.referenceLength, factor = 2 * cellSize(this.grid) / (INLET ** 2 * this.referenceLength);
    // External callers may not use batchSize: discard any straddling startup
    // batch rather than apportion an unknown transient impulse.
    if (this.hasSolids && steps - force.steps >= this.warmupSteps) {
      const cd = force.x / force.steps * factor, cl = force.y / force.steps * factor;
      let remaining = force.steps;
      while (remaining > 0) {
        const take = Math.min(remaining, this.blockSteps - this.partial.steps);
        this.count += take; this.totals.cd += take * cd; this.totals.cl += take * cl; this.totals.cd2 += take * cd * cd; this.totals.cl2 += take * cl * cl;
        this.partial.steps += take; this.partial.cd += take * cd; this.partial.cl += take * cl; remaining -= take;
        if (this.partial.steps === this.blockSteps) this.finishBlock();
      }
    }
    const cd = this.hasSolids ? this.count ? this.totals.cd / this.count : null : 0, cl = this.hasSolids ? this.count ? this.totals.cl / this.count : null : 0;
    const fluctuation = (key: "cd" | "cl", average: number | null) => average === null || !this.count ? 0 : Math.sqrt(Math.max(0, this.totals[key === "cd" ? "cd2" : "cl2"] / this.count - average * average));
    const tolerance = this.tolerance(cd ?? 0, cl ?? 0);
    const status = !this.hasSolids ? "empty" : !this.count ? "warming" : this.completed < MIN_BLOCKS ? "sampling" : this.stableChecks < REQUIRED_CHECKS ? "settling" : "ready";
    if (cd !== null && cl !== null && this.hasSolids && travel - this.lastHistoryTravel >= .2) { this.history.push({ travel, cd, cl }); this.lastHistoryTravel = travel; if (this.history.length > 180) this.history.shift(); }
    return { key: forceConditions(this.grid, this.referenceLength, this.backend), signature: this.signature, steps, referenceLength: this.referenceLength, status,
      progress: status === "warming" ? Math.min(1, steps / this.warmupSteps) : Math.min(1, this.count / this.windowSteps), cd, cl,
      cdVariation: fluctuation("cd", cd), clVariation: fluctuation("cl", cl), cdDrift: this.drift?.cd ?? null, clDrift: this.drift?.cl ?? null, cdTolerance: tolerance.cd, clTolerance: tolerance.cl,
      sampledSteps: this.count, windowSteps: this.windowSteps, warmupSteps: this.warmupSteps, blockSteps: this.blockSteps, blocks: this.completed, stableChecks: this.stableChecks, requiredStableChecks: REQUIRED_CHECKS,
      averagingTravel: this.count * INLET * cellSize(this.grid) / this.referenceLength, travel, history: [...this.history] };
  }
}
