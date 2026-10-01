import type { AeroBalance, AeroIntegral, Axles, SolverPart, Vec3 } from "./types";

export const LOAD_ZERO_N = 1e-4;
export const add = (a: Vec3, b: Vec3): Vec3 =>
  a.map((v, i) => v + b[i]) as Vec3;
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const momentAt = (position: Vec3, force: Vec3, origin: Vec3): Vec3 =>
  cross(position.map((v, i) => v - origin[i]) as Vec3, force);
export function axleError(
  a: Axles | undefined,
  low?: Vec3,
  high?: Vec3,
): string | undefined {
  if (!a)
    return "Enter or suggest front and rear axle positions, then confirm them.";
  if (![a.frontX, a.rearX, a.centrelineY].every(Number.isFinite))
    return "Axle coordinates must be finite metres.";
  if (a.rearX <= a.frontX)
    return "Front X must be smaller than rear X (the nose points toward −X).";
  if (
    low &&
    high &&
    (a.frontX < low[0] ||
      a.rearX > high[0] ||
      a.centrelineY < low[1] ||
      a.centrelineY > high[1])
  )
    return "Keep both axles and the centreline inside the car's extent.";
  if (!a.confirmed)
    return "Confirm axle positions to calculate equivalent aerodynamic loads.";
}
export const momentOrigin = (a?: Axles): Vec3 =>
  a && !axleError(a) ? [a.frontX, a.centrelineY, 0] : [0, 0, 0];
export function equivalentLoads(
  force: Vec3,
  moment: Vec3,
  a: Axles | undefined,
  qArea: number,
): AeroBalance | undefined {
  if (
    axleError(a) ||
    !(qArea > 0) ||
    ![...force, ...moment].every(Number.isFinite)
  )
    return;
  const wheelbase = a!.rearX - a!.frontX,
    rearLift = -moment[1] / wheelbase,
    frontLift = force[2] - rearLift;
  const result: AeroBalance = {
    frontLift,
    rearLift,
    frontCl: frontLift / qArea,
    rearCl: rearLift / qArea,
    wheelbase,
    pitch: moment[1],
  };
  if (force[2] < -LOAD_ZERO_N && frontLift <= 0 && rearLift <= 0)
    result.frontDownforcePercent = (100 * frontLift) / force[2];
  else
    result.percentageReason =
      Math.abs(force[2]) <= LOAD_ZERO_N
        ? "Total lift is within 0.0001 N of zero; a balance percentage is undefined."
        : "Both axles must push downward to show a downforce percentage.";
  return result;
}
/** Transfer the saved moment to the road below the front axle before resolving loads. */
export function balanceAtAxles(aero: AeroIntegral, axles: Axles | undefined, qArea: number) {
  const origin = momentOrigin(axles);
  const moment = add(aero.moment, momentAt(aero.origin, aero.force, origin));
  return equivalentLoads(aero.force, moment, axles, qArea);
}
/** Require at least two separately marked wheels at each of two clearly separated axles. */
export function suggestAxles(parts: SolverPart[]): Axles | undefined {
  const wheels = parts
    .filter((p) => p.active !== false && p.role === "wheel" && p.wheel)
    .map((p) => p.wheel!);
  if (wheels.length !== 4 || wheels.some(w => !(w.radius > 0) || ![...w.center, w.radius].every(Number.isFinite))) return;
  const sorted = [...wheels].sort((a, b) => a.center[0] - b.center[0]);
  const tolerance = Math.min(...wheels.map((w) => w.radius)) * 0.5;
  const groups: (typeof wheels)[] = [];
  for (const w of sorted) {
    const last = groups.at(-1);
    if (last && Math.abs(w.center[0] - last[0].center[0]) <= tolerance)
      last.push(w);
    else groups.push([w]);
  }
  if (
    groups.length !== 2 ||
    groups.some((g) => g.length !== 2 || Math.abs(g[0].center[1] - g[1].center[1]) <= 2*tolerance) ||
    groups[1][0].center[0] - groups[0][0].center[0] < 4 * tolerance
  )
    return;
  const avgX = (g: typeof wheels) =>
    g.reduce((s, w) => s + w.center[0], 0) / g.length;
  return {
    frontX: avgX(groups[0]),
    rearX: avgX(groups[1]),
    centrelineY: wheels.reduce((s, w) => s + w.center[1], 0) / wheels.length,
    confirmed: false,
  };
}
export function detectedAxles(parts: SolverPart[]): Axles | undefined {
  const suggested = suggestAxles(parts);
  return suggested ? {...suggested, confirmed: true, source: "wheels"} : undefined;
}
export const resolvedAxles = (saved: Axles | undefined, parts: SolverPart[]) =>
  !saved || saved.source === "wheels" ? detectedAxles(parts) : saved;
