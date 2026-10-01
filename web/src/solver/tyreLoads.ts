import { G, type AeroBalance, type TyreLoads, type VehicleWeight } from "./types";

export function weightInputError(weight: VehicleWeight): string | undefined {
  const mass = weight.vehicle_mass_kg, front = weight.front_weight_percent;
  if (mass !== undefined && (!Number.isFinite(mass) || mass <= 0 || mass > 10000))
    return "Enter a car mass greater than zero and at most 10,000 kg.";
  if (front !== undefined && (!Number.isFinite(front) || front < 0 || front > 100))
    return "Enter a front weight percentage between 0 and 100.";
}

/** Steady vertical support loads per tyre pair. Negative demand indicates loss of contact. */
export function estimateTyreLoads(balance: AeroBalance | undefined, weight: VehicleWeight): TyreLoads | undefined {
  const mass = weight.vehicle_mass_kg, frontPercent = weight.front_weight_percent;
  if (!balance || mass === undefined || frontPercent === undefined || weightInputError(weight)
    || !Number.isFinite(balance.frontLift) || !Number.isFinite(balance.rearLift)) return;
  const frontStatic = mass * G * frontPercent / 100;
  const rearStatic = mass * G - frontStatic;
  const front = {staticN: frontStatic, aerodynamicN: -balance.frontLift, totalN: frontStatic - balance.frontLift};
  const rear = {staticN: rearStatic, aerodynamicN: -balance.rearLift, totalN: rearStatic - balance.rearLift};
  return {version: "steady-axle-loads-1", massKg: mass, frontWeightPercent: frontPercent, gravity: G,
    front, rear, contactFeasible: front.totalN >= 0 && rear.totalN >= 0};
}
